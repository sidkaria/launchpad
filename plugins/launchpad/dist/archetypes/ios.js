import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { dartDefineArgs, dartDefineEnv } from './flavors.js';
import { renderOnBlock, scheduleGuardStep, stepIfLine, stepIfVar, IOS_DEFAULT_DISTRIBUTE_ON, IOS_DEFAULT_RUNNER, flutterSetupStep, } from './triggers.js';
import { codegenWorkflowStep } from './mobilevalidate.js';
import { DEFAULT_NODE_VERSION, detectPackageManager } from './androidgradle.js';
import { writeGuarded } from '../generated.js';
/** The surface's trigger policy, with the pre-policy defaults filled in. */
export function iosTriggerPolicy(c) {
    return {
        testBranch: c.testBranch,
        tagPrefix: c.tagPrefix,
        distributeOn: c.distributeOn ?? IOS_DEFAULT_DISTRIBUTE_ON,
        schedule: c.schedule,
        pathFilter: c.pathFilter,
    };
}
// The App Store Connect API key — the only secrets a cloud-signed iOS surface
// needs (upload + cloud signing). Every iOS surface needs these three.
/**
 * Frameworks detection recognises and `apply` cannot build.
 *
 * **Empty, and that is the point.** It held `react-native` and `expo` because
 * emitting the plain `native` pipeline for either would have been worse than
 * refusing: bare React Native needs a CocoaPods install, and Expo needs
 * `expo prebuild` before an `ios/` directory exists at all. The workflow would
 * have looked correct, run, and failed — after paying for a macOS runner.
 *
 * Both now have those steps (`jsSetupSteps`, `iosPrebuildStep`), so both build.
 * The list stays rather than being deleted because it is the seam the refusal
 * hangs on, and the next framework detection learns to name will need it again
 * before its pipeline is written.
 */
export const UNSUPPORTED_FRAMEWORKS = [];
export function isWireable(framework) {
    return !UNSUPPORTED_FRAMEWORKS.includes(framework);
}
export const IOS_CLOUD_SECRETS = ['ASC_KEY_P8', 'ASC_KEY_ID', 'ASC_ISSUER_ID'];
// Extra secrets a match-signed surface needs on top of the ASC key, on the
// default 'deploy-key' certs auth. MATCH_KEYCHAIN_PASSWORD guards the dedicated
// CI keychain match imports the .p12 into (see keychainStep) — required in both
// certsAuth modes, since it is a keychain concern, not a git-auth one.
export const IOS_MATCH_SECRETS = ['MATCH_PASSWORD', 'MATCH_KEYCHAIN_PASSWORD', 'MATCH_DEPLOY_KEY'];
// The same set for a surface that opted back into `certsAuth: 'basic'`.
export const IOS_MATCH_BASIC_SECRETS = [
    'MATCH_PASSWORD', 'MATCH_KEYCHAIN_PASSWORD', 'MATCH_GIT_BASIC_AUTHORIZATION',
];
// Full set (back-compat): a match-based setup on the defaults needs all six.
export const IOS_GLOBAL_SECRETS = [...IOS_CLOUD_SECRETS, ...IOS_MATCH_SECRETS];
/**
 * Resolve the signing mode. The default is `cloud` — Xcode automatic signing
 * driven by the App Store Connect API key (-allowProvisioningUpdates), so a
 * native app ships through CI with only the ASC key (which every iOS app needs
 * anyway): no certs repo, no per-app match step. A native target can opt into
 * `match` (a shared Apple Distribution cert in a private certs repo) for
 * deterministic certs. Flutter always uses match: `flutter build ipa` exports
 * through a named provisioning profile baked into ios/ExportOptions.plist,
 * which match creates.
 */
