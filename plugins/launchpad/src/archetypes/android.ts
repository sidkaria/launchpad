import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { dartDefineArgs, dartDefineEnv } from './flavors.js';
import {
  renderOnBlock, scheduleGuardStep, stepIfLine, stepIfVar,
  ANDROID_DEFAULT_DISTRIBUTE_ON, ANDROID_DEFAULT_RUNNER, flutterSetupStep, type DistributeTrigger,
} from './triggers.js';
import { codegenWorkflowStep } from './mobilevalidate.js';
import { writeGuarded, type WriteResult } from '../generated.js';
import type { Surface, SurfaceFramework } from '../types.js';

export type AndroidFramework = SurfaceFramework;

/**
 * Frameworks detection recognises but `apply` cannot yet build — the exact
 * counterpart to `ios.ts`'s `UNSUPPORTED_FRAMEWORKS`, and for the same reason.
 *
 * Every file this module writes assumes Flutter: the Fastfile's build step is
 * `flutter build apk --release`, and the artifact it uploads to Firebase is
 * `build/app/outputs/flutter-apk/app-release.apk`. Handed a native Gradle app,
 * that workflow is syntactically perfect, runs, and fails on the first line of
 * the build — after the runner has been paid for. A React Native or Expo app
 * fails the same way for its own reasons (a Metro bundle step, `expo prebuild`).
 *
 * iOS has refused this case since it could detect it. Android could not, because
 * it had nothing to refuse ON: there was no framework anywhere in the Android
 * config, so the branch in `apply` wrote the Flutter workflow for anything at
 * all. That is the gap this closes. Building the native Gradle pipeline is a
 * separate piece of work; until it exists, saying so is the honest behaviour.
 */
export const ANDROID_UNSUPPORTED_FRAMEWORKS = ['native', 'react-native', 'expo'] as const;

/**
 * The framework for this surface, defaulting to Flutter.
 *
 * Order matters: a config gathered by the skill wins over detection, because
 * the skill can be told something the filesystem does not show. Both absent
 * means a state file written before the field existed — every one of which
 * describes a Flutter app, since Flutter was the only thing `apply` ever wired.
 */
export function androidFramework(c?: Partial<AndroidConfig>, s?: Pick<Surface, 'framework'>): AndroidFramework {
  return c?.framework ?? s?.framework ?? 'flutter';
}

export function androidIsWireable(framework: string): boolean {
  return !(ANDROID_UNSUPPORTED_FRAMEWORKS as readonly string[]).includes(framework);
}

/**
 * What to tell someone whose Android app launchpad will not wire.
 *
 * Mirrors the iOS refusal deliberately — name what was found, say plainly that
 * the pipeline does not exist yet, and then say what they still get, because
 * most of the value is in the half that does work and a bare "skipped" throws
 * that away. The keystore line is here rather than in the scorecard's voice
 * because this is the moment the reader is thinking about Android releases, and
 * losing the upload keystore is the one mistake on the whole list that cannot
 * be undone.
 */
export function androidRefusal(surfaceId: string, framework: AndroidFramework): string[] {
  const what = framework === 'native'
    ? 'a native Gradle app (no Flutter)'
    : `${framework === 'expo' ? 'an Expo' : 'a React Native'} app`;
  return [
    `  ! ${surfaceId}: this is ${what}, and launchpad's Android pipeline builds with`,
    '      `flutter build apk`. Wiring it would write a workflow that looks right and',
    '      fails on its first build step, so it is refused rather than written.',
    '      You still get, free and today: the readiness scorecard in Android\'s terms,',
    '      the release-signing and upload-keystore guidance (losing that keystore means',
    '      the app can never be updated again), the checklist and the dashboard.',
  ];
}

export interface AndroidConfig {
  appName: string;
  /**
   * What builds this surface. DETECTED, not asked — `detect` records it on the
   * surface and `apply` reads it from there when the gathered config omits it.
   *
   * Unset means `flutter`, which is what every state file written before this
   * field existed describes, and that default is what keeps those files
   * producing byte-identical output. It is not a guess about a new project: a
   * native Gradle app is detected as `native` and refused by `apply`.
   */
  framework?: AndroidFramework;
  workdir: string;        // flutter app dir, repo-relative ('.' or 'apps/mobile')
  testBranch: string;
  firebaseAppId: string;  // Firebase Android app id (1:NNN:android:XXX)
  testerGroup: string;    // Firebase tester group alias
  // Flutter flavour to build (e.g. 'prod'). Declaring productFlavors removes
  // Gradle's default no-flavour build, so a flavoured app MUST name one. Unset
  // → the pre-flavour build/artifact path, unchanged.
  flavor?: string;
  // Dart define name → CI env var holding its value (see dartDefineArgs). Values
  // are fetched from the environment at build time, never baked into the repo.
  dartDefines?: Record<string, string>;

