import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import {
  renderOnBlock, scheduleGuardStep, stepIfLine, stepIfVar, pathGlob, repoRelDir,
  ANDROID_DEFAULT_DISTRIBUTE_ON, ANDROID_DEFAULT_RUNNER,
} from './triggers.js';
import { androidAppModule } from '../gradle.js';
import type { AndroidConfig, GeneratedFile } from './android.js';
import type { SurfaceFramework } from '../types.js';

/**
 * The Android pipeline for everything that is not Flutter: a native Kotlin/Java
 * Gradle app, and the `android/` half of a React Native or Expo repo.
 *
 * It exists because the Flutter one could not be stretched. `flutter build apk`
 * and `./gradlew :app:assembleRelease` are not two spellings of one thing —
 * they need a different toolchain on the runner, produce artifacts at different
 * paths, and fail in different places. Handing a Gradle app the Flutter
 * workflow produced valid YAML that ran and died on its first build step, which
 * is why `apply` refused it rather than writing it.
 *
 * Every choice below follows the documented Android standard rather than an
 * invention, because DECISIONS says so and because a pipeline nobody else runs
 * is a pipeline nobody else has debugged:
 *
 *   JDK          `actions/setup-java@v6`, Temurin. Every AGP 8.x and 9.x
 *                requires JDK 17 as a minimum — what moves between AGP versions
 *                is the minimum *Gradle*, not the JDK — so 17 is the floor and
 *                the default, and `javaVersion` raises it.
 *   Gradle       `gradle/actions/setup-gradle@v6`, which supersedes the
 *                archived `gradle/gradle-build-action`. Caching is on by
 *                default and cache writes are restricted to the default branch
 *                by the action itself. Wrapper-checksum validation has been
 *                folded in since v4, so there is no separate
 *                `wrapper-validation` step and adding one would be redundant.
 *   Artifacts    BOTH. `bundleRelease` produces the AAB every new Play app is
 *                required to publish; `assembleRelease` produces the APK, which
 *                is the ONLY artifact Firebase App Distribution can take from
 *                an app that is not yet published in Play (an AAB requires the
 *                Firebase app to be linked to a live Play listing). A
 *                pre-launch app sending builds to testers is exactly the case
 *                where the AAB cannot be used, so shipping only the AAB would
 *                have been a pipeline that works for nobody who needs it.
 *   Distribution the Firebase CLI, `appdistribution:distribute`, authenticated
 *                by a service account through `GOOGLE_APPLICATION_CREDENTIALS`.
 *                See `FIREBASE_TOOLS_VERSION` below for why not fastlane and
 *                why not a third-party action.
 */

/** The frameworks this module builds. Flutter goes through `android.ts`. */
export const GRADLE_FRAMEWORKS: readonly SurfaceFramework[] = ['native', 'react-native', 'expo'];

export const isGradleFramework = (f: string): boolean =>
  (GRADLE_FRAMEWORKS as readonly string[]).includes(f);

/**
 * The JDK floor. Not a taste: AGP 8.0 through the current 9.x all state JDK 17
 * as their minimum, and a runner defaulting to whatever `ubuntu-latest` ships
 * is the floating-toolchain failure PLAYBOOK §4 describes, one language over.
 */
export const DEFAULT_JAVA_VERSION = '17';

/**
 * Node for a React Native or Expo runner.
 *
 * react-native.dev's setup page says "Node 22.11.0 or newer" and the published
 * `react-native` package's own `engines.node` says `^22.13.0 || ^24.3.0 ||
 * >= 26.0.0`. They disagree, and the package metadata is the one that actually
 * refuses to install, so the pin follows it. There is no `.nvmrc` in the React
 * Native template to read, so this has to be a decision rather than a lookup.
 */
export const DEFAULT_NODE_VERSION = '22.13.0';

/**
 * The cheap gate. Named tasks, never `check` or `build`.
 *
 * Android's own lint documentation states that lint "isn't automatically run as
 * part of your build" and recommends running it explicitly in CI, and Google's
 * flagship sample app enumerates its CI tasks one by one rather than leaning on
 * a lifecycle task. A gate that silently covers less than its name suggests is
 * worse than no gate, because it is believed.
 *
 * Note this is the BLOCKING half only. Lint runs as well, and separately — see
 * `validateSteps` for the finding that split them.
 */