export function signingMode(c) {
    if (c.framework === 'flutter')
        return 'match';
    return c.signing ?? 'cloud';
}
/** How CI authenticates to the certs repo. Only meaningful in match mode. */
export function certsAuthMode(c) {
    return c.certsAuth ?? 'deploy-key';
}
/** The repo secrets this surface requires, given its signing mode. */
export function iosSecrets(c) {
    if (signingMode(c) !== 'match')
        return [...IOS_CLOUD_SECRETS];
    return certsAuthMode(c) === 'basic'
        ? [...IOS_CLOUD_SECRETS, ...IOS_MATCH_BASIC_SECRETS]
        : [...IOS_GLOBAL_SECRETS];
}
/**
 * The certs repo in scp-style SSH form, which is what a read-only deploy key
 * requires: `https://github.com/owner/repo.git` → `git@github.com:owner/repo.git`.
 *
 * Already-SSH input (scp-style or an explicit `ssh://` URL) passes through
 * untouched, so the conversion is idempotent. A missing `.git` and a trailing
 * slash are normalised. Anything that is not an http(s) URL is returned as-is
 * rather than mangled — a local path certs repo stays a local path.
 */
export function matchGitSshUrl(httpsUrl) {
    const u = httpsUrl.trim();
    if (/^ssh:\/\//i.test(u) || /^[^/\s]+@[^/\s]+:/.test(u))
        return u;
    const m = /^https?:\/\/(?:[^@/]*@)?([^/]+)\/(.+)$/i.exec(u);
    if (!m)
        return u;
    const path = m[2].replace(/\/+$/, '');
    return `git@${m[1]}:${path.endsWith('.git') ? path : `${path}.git`}`;
}
/** The certs repo's git host — what `ssh-keyscan` must pin. */
function matchGitHost(url) {
    const ssh = matchGitSshUrl(url);
    return /^[^/\s]+@([^/\s:]+):/.exec(ssh)?.[1]
        ?? /^ssh:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(ssh)?.[1]
        ?? 'github.com';
}
/**
 * Workflow filename stem — mirrors the macOS convention (scheme-based, space
 * free) so `launchpad-<Scheme>-ios.yml` sits alongside `launchpad-<Scheme>-macos.yml`.
 * Flutter has no scheme, so fall back to the app name; slugify either way so an
 * app name with spaces (e.g. "My App Receiver") never yields a bad path.
 */
export function iosWorkflowSlug(c) {
    const base = c.scheme && c.scheme.trim() ? c.scheme : c.appName;
    return base.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
export function iosWorkflowPath(c) {
    return `.github/workflows/launchpad-${iosWorkflowSlug(c)}-ios.yml`;
}
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'ios');
const tmpl = (n) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');
const underWorkdir = (workdir, rel) => (workdir === '.' ? rel : `${workdir}/${rel}`);
// Fastlane helper that feeds the ASC API key to xcodebuild so -allowProvisioningUpdates
// can create/download the distribution cert + profile in the cloud (Xcode 13+).
function cloudHelper() {
    return [
        'def cloud_signing_xcargs',
        '  [',
        '    "-allowProvisioningUpdates",',
        '    "-authenticationKeyPath", ENV.fetch("ASC_KEY_PATH"),',
        '    "-authenticationKeyID", ENV.fetch("ASC_KEY_ID"),',
        '    "-authenticationKeyIssuerID", ENV.fetch("ASC_ISSUER_ID"),',
        '  ].join(" ")',
        'end',
    ].join('\n');
}
// Flutter's `sh("flutter build ipa")` doesn't record the IPA path in fastlane's
// lane context, so the upload lanes glob for it. (Native uses build_app, which
// sets SharedValues::IPA_OUTPUT_PATH — see ipaArg.)
function newestIpaHelper(c) {
    const g = ipaGlob(c);
    return [
        'def newest_ipa',
        `  Dir.glob(File.expand_path("../${g}", __dir__)).max_by { |f| File.mtime(f) } \\`,
        `    || UI.user_error!("no .ipa found under ${g}")`,
        'end',
    ].join('\n');
}
// Top-of-file helper defs, only those the chosen framework/signing mode uses.
function helpers(c) {
    const defs = [];
    if (c.framework === 'flutter')
        defs.push(newestIpaHelper(c));
    if (signingMode(c) === 'cloud')
        defs.push(cloudHelper());
    return defs.length ? '\n' + defs.join('\n\n') + '\n' : '';
}
// The upload lanes' `ipa:` argument. Native omits it so upload_to_* reads
// build_app's SharedValues::IPA_OUTPUT_PATH (the exact archive gym produced),
// rather than a fragile pwd-relative glob. Flutter passes the globbed path.
function ipaArg(c) {
    return c.framework === 'flutter' ? '      ipa: newest_ipa,\n' : '';
}
function signingLaneBody(c) {
    if (signingMode(c) === 'match') {
        return [
            `    match(type: "appstore", app_identifier: "${c.bundleId}", readonly: true, api_key: asc_key)`,
            '',
            '    # A freshly-imported private key has no partition list, so codesign cannot',
            '    # use it without a UI prompt — in a headless/service session that surfaces as',
            '    # `errSecInternalComponent` ("Failed to codesign … Flutter.framework"). Grant',
            '    # apple-tool/apple/codesign access explicitly. No-op when there is no',
            '    # dedicated keychain (MATCH_KEYCHAIN_NAME unset).',
            '    if ENV["MATCH_KEYCHAIN_NAME"].to_s != ""',
            '      sh(\'security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$MATCH_KEYCHAIN_PASSWORD" "$MATCH_KEYCHAIN_NAME" >/dev/null 2>&1 || true\')',
            '    end',
        ].join('\n');
    }
    return [
        '    # Cloud signing — Xcode manages the distribution cert + provisioning',
        '    # profile via the App Store Connect API key (-allowProvisioningUpdates).',
        '    # No shared certs repo (match) required.',
        '    UI.message("Using Xcode automatic (cloud) signing via App Store Connect API key")',
    ].join('\n');
}
/**
 * Point the Xcode project at the match-provisioned Distribution identity for the
 * configuration we archive.
 *
 * A stock Flutter project ships `CODE_SIGN_STYLE = Automatic` and
 * `CODE_SIGN_IDENTITY[sdk=iphoneos*] = "iPhone Developer"`, so Xcode ignores
 * match and picks an **Apple Development** cert out of the LOGIN keychain. On a
 * launchd-service runner that keychain is unreachable and the archive dies with
 * `errSecInternalComponent` while codesigning Flutter.framework — even though
 * match imported a perfectly good Apple Distribution cert into its own keychain.
 */
function codeSigningSettings(c) {
    if (signingMode(c) !== 'match' || c.framework !== 'flutter')
        return '';
    const releaseConfig = c.flavor ? `Release-${c.flavor}` : 'Release';
    return [
        '    update_code_signing_settings(',
        '      use_automatic_signing: false,',
        "      path: File.expand_path('../ios/Runner.xcodeproj', __dir__),",
        `      team_id: "${c.teamId}",`,
        '      code_sign_identity: "Apple Distribution",',
        `      profile_name: ENV.fetch("sigh_${c.bundleId}_appstore_profile-name", nil),`,
        '      targets: ["Runner"],',
        `      build_configurations: ["${releaseConfig}"]`,
        '    )',
        '',
    ].join('\n');
}
function buildStep(c) {
    if (c.framework === 'flutter') {
        // fastlane runs under its own ruby and exports GEM_HOME/GEM_PATH/RUBYOPT/etc.
        // into children. `flutter build ipa` shells out to `pod`, which then resolves
        // against fastlane's ruby instead of its own and dies with "CocoaPods is
        // installed but broken … the version of Ruby that CocoaPods was installed with
        // is different from the one being used to invoke it". Stripping the ruby vars
        // for THIS child only (fastlane itself is unaffected) lets pod use its own.
        const args = ['env -u GEM_HOME -u GEM_PATH -u RUBYOPT -u RUBYLIB -u BUNDLE_GEMFILE -u BUNDLE_BIN_PATH -u BUNDLE_PATH LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 flutter build ipa --release'];
        if (c.flavor)
            args.push(`--flavor ${c.flavor}`);
        args.push('--build-number=#{build_number}', 
        // ABSOLUTE, anchored at the Fastfile's own directory. A real run failed with
        // `"ios/ExportOptions.plist" property list does not exist` even though the file
        // was present: `flutter build ipa` resolves this path from a different cwd than
        // fastlane's `sh` runs in, so a relative path is ambiguous.
        `--export-options-plist #{File.expand_path('../ios/ExportOptions.plist', __dir__)}`, ...dartDefineArgs(c.dartDefines));
        return [
            'build_number = `git rev-list --count HEAD`.strip',
            codeSigningSettings(c).replace(/^/gm, '').trimEnd(),
            `    sh("${args.join(' ')}")`,
        ].filter(Boolean).join('\n');
    }
    // React Native and Expo archive the CocoaPods workspace rather than a bare
    // project. Naming it is not a nicety: `pod install` writes the Pods project
    // beside the app's, and archiving the `.xcodeproj` alone compiles without
    // every dependency CocoaPods just installed.
    const workspaceLine = isJsFramework(c.framework)
        ? [`      workspace: "${c.workspace ?? `${c.scheme}.xcworkspace`}",`]
        : [];
    if (signingMode(c) === 'cloud') {
        // Only `xcargs` — gym applies it to both the archive and the export step, so
        // passing export_xcargs too would land -authenticationKeyPath on
        // `xcodebuild -exportArchive` twice ("may only be provided once").
        return [
            'build_app(',
            ...workspaceLine,
            `      scheme: "${c.scheme}",`,
            '      export_method: "app-store",',
            `      output_name: "${c.appName}.ipa",`,
            '      output_directory: "build",',
            '      xcargs: cloud_signing_xcargs,',
            `      export_options: { signingStyle: "automatic", teamID: "${c.teamId}" }`,
            '    )',
        ].join('\n');
    }
    // native + match: manual signing via the match-provisioned profile (same
    // "match AppStore <bundle>" profile the Flutter ExportOptions.plist uses).
    return [
        'build_app(',
        ...workspaceLine,
        `      scheme: "${c.scheme}",`,
        '      export_method: "app-store",',
        `      output_name: "${c.appName}.ipa",`,
        '      output_directory: "build",',
        `      export_options: { signingStyle: "manual", provisioningProfiles: { "${c.bundleId}" => "match AppStore ${c.bundleId}" } }`,
        '    )',
    ].join('\n');
}
/** React Native and Expo: the two frameworks whose iOS build starts in node_modules. */
export const isJsFramework = (f) => f === 'react-native' || f === 'expo';
/**
 * Where fastlane runs, repo-relative.
 *
 * `<workdir>/ios` for React Native and Expo, because that is where their Xcode
 * workspace lives and where their own template puts `fastlane/` — the layout
 * every RN doc, and every RN repo that already has lanes, assumes. `workdir`
 * itself for Flutter and native, unchanged.
 */
export const iosFastlaneDir = (c) => (isJsFramework(c.framework) ? (c.workdir === '.' ? 'ios' : `${c.workdir}/ios`) : c.workdir);
/**
 * Node, the JS install, and CocoaPods — the steps a React Native or Expo build
 * needs before Xcode can do anything, and nothing at all for the other two.
 *
 * There is deliberately NO `react-native bundle` step. The Release scheme runs
 * Xcode's own "Bundle React Native code and images" build phase, which is what
 * produces the JS bundle inside the archive; a separate bundle step would
 * either duplicate that work or leave a second bundle the build ignores.
 *
 * `bundle exec pod install` rather than `pod install` is React Native's own
 * documented form, and it is run from `ios/` so bundler finds the Gemfile
 * whether the template put it at the project root (current) or in `ios/`
 * (older, and what several real repos still have). No Gemfile anywhere falls
 * back to a bare `pod install` instead of failing on `bundle install`.
 */
export function jsSetupSteps(c, stepIf) {
    if (!isJsFramework(c.framework))
        return '';
    const pm = c.packageManager ?? 'npm';
    const jsDir = c.workdir === '.' || !c.workdir ? '.' : c.workdir;
    const lock = { npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' }[pm];
    const install = { npm: 'npm ci', yarn: 'yarn install --immutable', pnpm: 'pnpm install --frozen-lockfile' }[pm];
    const lines = [
        '      - uses: actions/setup-node@v4',
        ...(stepIf ? [stepIf] : []),
        '        with:',
        `          node-version: '${c.nodeVersion ?? DEFAULT_NODE_VERSION}'`,
        `          cache: ${pm}`,
        `          cache-dependency-path: ${jsDir === '.' ? lock : `${jsDir}/${lock}`}`,
        '',
    ];
    if (pm === 'pnpm') {
        lines.push('      - uses: pnpm/action-setup@v4', ...(stepIf ? [stepIf] : []), '        with:', '          run_install: false', '');
    }
    lines.push('      - name: Install JavaScript dependencies', ...(stepIf ? [stepIf] : []), `        working-directory: ${jsDir}`, `        run: ${install}`, '');
    if (c.framework === 'expo') {
        lines.push('      # Continuous Native Generation: an Expo app has no ios/ directory in', '      # the repository, so CI generates one from app.json and the config', '      # plugins. --clean is what makes that deterministic — Expo documents an', '      # incremental prebuild as able to "layer changes" and not necessarily', '      # produce the same result.', '      - name: Generate the native iOS project (expo prebuild)', ...(stepIf ? [stepIf] : []), `        working-directory: ${jsDir}`, '        run: npx expo prebuild --platform ios --clean --no-install', '');
    }
    lines.push('      - name: Install CocoaPods dependencies', ...(stepIf ? [stepIf] : []), `        working-directory: ${iosFastlaneDir(c)}`, '        run: |', '          if [ -f Gemfile ] || [ -f ../Gemfile ]; then', '            bundle install', '            bundle exec pod install', '          else', '            pod install', '          fi', '', '');
    return lines.join('\n');
}
function ipaGlob(c) {
    return c.framework === 'flutter' ? 'build/ios/ipa/*.ipa' : 'build/*.ipa';
}
// `stepIf` is the schedule guard's gating line (empty unless the workflow runs
// on a schedule) — it must land inside the step, not before it.
// Regenerate a gitignored xcodeproj (e.g. `xcodegen generate`) on the runner
// before the build, in the same workdir gym builds from. Empty → no step.
// macos runners don't ship xcodegen, so a prebuild that uses it gets a
// self-installing guard prepended (unless the command already installs it).
function prebuildStep(c, stepIf) {
    const cmd = c.prebuild?.trim();
    if (!cmd)
        return '';
    const needsXcodegen = /\bxcodegen\b/.test(cmd) && !/brew install xcodegen/.test(cmd);
    const runLines = needsXcodegen
        ? ['which xcodegen >/dev/null 2>&1 || brew install xcodegen', cmd]
        : [cmd];
    const run = runLines.length === 1
        ? `        run: ${runLines[0]}`
        : ['        run: |', ...runLines.map(l => `          ${l}`)].join('\n');
    return [
        '      - name: Generate Xcode project',
        ...(stepIf ? [stepIf] : []),
        `        working-directory: ${c.workdir}`,
        run,
    ].join('\n');
}
// The dedicated CI keychain (path + the shell var both the create and delete
// steps derive it from). Mirrors the macOS Developer-ID pipeline, which already
// signs out of a throwaway $RUNNER_TEMP keychain.
const KEYCHAIN_PATH_EXPR = 'KC="$RUNNER_TEMP/launchpad-signing.keychain-db"';
const SSH_KEY_PATH = '$RUNNER_TEMP/.ssh/match_key';
const SSH_KNOWN_HOSTS = '$RUNNER_TEMP/.ssh/known_hosts';
/**
 * Create + unlock a throwaway keychain and put it at the head of the user search
 * list, so `match` imports the signing .p12 there instead of the login keychain.
 * A launchd-managed self-hosted runner cannot touch the login keychain at all
 * (`failed to get: -25308` — errSecInteractionNotAllowed), so this is what makes
 * match work off a GitHub-hosted runner.
 */
function keychainStep(stepIf) {
    return [
        '      # A launchd-managed self-hosted runner cannot read the login keychain',
        '      # (-25308 errSecInteractionNotAllowed), and match imports there by default.',
        '      # Sign out of a throwaway keychain instead — same approach as the macOS lane.',
        '      - name: Create signing keychain',
        ...(stepIf ? [stepIf] : []),
        '        env:',
        '          KEYCHAIN_PASSWORD: ${{ secrets.MATCH_KEYCHAIN_PASSWORD }}',
        '        run: |',
        `          ${KEYCHAIN_PATH_EXPR}`,
        '          security create-keychain -p "$KEYCHAIN_PASSWORD" "$KC"',
        '          security set-keychain-settings -lut 21600 "$KC"',
        '          security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KC"',
        `          security list-keychains -d user -s "$KC" $(security list-keychains -d user | tr -d '"')`,
        '          echo "MATCH_KEYCHAIN_NAME=$KC" >> "$GITHUB_ENV"',
    ].join('\n');
}
/**
 * Delete the keychain however the job ended, so a long-lived self-hosted runner
 * does not accumulate one per build. `if: always()` is deliberately the ONLY
 * gate: a step cannot carry both it and the schedule guard's condition, and
 * cleanup must still run when the guard skipped the build.
 */
function keychainCleanupStep() {
    return [
        '      - name: Delete signing keychain',
        '        if: always()',
        '        run: |',
        `          ${KEYCHAIN_PATH_EXPR}`,
        '          security delete-keychain "$KC" || true',
    ].join('\n');
}
/**
 * Install the read-only deploy key for the certs repo. Replaces
 * MATCH_GIT_BASIC_AUTHORIZATION (a broad PAT, resolved through the keychain-backed
 * git credential helper — unavailable to a launchd service) with an SSH key
 * scoped to that one repository.
 */
function certsDeployKeyStep(c, stepIf) {
    return [
        '      # A deploy key is scoped to the certs repo alone, and unlike the keychain-',
        '      # backed HTTPS credential it is readable by a launchd-managed runner.',
        '      - name: Authorize certs repo (read-only deploy key)',
        ...(stepIf ? [stepIf] : []),
        '        env:',
        '          MATCH_DEPLOY_KEY: ${{ secrets.MATCH_DEPLOY_KEY }}',
        '        run: |',
        '          mkdir -p "$RUNNER_TEMP/.ssh"',
        `          printf '%s\\n' "$MATCH_DEPLOY_KEY" > "${SSH_KEY_PATH}"`,
        `          chmod 600 "${SSH_KEY_PATH}"`,
        `          ssh-keyscan -t ed25519,rsa ${matchGitHost(c.matchGitUrl ?? '')} > "${SSH_KNOWN_HOSTS}" 2>/dev/null`,
    ].join('\n');
}
/**
 * The match-only steps that run before the build. Substituted at the start of
 * the line holding the build step, so the cloud case renders to nothing at all
 * and the workflow stays byte-for-byte what it was.
 */
function signingSetupSteps(c, stepIf) {
    if (signingMode(c) !== 'match')
        return '';
    const steps = [keychainStep(stepIf)];
    if (certsAuthMode(c) === 'deploy-key')
        steps.push(certsDeployKeyStep(c, stepIf));
    return steps.join('\n\n') + '\n\n';
}
/** The trailing cleanup step; leads with a blank line, empty in cloud mode. */
function signingCleanupStep(c) {
    return signingMode(c) === 'match' ? '\n\n' + keychainCleanupStep() : '';
}
// The match-only env block for the workflow's build step; empty in cloud mode.
// Leads with a newline so the cloud case collapses cleanly (no blank YAML line).
// MATCH_KEYCHAIN_NAME/MATCH_KEYCHAIN_PASSWORD and GIT_SSH_COMMAND are read by
// match and git themselves — they are deliberately NOT fastlane action params.
function matchEnv(c) {
    if (signingMode(c) !== 'match')
        return '';
    const deployKey = certsAuthMode(c) === 'deploy-key';
    const url = deployKey ? matchGitSshUrl(c.matchGitUrl ?? '') : c.matchGitUrl;
    return '\n' + [
        '          MATCH_PASSWORD: ${{ secrets.MATCH_PASSWORD }}',
        `          MATCH_GIT_URL: ${url}`,
        ...(deployKey
            ? [
                `          GIT_SSH_COMMAND: ssh -i ${SSH_KEY_PATH} -o IdentitiesOnly=yes -o UserKnownHostsFile=${SSH_KNOWN_HOSTS}`,
            ]
            : ['          MATCH_GIT_BASIC_AUTHORIZATION: ${{ secrets.MATCH_GIT_BASIC_AUTHORIZATION }}']),
        '          MATCH_KEYCHAIN_NAME: ${{ env.MATCH_KEYCHAIN_NAME }}',
        '          MATCH_KEYCHAIN_PASSWORD: ${{ secrets.MATCH_KEYCHAIN_PASSWORD }}',
    ].join('\n');
}
export function planIosFiles(c) {
    if (signingMode(c) === 'match' && !c.matchGitUrl) {
        throw new Error('planIosFiles: match signing requires matchGitUrl (the shared certs repo)');
    }
    const fastfileVars = {
        HELPERS: helpers(c),
        SIGNING_LANE_BODY: signingLaneBody(c),
        BUILD_STEP: buildStep(c),
        IPA_ARG: ipaArg(c),
    };
    const policy = iosTriggerPolicy(c);
    const stepIf = stepIfLine(policy.distributeOn);
    const wfVars = {
        APP_NAME: c.appName, WORKDIR: iosFastlaneDir(c),
        JS_SETUP_STEPS: jsSetupSteps(c, stepIf),
        RUNS_ON: c.runsOn ?? IOS_DEFAULT_RUNNER,
        ON_TRIGGERS: renderOnBlock(policy),
        SCHEDULE_GUARD: scheduleGuardStep(policy, c.workdir),
        STEP_IF: stepIfVar(policy.distributeOn),
        FLUTTER_SETUP: c.framework === 'flutter' ? flutterSetupStep(c.flutterVersion, stepIf) : '', PREBUILD_STEP: prebuildStep(c, stepIf),
        SIGNING_SETUP_STEPS: signingSetupSteps(c, stepIf),
        SIGNING_CLEANUP_STEP: signingCleanupStep(c),
        MATCH_ENV: matchEnv(c),
        // Flutter-only: native builds via build_app have no --dart-define, so they
        // must not carry the env lines either (mirrors buildStep ignoring them).
        CODEGEN_STEP: codegenWorkflowStep(c.codegen, c.workdir, stepIfLine(policy.distributeOn)),
        DART_DEFINE_ENV: c.framework === 'flutter' ? dartDefineEnv(c.dartDefines) : '',
    };
    const files = [
        { path: underWorkdir(iosFastlaneDir(c), 'fastlane/Fastfile'), contents: render(tmpl('Fastfile'), fastfileVars) },
        { path: iosWorkflowPath(c), contents: render(tmpl('release.yml'), wfVars) },
    ];
    if (c.framework === 'flutter') {
        files.push({
            path: underWorkdir(c.workdir, 'ios/ExportOptions.plist'),
            contents: render(tmpl('ExportOptions.plist'), { TEAM_ID: c.teamId, BUNDLE_ID: c.bundleId }),
        });
    }
    return files;
}
/**
 * Write the iOS pipeline files. An existing non-launchpad `fastlane/Fastfile`
 * (an adopted lane a local deploy script may already call) is PRESERVED, never
 * overwritten — see `writeGuarded`.
 */
export function writeIosFiles(repo, c) {
    return writeGuarded(repo, planIosFiles(resolveIosConfig(repo, c)));
}
/**
 * Fill in the one field that is an answer about the repository rather than a
 * decision about the pipeline. Nobody is asked which package manager they use;
 * the lockfile already says.
 */
export function resolveIosConfig(repo, c) {
    if (!isJsFramework(c.framework))
        return c;
    const jsDir = c.workdir === '.' || !c.workdir ? repo : join(repo, c.workdir);
    return { ...c, packageManager: c.packageManager ?? detectPackageManager(jsDir) };
}