  // ── CI trigger policy (see archetypes/triggers.ts). All optional; leaving every
  // field unset reproduces the original hardcoded workflow byte-for-byte.
  runsOn?: string;                     // runner label; default 'ubuntu-latest'
  distributeOn?: DistributeTrigger[];  // default ['push','dispatch']
  schedule?: string;                   // cron (UTC), required when distributeOn has 'schedule'
  pathFilter?: string[];               // repo-relative globs; adds `paths:` to the push trigger
  validate?: boolean;                  // also emit the cheap analyze/test workflow
  // Command regenerating the app's generated dart sources. Runs in BOTH the
  // validate workflow (before `flutter analyze`) and this distribution workflow
  // (before the build) — a repo that gitignores generated dart cannot compile
  // without it, so validate-only was a real CI failure. `prebuild` is the
  // separate native-Xcode hook.
  codegen?: string;
  // Pin the CI Flutter version. Unset => `channel: stable`, which floats and
  // makes CI non-reproducible against a pinned dev machine.
  flutterVersion?: string;
  // validate-only: extra `flutter test` args (see MobileValidateConfig.testArgs).
  testArgs?: string;
}

/** The surface's trigger policy, with the pre-policy defaults filled in. */
export function androidTriggerPolicy(c: AndroidConfig) {
  return {
    testBranch: c.testBranch,
    distributeOn: c.distributeOn ?? ANDROID_DEFAULT_DISTRIBUTE_ON,
    schedule: c.schedule,
    pathFilter: c.pathFilter,
  };
}

export interface GeneratedFile { path: string; contents: string; }

export const ANDROID_GLOBAL_SECRETS = [
  'FIREBASE_SA_JSON',
  'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD',
];

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'android');
const tmpl = (n: string) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');
const underWorkdir = (workdir: string, rel: string) => (workdir === '.' ? rel : `${workdir}/${rel}`);

// `stepIf` is the schedule guard's gating line (empty unless the workflow runs
// on a schedule) — it must land inside the step, not before it.


// `flutter build apk` runs from the app dir (fastlane runs in android/), so the
// step cd's up one level; the artifact path is likewise relative to android/.
function buildStep(c: AndroidConfig): string {
  const args = ['flutter build apk --release'];
  if (c.flavor) args.push(`--flavor ${c.flavor}`);
  args.push('--build-number=#{build_number}', ...dartDefineArgs(c.dartDefines));
  return `sh("cd .. && ${args.join(' ')}")`;
}

// A flavoured build lands under apk/<flavor>/release/app-<flavor>-release.apk;
// the no-flavour build keeps Flutter's flutter-apk/ path.
function artifactPath(c: AndroidConfig): string {
  return c.flavor
    ? `../build/app/outputs/apk/${c.flavor}/release/app-${c.flavor}-release.apk`
    : '../build/app/outputs/flutter-apk/app-release.apk';
}

export function planAndroidFiles(c: AndroidConfig): GeneratedFile[] {
  const fastfileVars = {
    BUILD_STEP: buildStep(c),
    FIREBASE_APP_ID: c.firebaseAppId,
    TESTER_GROUP: c.testerGroup,
    ARTIFACT_PATH: artifactPath(c),
  };
  const policy = androidTriggerPolicy(c);
  const wfVars = {
    APP_NAME: c.appName, WORKDIR: c.workdir,
    RUNS_ON: c.runsOn ?? ANDROID_DEFAULT_RUNNER,
    ON_TRIGGERS: renderOnBlock(policy),
    SCHEDULE_GUARD: scheduleGuardStep(policy, c.workdir),
    STEP_IF: stepIfVar(policy.distributeOn),
    FLUTTER_SETUP: flutterSetupStep(c.flutterVersion, stepIfLine(policy.distributeOn)),
    CODEGEN_STEP: codegenWorkflowStep(c.codegen, c.workdir, stepIfLine(policy.distributeOn)),
    DART_DEFINE_ENV: dartDefineEnv(c.dartDefines),
  };
  return [
    { path: underWorkdir(c.workdir, 'android/fastlane/Fastfile'), contents: render(tmpl('Fastfile'), fastfileVars) },
    { path: underWorkdir(c.workdir, 'android/fastlane/Pluginfile'), contents: tmpl('Pluginfile') },
    { path: underWorkdir(c.workdir, 'android/Gemfile'), contents: tmpl('Gemfile') },
    { path: `.github/workflows/launchpad-${c.appName}-android.yml`, contents: render(tmpl('release.yml'), wfVars) },
  ];
}

/**
 * Write the Android pipeline files. An existing non-launchpad
 * `android/fastlane/Fastfile` is PRESERVED, never overwritten — see `writeGuarded`.
 */
export function writeAndroidFiles(repo: string, c: AndroidConfig): WriteResult {
  return writeGuarded(repo, planAndroidFiles(c));
}