export const DEFAULT_VALIDATE_TASKS = 'testDebugUnitTest';

/** The advisory half. Same reasoning, opposite consequence when it fails. */
export const DEFAULT_LINT_TASK = 'lint';

/**
 * The pinned Firebase CLI, and the reasoning behind choosing it at all.
 *
 * There is **no Google-maintained GitHub Action** for App Distribution; the
 * widely-used `wzieba/Firebase-Distribution-Github-Action` is a community
 * action whose own README marks its token auth as deprecated by the Firebase
 * team. Firebase's own CI/CD guidance names three supported routes — fastlane,
 * the Gradle plugin, and the CLI — all authenticated by a service account
 * holding the **Firebase App Distribution Admin** role.
 *
 * Of those three the CLI is the one that costs the buyer nothing. The Gradle
 * plugin means editing their build file to add a third-party plugin. fastlane
 * means Ruby, bundler and the plugin-discovery trap in PLAYBOOK §4 — where the
 * build succeeds and then dies with "Could not find action, lane or variable"
 * *after* paying for the whole build — on a pipeline that otherwise needs no
 * Ruby at all. The CLI needs Node, which every runner already has.
 *
 * Pinned, because `npx firebase-tools` without a version floats, and a floating
 * toolchain drifting away from a working pipeline is the same failure as
 * `channel: stable` on Flutter.
 */
export const FIREBASE_TOOLS_VERSION = '13.29.1';

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'androidgradle');
const tmpl = (n: string) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');

/** Slugify an app name so "My App" never yields a path or artifact with a space. */
export const androidSlug = (appName: string): string =>
  appName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Where the Gradle build lives, repo-relative, '.' for the repository root.
 *
 * Defaults by framework rather than being asked for, because the answer is
 * structural: a native Gradle app's build IS the workdir, and React Native and
 * Expo both put theirs in `android/` beneath the JS project. An explicit
 * `gradleDir` wins, for the repo that is shaped like neither.
 */
export function gradleDir(c: Pick<AndroidConfig, 'gradleDir' | 'workdir' | 'framework'>): string {
  if (c.gradleDir !== undefined) return repoRelDir(c.gradleDir) || '.';
  const base = repoRelDir(c.workdir ?? '.');
  if (c.framework === 'native') return base || '.';
  return base ? `${base}/android` : 'android';
}

/** `.` renders as an empty prefix so a path stays repo-root-relative. */
export const gradleDirPrefix = (dir: string): string => (dir === '.' ? '' : `${dir}/`);

/**
 * The Gradle path of the application module, as `:app`, or '' when the root
 * project is itself the app.
 *
 * `appModule` is DETECTED, not asked — `gradle.ts` already has to resolve it
 * (through the version catalog, which is where the modern default layout hides
 * the plugin id) in order to detect the surface at all.
 */
export function moduleTaskPrefix(appModule: string | undefined): string {
  const m = (appModule ?? 'app').replace(/^:+|:+$/g, '').trim();
  return m ? `:${m}:` : '';
}

/** Where that module's build outputs land, relative to the Gradle root. */
export function moduleOutDir(appModule: string | undefined): string {
  const m = (appModule ?? 'app').replace(/^:+|:+$/g, '').replace(/:/g, '/').trim();
  return m ? `${m}/build/outputs` : 'build/outputs';
}

/**
 * Where the decoded keystore is written, relative to the Gradle root.
 *
 * It goes in the app module because the injected `signingConfigs` block
 * resolves `storeFile` with `file(...)`, which is module-relative — the same
 * contract the Flutter pipeline has always had, one directory over.
 */
export function keystoreDest(appModule: string | undefined): string {
  const m = (appModule ?? 'app').replace(/^:+|:+$/g, '').replace(/:/g, '/').trim();
  return m ? `${m}/upload-keystore.jks` : 'upload-keystore.jks';
}

/** The release tasks: the AAB Play wants and the APK testers can install. */
export function gradleReleaseTasks(c: Pick<AndroidConfig, 'appModule'>): string {
  const p = moduleTaskPrefix(c.appModule);
  return `${p}assembleRelease ${p}bundleRelease`;
}

