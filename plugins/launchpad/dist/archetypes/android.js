import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { dartDefineArgs, dartDefineEnv } from './flavors.js';
import { renderOnBlock, scheduleGuardStep, stepIfLine, stepIfVar, ANDROID_DEFAULT_DISTRIBUTE_ON, ANDROID_DEFAULT_RUNNER, flutterSetupStep, } from './triggers.js';
import { codegenWorkflowStep } from './mobilevalidate.js';
import { isGradleFramework, planGradleAndroidFiles, resolveGradleConfig } from './androidgradle.js';
import { writeGuarded } from '../generated.js';
/**
 * Frameworks detection recognises and `apply` cannot build — the counterpart to
 * `ios.ts`'s `UNSUPPORTED_FRAMEWORKS`.
 *
 * **Empty, and that is the point.** It held `native`, `react-native` and `expo`
 * because every file this module writes assumes Flutter: the Fastfile's build
 * step is `flutter build apk --release` and the artifact it uploads is
 * `build/app/outputs/flutter-apk/app-release.apk`. Handed a native Gradle app
 * that workflow was syntactically perfect, ran, and died on the first line of
 * the build — after the runner had been paid for — so refusing was the honest
 * behaviour while nothing else existed.
 *
 * Something else exists now: `androidgradle.ts` builds all three with
 * `./gradlew`. The list stays rather than being deleted because it is the seam
 * the refusal hangs on, and the next framework detection learns to name will
 * need it again before its pipeline is written.
 */
export const ANDROID_UNSUPPORTED_FRAMEWORKS = [];
/**
 * The framework for this surface, defaulting to Flutter.
 *
 * Order matters: a config gathered by the skill wins over detection, because
 * the skill can be told something the filesystem does not show. Both absent
 * means a state file written before the field existed — every one of which
 * describes a Flutter app, since Flutter was the only thing `apply` ever wired.
 */
export function androidFramework(c, s) {
    return c?.framework ?? s?.framework ?? 'flutter';
}
export function androidIsWireable(framework) {
    return !ANDROID_UNSUPPORTED_FRAMEWORKS.includes(framework);
}
/**
 * What to tell someone whose Android app launchpad will not wire.
 *
 * Nothing reaches this today — `ANDROID_UNSUPPORTED_FRAMEWORKS` is empty — and
 * it is kept beside the gate rather than deleted with it, because the refusal
 * and the list that triggers it are one mechanism. Deleting the words is how
 * the NEXT framework detection learns to name gets a Flutter workflow written
 * for it instead of a sentence.
 *
 * Mirrors the iOS refusal deliberately: name what was found, say plainly that
 * the pipeline does not exist, then say what they still get, because most of
 * the value is in the half that does work and a bare "skipped" throws it away.
 */
export function androidRefusal(surfaceId, framework) {
    const what = framework === 'native'
        ? 'a native Gradle app (no Flutter)'
        : framework === 'expo' ? 'an Expo app'
            : framework === 'react-native' ? 'a React Native app'
                : `a ${framework} app`;
    return [
        `  ! ${surfaceId}: this is ${what}, and launchpad has no Android pipeline that`,
        '      builds it. Wiring it would write a workflow that looks right and fails on',
        '      its first build step, so it is refused rather than written.',
        '      You still get, free and today: the readiness scorecard in Android\'s terms,',
        '      the release-signing and upload-keystore guidance (losing that keystore means',
        '      the app can never be updated again), the checklist and the dashboard.',
    ];
}
/** The surface's trigger policy, with the pre-policy defaults filled in. */
export function androidTriggerPolicy(c) {
    return {
        testBranch: c.testBranch,
        distributeOn: c.distributeOn ?? ANDROID_DEFAULT_DISTRIBUTE_ON,
        schedule: c.schedule,
        pathFilter: c.pathFilter,
    };
}
export const ANDROID_GLOBAL_SECRETS = [
    'FIREBASE_SA_JSON',
    'ANDROID_KEYSTORE_BASE64', 'ANDROID_KEYSTORE_PASSWORD', 'ANDROID_KEY_ALIAS', 'ANDROID_KEY_PASSWORD',
];
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'android');
const tmpl = (n) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');
const underWorkdir = (workdir, rel) => (workdir === '.' ? rel : `${workdir}/${rel}`);
// `stepIf` is the schedule guard's gating line (empty unless the workflow runs
// on a schedule) — it must land inside the step, not before it.
// `flutter build apk` runs from the app dir (fastlane runs in android/), so the
// step cd's up one level; the artifact path is likewise relative to android/.
function buildStep(c) {
    const args = ['flutter build apk --release'];
    if (c.flavor)
        args.push(`--flavor ${c.flavor}`);
    args.push('--build-number=#{build_number}', ...dartDefineArgs(c.dartDefines));
    return `sh("cd .. && ${args.join(' ')}")`;
}
// A flavoured build lands under apk/<flavor>/release/app-<flavor>-release.apk;
// the no-flavour build keeps Flutter's flutter-apk/ path.
function artifactPath(c) {
    return c.flavor
        ? `../build/app/outputs/apk/${c.flavor}/release/app-${c.flavor}-release.apk`
        : '../build/app/outputs/flutter-apk/app-release.apk';
}
/**
 * The Android pipeline files for one surface.
 *
 * Two pipelines live behind this name because two build systems do. Flutter
 * keeps the fastlane lane it has always had, byte for byte; everything else
 * goes to `androidgradle.ts` and gets `./gradlew`. The split is on `framework`
 * rather than on anything about the directory layout, because a Flutter
 * `android/` directory and a bare React Native `android/` directory look
 * identical from outside and only one of them can be built with `flutter`.
 */
export function planAndroidFiles(c) {
    if (isGradleFramework(androidFramework(c)))
        return planGradleAndroidFiles(c);
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
 *
 * The Gradle path resolves two fields off the repository first (the app module
 * and, for JS projects, the package manager). Those are answers ABOUT the repo
 * rather than decisions about the pipeline, so nobody is asked for them; doing
 * it here rather than in `planAndroidFiles` keeps the planner pure and keeps
 * every test able to state its own inputs.
 */
export function writeAndroidFiles(repo, c) {
    return writeGuarded(repo, planAndroidFiles(resolveAndroidConfig(repo, c)));
}
/** The config `apply` actually writes from — see `writeAndroidFiles`. */
export function resolveAndroidConfig(repo, c) {
    return isGradleFramework(androidFramework(c)) ? resolveGradleConfig(repo, c) : c;
}