/** The validate tasks, module-scoped so a multi-module repo gates the app. */
export function gradleValidateTasks(c: Pick<AndroidConfig, 'appModule' | 'validateTasks'>): string {
  const explicit = c.validateTasks?.trim();
  if (explicit) return explicit;
  const p = moduleTaskPrefix(c.appModule);
  return DEFAULT_VALIDATE_TASKS.split(' ').map(t => `${p}${t}`).join(' ');
}

/**
 * The validate lane's steps: a blocking gate and an advisory lint run.
 *
 * They are two steps because of a real run. The first version of this lane ran
 * `lint testDebugUnitTest` as one gate against Google's own `sunflower`, and
 * the very first push went red: the unit tests passed, and `lintDebug` failed
 * on **four pre-existing errors and a hundred and ten warnings** that had
 * nothing to do with anything launchpad or the buyer had just done — the first
 * was a string missing its Bangla translation.
 *
 * That is the worst possible first impression, and it is not a sunflower
 * problem: every repository adopted mid-life has a lint backlog, which is
 * exactly why Android ships `lint-baseline.xml`. A gate that is red on day one
 * for reasons the buyer did not cause is a gate that gets switched off in week
 * two, and then the unit tests go with it.
 *
 * So: the tests block, because a failing test is about the change in front of
 * you. Lint runs and reports — `continue-on-error`, so its findings appear as
 * an annotation and the run stays green — because Android's own documentation
 * says to run lint in CI and it is right, but "run it" and "fail on a backlog
 * somebody else created" are different instructions.
 *
 * Setting `validateTasks` replaces BOTH with exactly what it says, blocking.
 * PLAYBOOK §4: match the project's own gate. A project that has already dealt
 * with its lint backlog says so here and gets the stricter lane it has earned.
 */
export function validateSteps(c: AndroidConfig): string {
  const dir = gradleDir(c);
  const explicit = c.validateTasks?.trim();
  const gate = [
    '      # The tasks are named explicitly rather than leaning on `check` or',
    '      # `build`: a lifecycle task quietly covering less than you think is a',
    '      # gate that passes while the thing it was supposed to catch ships.',
    `      - name: ${explicit ? 'Project gate' : 'Unit tests'}`,
    `        working-directory: ${dir}`,
    `        run: ./gradlew ${gradleValidateTasks(c)}`,
  ];
  if (explicit) return gate.join('\n');
  return [
    ...gate,
    '',
    '      # Advisory on purpose. Android recommends running lint in CI, and it is',
    '      # right — but almost every repository adopted mid-life has a lint',
    '      # backlog, and a gate that is red on day one for somebody else\'s',
    '      # hundred warnings is a gate that gets switched off. The findings show',
    '      # up as an annotation; the run stays green. Once you have cleared them',
    '      # (or added a lint-baseline.xml), set `validateTasks` on this surface',
    '      # to make lint blocking.',
    '      - name: Lint (advisory)',
    '        continue-on-error: true',
    `        working-directory: ${dir}`,
    `        run: ./gradlew ${moduleTaskPrefix(c.appModule)}${DEFAULT_LINT_TASK}`,
  ].join('\n');
}

/**
 * The package manager, from the lockfile.
 *
 * There is no authoritative spec for this — react-native.dev does not address
 * it and `actions/setup-node` refuses to guess, taking the manager as an input.
 * The de-facto rule, which Expo's own package-manager module also follows, is
 * the `packageManager` field first and the lockfile second. Two lockfiles is
 * ambiguous rather than a tie to break, so it resolves to npm and `apply` says
 * which it chose, instead of silently installing with the wrong one.
 */
export function detectPackageManager(dir: string): 'npm' | 'yarn' | 'pnpm' {
  const pkgPath = join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const declared = /"packageManager"\s*:\s*"(npm|yarn|pnpm)@/.exec(readFileSync(pkgPath, 'utf8'));
      if (declared) return declared[1] as 'npm' | 'yarn' | 'pnpm';
    } catch { /* unreadable package.json — fall through to the lockfiles */ }
  }
  const locks: [string, 'npm' | 'yarn' | 'pnpm'][] = [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
    ['package-lock.json', 'npm'],
  ];
  const found = locks.filter(([f]) => existsSync(join(dir, f)));
  return found.length === 1 ? found[0][1] : 'npm';
}

/** The install command for a manager, in its reproducible, lockfile-respecting form. */
export function installCommand(pm: 'npm' | 'yarn' | 'pnpm'): string {
  return {
    npm: 'npm ci',
    // Yarn Berry has no `--frozen-lockfile`; `--immutable` is its spelling, and
    // Yarn Classic accepts it as a no-op alias rather than erroring.
    yarn: 'yarn install --immutable',
    pnpm: 'pnpm install --frozen-lockfile',
  }[pm];
}

/**
 * Node setup and the JS install, for React Native and Expo. Empty for a native
 * Gradle app, which has no JavaScript in its build at all.
 *
 * NOTE there is deliberately no Metro/`react-native bundle` step. The React
 * Native Gradle plugin bundles the JavaScript into the release build itself —
 * the docs describe `bundleRelease` as bundling "all the JavaScript needed to
 * run your app" — so an explicit bundle step would either duplicate that work
 * or, worse, produce a second bundle the build then ignores.
 *
 * Ends with a blank line when present, so the native case collapses to nothing.
 */
export function nodeSetupSteps(c: AndroidConfig, stepIf: string): string {
  if (c.framework !== 'react-native' && c.framework !== 'expo') return '';
  const pm = c.packageManager ?? 'npm';
  const jsDir = repoRelDir(c.workdir ?? '.') || '.';
  const lockGlob = { npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' }[pm];
  const lines = [
    '      - uses: actions/setup-node@v4',
    ...(stepIf ? [stepIf] : []),
    '        with:',
    `          node-version: '${c.nodeVersion ?? DEFAULT_NODE_VERSION}'`,
    `          cache: ${pm}`,
    `          cache-dependency-path: ${jsDir === '.' ? lockGlob : `${jsDir}/${lockGlob}`}`,
    '',
  ];
  if (pm === 'pnpm') {
    lines.push(
      // setup-node can cache pnpm's store but cannot install pnpm itself, and
      // its cache step fails outright if pnpm is not already on PATH.
      '      - uses: pnpm/action-setup@v4',
      ...(stepIf ? [stepIf] : []),
      '        with:',
      '          run_install: false',
      '',
    );
  }
  lines.push(
    '      - name: Install JavaScript dependencies',
    ...(stepIf ? [stepIf] : []),
    `        working-directory: ${jsDir}`,
    `        run: ${installCommand(pm)}`,
    '',
    '',
  );
  return lines.join('\n');
}

/**
 * `npx expo prebuild`, for an Expo app only.
 *
 * `--clean` is not optional here and the reason is Expo's own: re-running
 * prebuild without it "layers changes on top of the existing files … but may
 * not produce the same results in some cases", because "some config plugins
 * aren't idempotent". On a CI runner the checkout is fresh and there are no
 * native directories to layer onto, so `--clean` costs nothing and removes the
 * one documented source of non-determinism in the whole approach.
 *
 * `--no-install` because the dependencies were installed by the step above with
 * the project's own package manager; letting prebuild install them again would
 * run a second, possibly different, resolution.
 */
export function prebuildStep(c: AndroidConfig, stepIf: string): string {
  if (c.framework !== 'expo') return '';
  const jsDir = repoRelDir(c.workdir ?? '.') || '.';
  return [
    '      # Continuous Native Generation: an Expo app has no android/ directory',
    '      # in the repository, so CI generates one from app.json and the config',
    '      # plugins before Gradle can build anything. --clean is what makes that',
    '      # generation deterministic; Expo documents an incremental prebuild as',
    '      # able to "layer changes" and not necessarily produce the same result.',
    '      - name: Generate the native Android project (expo prebuild)',
    ...(stepIf ? [stepIf] : []),
    `        working-directory: ${jsDir}`,
    '        run: npx expo prebuild --platform android --clean --no-install',
    '',
    '',
  ].join('\n');
}

/** The trigger policy, with the pre-policy defaults filled in. */
const policyOf = (c: AndroidConfig) => ({
  testBranch: c.testBranch,
  distributeOn: c.distributeOn ?? ANDROID_DEFAULT_DISTRIBUTE_ON,
  schedule: c.schedule,
  pathFilter: c.pathFilter,
});

export const gradleWorkflowPath = (c: AndroidConfig): string =>
  `.github/workflows/launchpad-${androidSlug(c.appName)}-android.yml`;

export const gradleValidateWorkflowPath = (c: AndroidConfig): string =>
  `.github/workflows/launchpad-${androidSlug(c.appName)}-android-validate.yml`;

/** Everything under the app dir — the default scope for the validate lane. */
const defaultValidatePaths = (workdir: string): string[] => [pathGlob(workdir) || '**'];

export function planGradleAndroidFiles(c: AndroidConfig): GeneratedFile[] {
  const dir = gradleDir(c);
  const policy = policyOf(c);
  const stepIf = stepIfLine(policy.distributeOn);
  const files: GeneratedFile[] = [{
    path: gradleWorkflowPath(c),
    contents: render(tmpl('release.yml'), {
      APP_NAME: c.appName,
      RUNS_ON: c.runsOn ?? ANDROID_DEFAULT_RUNNER,
      ON_TRIGGERS: renderOnBlock(policy),
      /**
       * The guard diffs the APP directory, never the Gradle one.
       *
       * They are the same thing for a native Android app and very different
       * for the other two, in opposite ways that are both wrong. An Expo
       * project's `android/` is generated by prebuild and gitignored, so it
       * has no commits at all and a scheduled build would diff an empty
       * history and skip every single night — PLAYBOOK §4's worst case, a
       * pipeline that never fires and is indistinguishable from one correctly
       * deciding there was nothing to do. A bare React Native project commits
       * `android/`, but its changes live in the JavaScript above it, so the
       * guard would skip the nights that matter and fire on the ones that
       * don't.
       */
      SCHEDULE_GUARD: scheduleGuardStep(policy, repoRelDir(c.workdir ?? '.') || '.'),
      STEP_IF: stepIfVar(policy.distributeOn),
      NODE_STEPS: nodeSetupSteps(c, stepIf),
      PREBUILD_STEP: prebuildStep(c, stepIf),
      JAVA_VERSION: c.javaVersion ?? DEFAULT_JAVA_VERSION,
      GRADLE_DIR: dir,
      GRADLE_DIR_PREFIX: gradleDirPrefix(dir),
      GRADLE_TASKS: gradleReleaseTasks(c),
      OUT_DIR: moduleOutDir(c.appModule),
      KEYSTORE_DEST: keystoreDest(c.appModule),
      ARTIFACT_SLUG: androidSlug(c.appName),
      FIREBASE_APP_ID: c.firebaseAppId,
      TESTER_GROUP: c.testerGroup,
      FIREBASE_TOOLS_VERSION,
    }),
  }];
  if (c.validate) {
    files.push({
      path: gradleValidateWorkflowPath(c),
      contents: render(tmpl('validate.yml'), {
        APP_NAME: c.appName,
        ON_TRIGGERS: renderOnBlock({
          testBranch: c.testBranch,
          distributeOn: ['push', 'dispatch'],
          pathFilter: c.pathFilter?.length ? c.pathFilter : defaultValidatePaths(c.workdir),
        }),
        // The validate lane never runs on a schedule, so no step is ever gated.
        NODE_STEPS: nodeSetupSteps(c, ''),
        PREBUILD_STEP: prebuildStep(c, ''),
        JAVA_VERSION: c.javaVersion ?? DEFAULT_JAVA_VERSION,
        VALIDATE_STEPS: validateSteps(c),
      }),
    });
  }
  return files;
}

/**
 * Fill in the two fields that are answers about the repository rather than
 * decisions about the pipeline, so neither the skill nor the user has to supply
 * them — and so a config that omits them still produces the same bytes on every
 * run, which is what the fixed point depends on.
 */
export function resolveGradleConfig(repo: string, c: AndroidConfig): AndroidConfig {
  const dir = gradleDir(c);
  const abs = dir === '.' ? repo : join(repo, dir);
  const jsDir = repoRelDir(c.workdir ?? '.') || '.';
  return {
    ...c,
    gradleDir: dir,
    appModule: c.appModule ?? androidAppModule(abs) ?? 'app',
    ...(c.framework === 'react-native' || c.framework === 'expo'
      ? { packageManager: c.packageManager ?? detectPackageManager(jsDir === '.' ? repo : join(repo, jsDir)) }
      : {}),
  };
}
