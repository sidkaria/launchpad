import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { detectAssets, hasStoreSurface, ICON_REQUIREMENT } from './assets.js';
import { androidFramework } from './archetypes/android.js';
import { appBuildFile, releaseSigning } from './archetypes/androidsigning.js';
import { readConfirmations } from './confirmations.js';
import { detectEcosystem, installPhrase, article } from './ecosystem.js';
import { hasReleaseTag } from './git.js';
const has = (repo, rel) => existsSync(join(repo, rel));
const read = (repo, rel) => {
    try {
        return readFileSync(join(repo, rel), 'utf8');
    }
    catch {
        return '';
    }
};
const ls = (repo, rel) => {
    try {
        return readdirSync(join(repo, rel));
    }
    catch {
        return [];
    }
};
const archetypes = (st) => new Set(st.surfaces.map(s => s.archetype));
/**
 * Where each surface actually delivers, in that surface's own words.
 *
 * The single source for every sentence that would otherwise reach for the
 * generic list "TestFlight, Firebase, DMG, or deployed site" — which is right
 * for a Flutter app and wrong for all four of the other archetypes. A row that
 * names a channel the project does not have is the cheapest possible way to
 * make every other row on the page look like guesswork.
 */
const DELIVERS_TO = {
    'ios': 'TestFlight or the App Store',
    'android': 'Firebase App Distribution or Play',
    'macos-dmg': 'a signed DMG anybody can download',
    'web-app': 'a deployed, reachable URL',
    'static-site': 'a published site',
};
/** "TestFlight or the App Store, and a deployed, reachable URL". */
function deliveryPhrase(kinds) {
    const order = ['ios', 'android', 'macos-dmg', 'web-app', 'static-site'];
    const parts = order.filter(a => kinds.has(a)).map(a => DELIVERS_TO[a]);
    if (parts.length <= 1)
        return parts[0] ?? 'anywhere a stranger could reach it';
    return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}
const configOf = (st, a) => st.surfaces.find(s => s.archetype === a && s.config)?.config;
/**
 * The Android app module's build file, whatever the project is built with.
 *
 * This used to look only where Flutter puts one — `android/app/build.gradle`,
 * optionally under a workdir — which meant the `android-signing` row graded a
 * NATIVE Android app against a file that does not exist there, read '', and
 * reported the gap correctly by accident. The accident stopped being harmless
 * the moment `apply` began wiring those apps: having wired real release
 * signing into `app/build.gradle.kts`, the scorecard went on reporting the app
 * as debug-signed, which is the false-GAP twin of the false pass — it tells the
 * buyer the product's own work did not happen.
 *
 * `appBuildFile` is the same resolver `apply` writes through, so the row and
 * the wiring cannot disagree about which file is the app's. The Flutter
 * spellings stay as a fallback for a state file with no framework recorded.
 */
function androidBuildFile(repo, st) {
    const surface = st.surfaces.find(s => s.archetype === 'android');
    const cfg = {
        ...(configOf(st, 'android') ?? {}),
        framework: androidFramework(configOf(st, 'android'), surface),
    };
    const resolved = appBuildFile(repo, cfg);
    if (resolved)
        return { text: read(repo, resolved), path: resolved };
    const workdir = cfg.workdir ?? '.';
    const under = workdir === '.' ? '' : `${workdir}/`;
    for (const rel of [
        `${under}android/app/build.gradle.kts`, `${under}android/app/build.gradle`,
        'android/app/build.gradle.kts', 'android/app/build.gradle',
    ]) {
        const text = read(repo, rel);
        if (text)
            return { text, path: rel };
    }
    return { text: '' };
}
const anyOf = (repo, files) => files.some(f => has(repo, f));
/**
 * Packages whose whole job is talking to a server. A dependency is evidence
 * the release build will try; the absence of one is not evidence it will not
 * (`dart:io`'s HttpClient needs no package), which is why that case is
 * `unknown` rather than a pass.
 */
const FLUTTER_NETWORK_DEP = /^(http|dio|grpc|chopper|retrofit|ferry|socket_io_client|cached_network_image|supabase|supabase_flutter|firebase_core|appwrite|pocketbase|web_socket_channel)$|graphql|websocket|^http_|_http$/;
const INTERNET_LINE = '<uses-permission android:name="android.permission.INTERNET" />';
/**
 * A Flutter release build that cannot reach the network.
 *
 * Flutter's template declares `INTERNET` in `src/debug` and `src/profile`
 * only, so everything works in development and a release APK then fails every
 * request with "Failed host lookup … errno = 7" — which reads like a wrong
 * server URL, and was chased as one in a shipped app before anybody looked at
 * the manifest (docs/HARVEST.md).
 *
 * Reported, never fixed: DECISIONS 2026-09-22 — the manifest is the user's
 * file, and not every app should ask for the network. One row for all the
 * Android surfaces: `n/a` for one that is not Flutter (native, React Native
 * and Expo templates put the permission in `src/main` themselves), the worst
 * grade among the Flutter ones otherwise.
 */
function flutterNetworkPermission(repo, st) {
    const base = { id: 'flutter-network-permission', title: 'The Flutter release build can reach the network' };
    const results = [];
    for (const s of st.surfaces.filter(x => x.archetype === 'android')) {
        const cfg = s.config;
        if (androidFramework(cfg, s) !== 'flutter')
            continue;
        // The app dir: the configured one, else where detection found it, else the root.
        const dirs = [...new Set([cfg?.workdir, s.target, '.'].filter((d) => typeof d === 'string' && !!d))];
        const under = (d, rel) => (d === '.' ? rel : `${d}/${rel}`);
        const dir = dirs.find(d => has(repo, under(d, 'pubspec.yaml')));
        const manifestRel = dir && under(dir, 'android/app/src/main/AndroidManifest.xml');
        const manifest = manifestRel ? read(repo, manifestRel) : '';
        if (!manifestRel || !manifest) {
            results.push({
                grade: 'unknown',
                detail: 'launchpad could not find this Flutter app\'s `android/app/src/main/AndroidManifest.xml`, so it '
                    + 'cannot tell whether the RELEASE build may use the network. Flutter\'s template grants it only to '
                    + 'debug and profile builds; a release that talks to a server without it fails every request with '
                    + '"Failed host lookup", which looks like a wrong URL.',
            });
            continue;
        }
        const uncommented = manifest.replace(/<!--[\s\S]*?-->/g, '');
        if (/<uses-permission\b[^>]*android\.permission\.INTERNET\b/.test(uncommented)) {
            results.push({ grade: 'ok', detail: '' });
            continue;
        }
        let deps = [];
        try {
            const doc = parseYaml(read(repo, under(dir, 'pubspec.yaml')));
            deps = Object.keys(doc?.dependencies ?? {});
        }
        catch { /* unparseable pubspec: no evidence either way */ }
        const net = deps.filter(d => FLUTTER_NETWORK_DEP.test(d));
        const fix = `Add \`${INTERNET_LINE}\` to \`${manifestRel}\`, inside \`<manifest>\` and above \`<application>\`.`;
        results.push(net.length
            ? {
                grade: 'gap',
                detail: `\`${manifestRel}\` does not ask for the network, and this app depends on `
                    + `${net.slice(0, 3).map(d => `\`${d}\``).join(', ')}${net.length > 3 ? ` and ${net.length - 3} more` : ''}. `
                    + 'Flutter grants it only to debug and profile builds, so everything works while you develop and the '
                    + 'RELEASE build fails every request with "Failed host lookup … errno = 7" — which reads like a wrong '
                    + `server URL, not a missing line. ${fix}`,
            }
            : {
                grade: 'unknown',
                detail: `\`${manifestRel}\` does not ask for the network, and nothing in \`pubspec.yaml\` says this app `
                    + 'uses it — but plain `dart:io` needs no package, so launchpad cannot tell. If the release build talks '
                    + `to any server it will fail with "Failed host lookup", which reads like a wrong URL. ${fix} If the `
                    + 'app is genuinely offline, that is the right manifest as it stands.',
            });
    }
    const worst = results.find(r => r.grade === 'gap') ?? results.find(r => r.grade === 'unknown') ?? results[0];
    return { ...base, ...(worst ?? { grade: 'n/a', detail: '' }) };
}
const SKIP_DIRS = new Set([
    'node_modules', '.git', 'build', 'dist', '.next', '.dart_tool', 'Pods',
    'DerivedData', 'vendor', '.venv', 'target', '.gradle', 'coverage',
    // A worktree holds a whole second copy of the repo: slow to walk, and every
    // match inside it duplicates one already found in the real tree.
    '.claude', '.worktrees',
]);
/**
 * Bounded search for a file OR directory whose name matches. Depth-limited
 * rather than root-only: in a monorepo the privacy page is at
 * `apps/web/src/app/privacy/page.tsx`, and a root-only check reports a
 * missing policy for a project that has one — the worst kind of false alarm,
 * because it sends the user off to write something that already exists.
 */
function findDoc(repo, pattern, maxDepth = 6) {
    const walk = (rel, depth) => {
        if (depth > maxDepth)
            return false;
        for (const name of ls(repo, rel)) {
            if (SKIP_DIRS.has(name) || name.startsWith('.'))
                continue;
            if (pattern.test(name))
                return true;
            const child = rel ? join(rel, name) : name;
            // `ls` returns [] for a file, so this doubles as the is-directory test.
            if (ls(repo, child).length && walk(child, depth + 1))
                return true;
        }
        return false;
    };
    return walk('', 0);
}
/**
 * Bounded content search: read files whose NAME matches, test their contents.
 *
 * A capability check must see what the repo actually does, not only what
 * launchpad configured. A real Mac app had adopted a working Sparkle updater
 * and a working paywall before launchpad ever saw it, and a config-only check
 * called both of them missing — telling someone with a live paywall that they
 * have no paywall, which destroys trust in every other row at the same time.
 */
function grepRepo(repo, fileName, content, maxDepth = 5, hidden = false) {
    const walk = (rel, depth) => {
        if (depth > maxDepth)
            return false;
        for (const name of ls(repo, rel)) {
            if (SKIP_DIRS.has(name))
                continue;
            const child = rel ? join(rel, name) : name;
            const isDir = ls(repo, child).length > 0;
            if (isDir) {
                // .xcodeproj is a directory whose contents we do want to read. So, when
                // asked, are `.github/` and `.launchpad/` — a build step that lives in
                // a dot-directory is still a build step, and skipping those was why a
                // real `notarytool` call in `.launchpad/macos/create-dmg.sh` read as
                // "this app is not notarized".
                if (name.startsWith('.') && !name.endsWith('.xcodeproj') && !hidden)
                    continue;
                if (walk(child, depth + 1))
                    return true;
            }
            else if (fileName.test(name) && content.test(read(repo, child))) {
                return true;
            }
        }
        return false;
    };
    return walk('', 0);
}
function grade(ok, detail, critical = false) {
    return { grade: ok ? 'ok' : 'gap', detail: ok ? '' : detail, ...(critical ? { critical: true } : {}) };
}
/**
 * Three grades where there used to be two.
 *
 * The bar this whole file is held to is that **a false pass is worse than a
 * false gap**, because a user who is told something is handled never goes and
 * handles it. A filename or a config value is not an observed outcome, so when
 * that is all the evidence there is, the honest grade is `unknown` — which says
 * "go and look" instead of quietly signing it off.
 */
function graded(evidence, detail, unknownDetail, critical = false) {
    return {
        grade: evidence,
        detail: evidence === 'ok' ? '' : evidence === 'unknown' ? unknownDetail : detail,
        ...(critical && evidence !== 'ok' ? { critical: true } : {}),
    };
}
/** Every CI definition in the repo, with its contents — the workflow names alone prove nothing. */
function ciFiles(repo) {
    const out = [];
    for (const name of ls(repo, '.github/workflows')) {
        if (/\.ya?ml$/.test(name))
            out.push({ name, text: read(repo, join('.github/workflows', name)) });
    }
    // Not everyone is on GitHub. A repo with perfectly good GitLab CI being told
    // "nothing builds this except you" is the product looking ignorant.
    for (const p of ['.gitlab-ci.yml', '.circleci/config.yml', 'Jenkinsfile', 'azure-pipelines.yml',
        '.travis.yml', 'bitbucket-pipelines.yml', '.drone.yml', 'wercker.yml']) {
        if (has(repo, p))
            out.push({ name: p, text: read(repo, p) });
    }
    return out;
}
/** A CI definition that runs on its own, rather than only when someone asks. */
const runsAutomatically = (name, text) => {
    // A Jenkinsfile is Groovy, not YAML, and a multibranch pipeline builds every
    // push without saying so anywhere in the file.
    if (name === 'Jenkinsfile')
        return /\bpipeline\b|\bnode\s*[({]/.test(text);
    if (/(^|\n)\s*(on|trigger|triggers)\b/.test(text)) {
        return /\b(push|pull_request|pull_requests|merge_request|schedule|cron)\b/.test(text);
    }
    // GitLab/Circle/Travis run on every push without declaring a trigger at all.
    return /(^|\n)\s*(stages|jobs|workflows|script|steps|pipelines)\s*:/.test(text);
};
/** Commands that constitute running the project's tests, across the ecosystems launchpad meets. */
const TEST_COMMAND = new RegExp([
    'npm\\s+(run\\s+)?test', 'yarn\\s+test', 'pnpm\\s+(run\\s+)?test', 'npx\\s+(vitest|jest|mocha|playwright)',
    '\\bvitest\\b', '\\bjest\\b', '\\bpytest\\b', 'python\\s+-m\\s+(unittest|pytest)',
    'go\\s+test', 'cargo\\s+test', 'flutter\\s+test', 'swift\\s+test', 'xcodebuild[^\\n]*\\btest\\b',
    'gradlew[^\\n]*\\btest\\b', 'bundle\\s+exec\\s+(rspec|rake)', '\\brspec\\b', 'dotnet\\s+test',
    'mvn[^\\n]*\\btest\\b', 'phpunit', 'check\\.sh', 'make\\s+(test|check)',
].join('|'), 'i');
/**
 * Turn one gitignore pattern into something that can be tested against a path.
 * Only the two wildcards that appear in real `.gitignore` files; anything more
 * exotic simply will not match, which errs towards reporting a gap.
 */
const globToRe = (pattern) => new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$');
/** Would git ignore this path, as far as the repo's own `.gitignore` says? */
function ignoredByGit(gitignore, relPath) {
    const base = relPath.split('/').pop();
    return gitignore.split('\n')
        .map(l => l.trim())
        .filter(l => l && !l.startsWith('#') && !l.startsWith('!'))
        .some(p => {
        const clean = p.replace(/^\//, '').replace(/\/$/, '');
        const re = globToRe(clean);
        return re.test(base) || re.test(relPath) || relPath.startsWith(clean + '/');
    });
}
/**
 * Env files actually present, ignoring the ones meant to be committed.
 *
 * `.env.example` is a template with placeholder values and is supposed to be in
 * the repo; treating it as a leak would train people to ignore this check.
 */
function envFiles(repo, maxDepth = 3) {
    const found = [];
    const walk = (rel, depth) => {
        if (depth > maxDepth)
            return;
        for (const name of ls(repo, rel)) {
            if (SKIP_DIRS.has(name))
                continue;
            const child = rel ? join(rel, name) : name;
            if (ls(repo, child).length) {
                if (!name.startsWith('.'))
                    walk(child, depth + 1);
                continue;
            }
            if (/^\.env(\..+)?$/.test(name) && !/\.(example|sample|template|dist|defaults?)$/i.test(name)) {
                found.push(child);
            }
        }
    };
    walk('', 0);
    return found;
}
export function scorecard(repo, st) {
    const kinds = archetypes(st);
    const wired = st.surfaces.filter(s => s.status === 'wired');
    /**
     * What this repo IS, as opposed to which pipeline launchpad ships for it.
     *
     * Without this, every check below phrased itself for a store app: Rails and
     * Rust produced byte-identical scorecards, and a Rust CLI author was told a
     * privacy policy is mandatory for the App Store. The missing pipeline was
     * always stated honestly; the wording around it was not.
     */
    const eco = detectEcosystem(repo);
    const needsStore = kinds.has('ios') || kinds.has('android');
    /** No launchpad surface at all — the case that used to fall through to store copy. */
    const generic = kinds.size === 0;
    /** A desktop app that is not an Xcode project still has to be signed. */
    const isDesktop = eco?.ships === 'desktop' || kinds.has('macos-dmg');
    const checks = [];
    const add = (c) => checks.push(c);
    // Manifests from all three ecosystems: a repo can be more than one of them.
    const deps = read(repo, 'package.json') + read(repo, 'pubspec.yaml') + read(repo, 'Package.swift');
    // ── 1. it builds somewhere other than your machine ────────────────────────
    /**
     * Any CI, not only launchpad's own.
     *
     * Counting `launchpad-*` workflows meant a repo with excellent hand-rolled CI
     * was told "Nothing builds this repo except you." A false gap rather than a
     * false pass, but in the trust-destroying direction: it makes the product
     * look like it cannot see the user's own work, and everything else it says
     * gets discounted accordingly.
     */
    const ci = ciFiles(repo);
    const automatic = ci.filter(f => runsAutomatically(f.name, f.text));
    add({
        id: 'ci-build', title: 'Builds in CI, not just on your machine',
        ...grade(automatic.length > 0, ci.length
            ? `Found ${ci.length} CI file(s), but none of them run on a push — so nothing builds this ` +
                'repo unless someone remembers to ask. "Works on my machine" is not a build.'
            : 'Nothing builds this repo except you. "Works on my machine" is not a build — the first ' +
                'time you change laptops or a dependency drifts, you find out the hard way.'),
    });
    // ── 2. a release is a deliberate, repeatable act ──────────────────────────
    add({
        id: 'versioning', title: 'Versioned releases',
        ...grade(st.surfaces.some(s => s.config?.tagPrefix) || has(repo, 'CHANGELOG.md'), 'No release process is configured, so versions get bumped by hand and eventually wrong. ' +
            'A version you edit manually is a version you will ship twice.'),
    });
    // ── 3-5. signing, by platform ─────────────────────────────────────────────
    if (kinds.has('android')) {
        const { text: gradleText, path: gradlePath } = androidBuildFile(repo, st);
        const verdict = gradleText
            ? releaseSigning(gradleText, gradlePath?.endsWith('.kts') === false ? 'groovy' : 'kotlin')
            : 'none';
        add(verdict === 'declared'
            ? {
                id: 'android-signing', title: 'Android release is signed with a real key',
                grade: 'unknown',
                detail: `${gradlePath} names a signing config for the release build and never gives it a ` +
                    'keystore, so something outside the build file is expected to — your own lane, or an ' +
                    'environment variable. That may be exactly right, and launchpad cannot see it from ' +
                    'here. Check that a release build off a clean clone is actually signed.',
                critical: true,
            }
            : {
                id: 'android-signing', title: 'Android release is signed with a real key',
                ...grade(verdict === 'signed', 'A stock Flutter or Android project signs its RELEASE build with the DEBUG keystore. ' +
                    'The output looks shippable, no store will accept it, and its identity changes per ' +
                    'machine. This is the most common silent blocker for a first Android release.', true),
            });
        add(flutterNetworkPermission(repo, st));
        add({
            id: 'keystore-backup', title: 'Upload keystore is backed up',
            grade: 'unknown',
            detail: 'Only you can confirm this. If the Android upload keystore is lost, that app can NEVER ' +
                'be updated on Play again — there is no recovery, no support ticket, no appeal. Keep a ' +
                'copy somewhere that is not the machine that made it.',
            critical: true,
        });
    }
    if (isDesktop) {
        /**
         * A filename containing `macos` used to pass this. It never once checked
         * that notarization happens — on a check marked critical, about the single
         * step whose absence silently costs most of your downloads.
         *
         * Evidence is the command, wherever it lives: the workflow, or a script the
         * workflow calls.
         */
        /**
         * `notarize: true` and an `afterSign` hook are how electron-builder and
         * Tauri do this, and an Electron app is every bit as much a macOS app as an
         * Xcode one — just not one launchpad ships a pipeline for. Telling its
         * author nothing about Gatekeeper because the project has no `.xcodeproj`
         * would be the tool failing at the only part it can still help with.
         */
        const NOTARIZES = /notarytool|xcrun\s+altool|\bgon\b|--notarize|notarize[-_]?(app|dmg)?\b|"?notarize"?\s*[:=]\s*true|afterSign/i;
        const notarizes = ci.some(f => NOTARIZES.test(f.text))
            || grepRepo(repo, /\.(sh|bash|zsh|ya?ml|rb|json|toml|js|cjs|mjs)$|^Fastfile$/, NOTARIZES, 4, true);
        add({
            id: 'notarization', title: 'macOS build is signed and notarized',
            ...grade(notarizes, (eco?.ships === 'desktop'
                ? `Nothing here notarizes the build. ${eco.name === 'Tauri desktop app' ? 'Tauri' : 'electron-builder'} `
                    + 'can do it — an Apple Developer account, and `notarize` turned on. '
                : 'Nothing in this repo runs `notarytool`. ')
                + 'An un-notarized Mac app shows a Gatekeeper warning that most people will not click '
                + 'through — you lose the download rather than hearing about it. Unsigned on Windows is a '
                + 'SmartScreen block, which is the same problem wearing a different coat.', true),
        });
    }
    // ── 6. it actually reaches people ─────────────────────────────────────────
    /**
     * "Wired" is a configuration, not an outcome. The playbook's own rule is that
     * a pipeline which has never run is a hypothesis, and this check used to
     * award a pass for the hypothesis — telling someone a channel was live when
     * nothing had ever been shipped down it.
     *
     * The WORDING was a separate bug, and a more embarrassing one. The
     * ecosystem-aware branch was gated on `generic`, which is false the moment any
     * launchpad surface exists — so every Next.js, Vite, Astro, Nuxt and
     * static-site project, and every repo with no recognised ecosystem at all
     * including an empty one, was told "no TestFlight, Firebase, DMG, or deployed
     * site". Twelve of twenty-five harness fixtures failed on that one sentence.
     * A Vercel site has no TestFlight; saying so is the failure `ecosystem.ts`'s
     * own header calls the refund — the tool visibly not knowing what it is
     * looking at.
     *
     * So the sentence is built from the surfaces that are actually present, and
     * the ecosystem name is used whenever there is one, surface or no surface.
     */
    add({
        id: 'distribution', title: 'A distribution channel is live',
        ...graded(wired.length === 0 ? 'gap' : hasReleaseTag(repo) ? 'ok' : 'unknown', kinds.size
            ? `Nothing is wired to reach users yet — nothing goes to ${deliveryPhrase(kinds)}. `
                + 'It exists only where you are sitting.'
            : eco
                ? `Nothing is wired to get this in front of anyone. For ${article(eco.name)} ${eco.name} that means `
                    + `being ${installPhrase(eco)} — right now it exists only where you are sitting.`
                : 'Nothing is wired to get this in front of anyone, and launchpad cannot tell what '
                    + 'shape "shipped" takes here. Whatever it is, it exists only where you are sitting.', `${wired.length} surface(s) are wired, but nothing in this repo shows a release has ever ` +
            'actually gone out — there is no tag to point at. A pipeline that has never run is a ' +
            'hypothesis; cut one release and find out which half of it works.'),
    });
    // ── 7. shipped users can be reached again ─────────────────────────────────
    if (isDesktop) {
        const mac = configOf(st, 'macos-dmg');
        // Either launchpad wired it, or the app already had one — an adopted
        // updater is still an updater.
        const hasUpdater = Boolean(mac?.publicEdKey)
            || grepRepo(repo, /^(Info\.plist|project\.yml|Package\.swift|project\.pbxproj)$/, /SUFeedURL|sparkle-project|Sparkle/)
            // Electron and Tauri have their own updaters, and a repo using one is
            // just as updatable as a Sparkle app. Looking only for Sparkle told
            // every Electron author they had no updater when they did.
            || /"electron-updater"\s*:|"@tauri-apps\/plugin-updater"\s*:/.test(deps)
            || grepRepo(repo, /\.(json|toml|ya?ml|js|cjs|mjs|ts)$/, /electron-updater|autoUpdater|tauri[^\n]{0,40}updater|createUpdater/i, 4, true);
        add({
            id: 'auto-update', title: 'Shipped users can be updated',
            ...grade(hasUpdater, 'A directly-distributed desktop app with no updater strands every user on the version they '
                + 'first downloaded, forever. They will not come back to your site to check.'
                + (eco?.ships === 'desktop'
                    ? ` For ${eco.name === 'Tauri desktop app' ? 'Tauri that is the updater plugin' : 'Electron that is electron-updater'}.`
                    : ''), true),
        });
    }
    // ── 8. bad code is caught before it ships ─────────────────────────────────
    /**
     * A filename containing `validate`, or the mere existence of `check.sh`, used
     * to pass this. Neither says anything runs. A local hook is real evidence of
     * intent but not of enforcement — it lives on one machine and `--no-verify`
     * skips it — so it earns `unknown`, not a pass.
     */
    const gatesOnPush = automatic.some(f => TEST_COMMAND.test(f.text));
    const localGate = anyOf(repo, ['check.sh', 'lefthook.yml', '.pre-commit-config.yaml', '.husky']);
    add({
        id: 'test-gate', title: 'Tests gate every push',
        ...graded(gatesOnPush ? 'ok' : localGate ? 'unknown' : 'gap', 'Nothing checks a commit before it can ship. The cheap version of this runs on Linux and ' +
            'costs roughly nothing; skipping it means CI only tells you about problems after a build.', 'There is a local gate in this repo, but nothing in CI runs your tests on a push — so it ' +
            'holds only on the machine it is installed on, and `--no-verify` walks straight past it.'),
    });
    // ── 9. secrets are not in the repo ────────────────────────────────────────
    /**
     * This check was inverted, and it was the worst false pass in the product.
     *
     * It read `/\.env/.test(gitignore) || st.credentialsRequired.length > 0` —
     * so *needing* credentials counted as *handling them well*, and a repo with a
     * committed `.env` full of live keys passed a check marked `critical`. The
     * user is then told the one thing that would send them to look at it is fine.
     *
     * Evidence now, in the only order that is safe: an env file that nothing
     * ignores is a gap regardless of anything else; env files that are all
     * ignored is a pass; and a repo with neither has nothing to judge, which is
     * `unknown` rather than a free pass.
     */
    const gitignore = read(repo, '.gitignore');
    const envs = envFiles(repo);
    const exposed = envs.filter(f => !ignoredByGit(gitignore, f));
    add({
        id: 'secrets-hygiene', title: 'Secrets are out of the repository',
        ...graded(exposed.length ? 'gap' : envs.length ? 'ok' : /(^|\n)\s*!?\.?\*?\.env/.test(gitignore) ? 'ok' : 'unknown', `${exposed.slice(0, 3).map(f => `\`${f}\``).join(', ')}${exposed.length > 3 ? ` and ${exposed.length - 3} more` : ''} ` +
            `${exposed.length === 1 ? 'is' : 'are'} not covered by .gitignore, so \`git add .\` commits ` +
            'it. A key committed to git is public the moment the repo is — and deleting it later does ' +
            'not remove it from the history; it has to be rotated.', 'No .env file here and nothing in .gitignore that would cover one. Nothing is wrong today, ' +
            'but the first time you add one it gets committed by default.', true),
    });
    // ── 10-11. you find out what is happening ─────────────────────────────────
    add({
        id: 'crash-reporting', title: 'Crash reporting',
        ...grade(/sentry|crashlytics|bugsnag|firebase_crashlytics/i.test(deps), 'Without crash reporting you learn about crashes from a one-star review, if at all.'),
    });
    add({
        id: 'analytics', title: 'Install / usage visibility',
        ...grade(/posthog|plausible|amplitude|mixpanel|firebase_analytics|umami|fathom/i.test(deps), 'You cannot tell whether anyone is using this. One number per app is enough; it does not ' +
            'need to be a BI stack.'),
    });
    // ── 12. money, and doing it the way the platform demands ──────────────────
    const macPay = configOf(st, 'macos-dmg');
    // A dependency is proof; a word in a source file is not. "Stripe" appears in
    // in one repo purely as a fake company name in test fixtures, and a
    // bare word match reported a paywall on a pre-revenue app — a false PASS,
    // which is worse than a false gap because the user never goes and adds one.
    // So: the manifest, or an actual import.
    const PAYMENT_DEP = new RegExp([
        '"(stripe|@stripe/[\\w-]+|@lemonsqueezy/[\\w-]+|react-native-purchases)"\\s*:',
        '(^|\\n)\\s*(in_app_purchase|purchases_flutter|flutter_stripe):',
        // Swift Package Manager, and the resolved file a checked-in build produces.
        // A Swift app wiring RevenueCat through SPM was missed entirely, which is
        // most of why "iOS paywalls" could not honestly be claimed.
        'revenuecat/purchases-ios',
        '\\.package\\([^)]*RevenueCat',
    ].join('|'), 'i');
    const PAYMENT_IMPORT = new RegExp([
        'import\\s+StoreKit', // Swift, StoreKit 1 and 2
        'import\\s+RevenueCat\\b', // Swift, RevenueCat SDK
        'Purchases\\.configure', // RevenueCat, any platform
        'com\\.android\\.billingclient', // Kotlin/Java
        'com\\.revenuecat\\.purchases', // Kotlin/Java, RevenueCat
        "package:(in_app_purchase|purchases_flutter)", // Dart
        "from\\s+['\"](stripe|@stripe/|@lemonsqueezy/)", // TS/JS
        "require\\(['\"](stripe|@lemonsqueezy/)",
        'lemonsqueezy\\.com/checkout', // a hosted checkout URL
    ].join('|'), 'i');
    const hasPayments = Boolean(macPay?.payments)
        || PAYMENT_DEP.test(deps)
        || grepRepo(repo, /\.(swift|kt|kts|dart|ts|tsx|js)$/, PAYMENT_IMPORT)
        // An Xcode project declares its SPM dependencies in the project file, not in
        // a manifest at the root, so a RevenueCat paywall is invisible without this.
        || grepRepo(repo, /^(project\.pbxproj|project\.yml|Package\.resolved)$/, PAYMENT_DEP, 5, true);
    add({
        id: 'monetization', title: 'Monetization wired (and platform-correct)',
        ...grade(hasPayments, needsStore
            ? 'No paywall or licensing is wired. When you add one it has to match the platform: iOS and '
                + 'Android require StoreKit / Play Billing for digital goods consumed in the app. Linking '
                + 'out to your own checkout is allowed on the US App Store storefront (since 1 May 2025, no '
                + 'entitlement needed) — but on every other storefront it is still a rejection, so a single '
                + 'worldwide build cannot rely on it.'
            : eco?.ships === 'library' || eco?.ships === 'cli'
                // Most libraries and CLIs are never meant to charge, so this is a
                // prompt rather than a deficiency. Lecturing a crate author about
                // StoreKit is how the whole list stops being believed.
                ? 'Nothing here takes money, which for something people install from a registry is usually '
                    + 'the intent. If you do want to charge, the routes that work are a paid licence key, a '
                    + 'hosted service alongside it, or sponsorship — not a store.'
                : eco?.ships === 'service'
                    ? 'Nothing here takes money. For something you host, that is Stripe or Lemon Squeezy '
                        + 'directly — no platform rules to satisfy, but you own tax and invoicing, which is '
                        + 'what a merchant of record like Lemon Squeezy is actually for.'
                    : 'No paywall or licensing is wired. For a direct download that is a licence key and a '
                        + 'checkout of your choosing — Lemon Squeezy handles VAT as merchant of record; Stripe '
                        + 'is cheaper and leaves that to you.'),
    });
    // ── 13-15. the things stores reject you for ───────────────────────────────
    /**
     * The same three questions, asked in the terms of the project in front of us.
     *
     * A Rust CLI author was told "a privacy policy is MANDATORY for the App Store
     * and Play" — about a binary that will never see a store — and then that there
     * is "no page describing this app" about a crate whose page is its README on
     * crates.io. Both statements are true of an iOS app and neither is true here,
     * and a tool that says four confidently wrong things has spent the credit it
     * needed for the two right ones.
     */
    /**
     * A privacy POLICY, not Apple's privacy MANIFEST.
     *
     * `PrivacyInfo.xcprivacy` is a required Xcode resource declaring which
     * system APIs an app calls and why. It is not a document, it is not
     * publishable, and it satisfies nothing App Review asks for on the policy
     * front — but it is named `Privacy…`, so `^(privacy|terms)` matched it.
     *
     * That was harmless while React Native was refused. It stopped being
     * harmless the moment React Native and Expo shipped, because RN's own
     * template has included that file by default since 0.73: **every** React
     * Native app would have been told it has a privacy policy when it does not,
     * on a row whose whole point is that its absence is a rejection rather than
     * a nag. Caught by eye reading a real fixture's scorecard before baselining
     * it, which is the only reason it did not become the snapshot.
     */
    const hasLegal = findDoc(repo, /^(privacy|terms)(?!info\b)(?!.*\.xcprivacy$)/i);
    add({
        id: 'legal', title: 'Privacy policy and terms exist',
        grade: hasLegal ? 'ok' : needsStore ? 'gap' : 'unknown',
        detail: hasLegal ? '' : needsStore
            ? 'A privacy policy is MANDATORY for the App Store and Play — its absence is a rejection, '
                + 'not a nag. It also has to be a reachable public URL before you can submit.'
            : eco?.ships === 'service'
                ? 'No privacy policy or terms in this repo. No store is going to demand one, but anything '
                    + 'that holds a stranger\'s data eventually needs both — and if you take payments, your '
                    + 'processor will ask before your users do.'
                : eco?.ships === 'library' || eco?.ships === 'cli'
                    ? 'No privacy policy in this repo, which for something people run locally is usually fine. '
                        + 'What matters more here is a LICENSE file, checked separately.'
                    : 'No privacy policy or terms found. Only you know whether this collects anything that '
                        + 'needs one.',
        ...(needsStore ? { critical: true } : {}),
    });
    /** For a library or a CLI the "page" is the README on its registry. */
    const readme = read(repo, 'README.md') || read(repo, 'README') || read(repo, 'readme.md');
    /**
     * "This app is itself a website" is true of a Rails or Django repo and absurd
     * in front of an Android app — which is what happened, because `sunflower`'s
     * ecosystem is `JVM project` (ships: service) and the branch asked only the
     * ecosystem. An ecosystem's guess about shape must never contradict a surface
     * launchpad actually found, so this claim is available only when there is no
     * surface to contradict it.
     */
    const servesItsOwnPage = eco?.ships === 'service' && kinds.size === 0;
    add({
        id: 'landing', title: 'Somewhere to send a stranger',
        ...(kinds.has('static-site') || kinds.has('web-app') || Boolean(configOf(st, 'static-site'))
            ? grade(true, '')
            : servesItsOwnPage
                // The app IS a website. Whether it explains itself to somebody who has
                // not signed up is a real question, and not one a repo can answer.
                ? {
                    grade: 'unknown',
                    detail: 'This app is itself a website, so it may already be its own landing page. What a '
                        + 'repo cannot tell is whether there is anything that explains it to someone who has not '
                        + 'signed up yet — only you can say.',
                }
                : eco && generic && (eco.ships === 'cli' || eco.ships === 'library')
                    // `readme` owns this for a CLI or a library; two rows about one file
                    // reads as the tool repeating itself.
                    ? { grade: 'n/a', detail: '' }
                    : eco && (eco.ships === 'cli' || eco.ships === 'library')
                        ? grade(readme.length > 400, `For ${article(eco.name)} ${eco.name} the page IS the README — it is what ${eco.registry ?? 'a registry'} `
                            + 'renders, and it is the whole of a stranger\'s first impression. This one is '
                            + `${readme ? 'very short' : 'missing'}: what it does, why, and the one line that installs it.`)
                        : grade(false, 'There is no page describing this app. Every channel you might use later — a store '
                            + 'listing, a post, a link to a friend — needs somewhere to point.')),
    });
    add({
        id: 'support', title: 'A support contact',
        grade: findDoc(repo, /^(support|contact)/i) || /support@|mailto:|issues/i.test(readme) ? 'ok' : 'unknown',
        detail: needsStore
            ? 'Both app stores require a support URL or email on the listing. Only you can confirm one '
                + 'exists and reaches you.'
            : 'Nowhere in this repo says where a stranger reports a problem. An issues link in the README '
                + 'is enough. Only you can confirm it reaches you.',
    });
    /**
     * The questions that apply when there is no store — and that were never asked.
     *
     * Rails and Rust scored identically not only because the wording was wrong but
     * because the checks themselves were the wrong ones: eleven questions about
     * store submission and none about the things that actually stop a crate, a
     * module or a service from being usable by somebody else. These are the
     * equivalents, and they are as consequential in their own world as
     * notarization is in Apple's.
     */
    if (eco && eco.ships !== 'app' && generic) {
        add({
            id: 'readme', title: 'A README that explains what this is',
            ...grade(/^#/m.test(readme) && readme.length > 400, readme
                ? 'The README is very short. For anything a stranger might adopt it is the product page, '
                    + 'the documentation and the pitch at once — what it does, who it is for, and how to '
                    + 'run it. This is the cheapest thing on this list and the one people skip.'
                : 'There is no README. Whatever else is true of this project, nobody can tell what it is.'),
        });
        /**
         * Not paperwork. Code with no licence is code nobody may legally use, and
         * for a library that is not a formality — it is the reason a company's
         * lawyer says no, silently, and you never hear about it.
         */
        const LICENCE_FIELD = /"license"\s*:|^\s*license\s*[:=]|<licenses?>|licenses?\s*=/im;
        add({
            id: 'license-file', title: 'A licence someone else can rely on',
            ...grade(Boolean(ls(repo, '').find(n => /^(LICENSE|LICENCE|COPYING)(\.(md|txt))?$/i.test(n)))
                || LICENCE_FIELD.test(deps + read(repo, 'Cargo.toml') + read(repo, 'go.mod') + read(repo, 'pyproject.toml')), eco.ships === 'library' || eco.ships === 'cli'
                ? 'There is no LICENSE file. Without one, default copyright applies and nobody may legally '
                    + 'use, ship or depend on this — which for a library is not a technicality, it is the '
                    + 'quiet reason a company never adopts it and never tells you why.'
                : 'There is no LICENSE file. Even for something you host yourself, its absence makes every '
                    + 'question about contributions, forks and reuse ambiguous.'),
        });
        /**
         * The finish line, and it is a different line for each kind of project.
         *
         * "A stranger can install it" is the right question for a crate and a
         * meaningless one for a Rails app, which nobody installs — it is deployed.
         * Asking the wrong one, under a title that does not fit, is how a scorecard
         * ends up feeling generic even once the wording underneath it is correct.
         */
        const INSTALL_CMD = /(npm|pnpm|yarn|pip|pipx|uv|cargo|go|gem|brew|apt|docker)\s+(install|add|get|run|pull)/i;
        const DEPLOY_CONFIG = ['Dockerfile', 'Procfile', 'fly.toml', 'render.yaml', 'app.yaml',
            'compose.yaml', 'docker-compose.yml', 'kamal.yml', 'config/deploy.yml', 'vercel.json',
            'netlify.toml', 'railway.json', 'captain-definition'];
        if (eco.ships === 'service') {
            const deployable = anyOf(repo, DEPLOY_CONFIG)
                || ci.some(f => /deploy|fly\s+deploy|kamal|kubectl|docker\s+push/i.test(f.text));
            add({
                id: 'install-path', title: 'It runs somewhere that is not your laptop',
                ...graded(deployable ? 'unknown' : 'gap', 'Nothing here describes how this gets deployed — no container, no platform config, no '
                    + 'deploy step in CI. Until one exists, "shipping" means you, by hand, from this machine, '
                    + 'and only while it is switched on.', 'There is a deploy configuration, but a repo cannot tell whether it is actually running '
                    + 'anywhere. Only you can confirm there is a URL a stranger can reach.'),
            });
        }
        else {
            add({
                id: 'install-path',
                title: eco.ships === 'desktop' ? 'A stranger can download and run it' : 'A stranger can install it',
                ...(eco.registry
                    ? graded(INSTALL_CMD.test(readme) ? 'ok' : hasReleaseTag(repo) ? 'unknown' : 'gap', `Nothing here says how to get a copy. For ${article(eco.name)} ${eco.name} the finish line is `
                        + `${installPhrase(eco)} — until then it is a repository, not something anyone can use.`, 'There are release tags but no install line in the README. Whether this is actually on '
                        + `${eco.registry} is something only you can confirm.`)
                    : graded(hasReleaseTag(repo) ? 'unknown' : 'gap', 'Nothing here produces something a stranger can download — no release, no packaged '
                        + 'artifact. A build on your machine is not a copy anyone else can run.', 'There are release tags, but whether they carry a runnable artifact for anyone else is '
                        + 'not something the repo can show. Only you can confirm it.')),
            });
        }
    }
    // ── store presence ────────────────────────────────────────────────────────
    // The gap nobody anticipates. These are not polish; a store will refuse to
    // publish without them, and you find out at submission.
    const assets = detectAssets(repo, st);
    // Pick the strictest requirement present: an app that is both iOS and
    // Android has to satisfy Apple, and satisfying Apple satisfies Play.
    const iconReq = st.surfaces
        .map(x => ICON_REQUIREMENT[x.archetype])
        .filter(Boolean)
        .sort((a, b) => (b.noAlpha ? 1 : 0) - (a.noAlpha ? 1 : 0) || b.size - a.size)[0];
    if (iconReq || kinds.has('web-app') || kinds.has('static-site')) {
        const icon = assets.icon;
        const bigEnough = !iconReq || !icon || icon.width === 0 || icon.width >= iconReq.size;
        const alphaProblem = Boolean(iconReq?.noAlpha && icon?.hasAlpha && icon.width >= 512);
        /**
         * One row, two audiences — and until now, one title for both.
         *
         * "An app icon the store will accept" was shown to every Vercel site and
         * every static site in the harness, whose *detail* was already correctly
         * about favicons and browser tabs. A Vercel site has no store. The title
         * now comes from the same branch that picks the detail, and it names the
         * thing that will actually refuse the upload: Apple, Play, macOS, or a
         * browser tab.
         */
        add(!iconReq
            // Web or static only: no store, no size gate, and the second half of a
            // link's first impression is the preview image, not the favicon.
            ? {
                id: 'app-icon', title: 'A favicon, and an image links preview with',
                ...(!icon
                    ? grade(false, 'No icon or favicon found. Every browser tab, bookmark and shared link shows one, and its '
                        + 'absence is the first thing that reads as unfinished.')
                    : assets.ogImage
                        ? grade(true, '')
                        // A framework can generate the preview image at request time
                        // (`app/opengraph-image.tsx` and friends), which a file scan cannot
                        // see — so this is `unknown`, not a gap somebody goes and "fixes".
                        : {
                            grade: 'unknown',
                            detail: `The favicon is there (\`${icon.path}\`), but nothing in this repo looks like an `
                                + 'Open Graph image. Every link to this — a post, a DM, a search result — renders as a '
                                + 'blank rectangle without one. If your framework generates it at request time, say so '
                                + 'and this goes green.',
                        }),
            }
            : {
                id: 'app-icon',
                title: iconReq.store === 'a Mac app'
                    ? 'An app icon at the size macOS needs'
                    : `An app icon ${iconReq.store === 'Play' ? 'Play' : iconReq.store} will accept`,
                ...(!icon
                    ? grade(false, `No app icon found. ${iconReq.store} requires a ${iconReq.size}×${iconReq.size} icon before it `
                        + 'will accept a build at all, so this blocks submission rather than looking unfinished.')
                    : alphaProblem
                        ? grade(false, `\`${icon.path}\` has an alpha channel. ${iconReq.store} rejects icons with transparency — `
                            + 'the upload succeeds and the build is rejected afterwards, which is why this is easy to hit '
                            + 'twice. Flatten it onto an opaque background.', true)
                        : !bigEnough
                            ? grade(false, `\`${icon.path}\` is ${icon.width}×${icon.height}. ${iconReq.store} requires `
                                + `${iconReq.size}×${iconReq.size}; anything smaller is refused at upload.`)
                            : grade(true, '')),
            });
    }
    if (hasStoreSurface(st.surfaces)) {
        const needsFeature = kinds.has('android');
        const fg = assets.featureGraphic;
        add({
            id: 'store-listing', title: 'Store listing assets exist',
            ...grade(Boolean(assets.listingDir) && assets.screenshots.length > 0 && (!needsFeature || Boolean(fg)), [
                'A store listing is its own deliverable, and it is the step most people have not started.',
                assets.screenshots.length ? null : (kinds.has('ios') && kinds.has('android')
                    ? 'No screenshots found — Play needs at least two, and the App Store needs a set per device size you list.'
                    : kinds.has('ios') ? 'No screenshots found — the App Store needs a set per device size you list.'
                        : kinds.has('android') ? 'No screenshots found — Play needs at least two.'
                            : 'No screenshots found — a download page with no picture of the app converts badly.'),
                needsFeature && !fg
                    ? 'No 1024×500 feature graphic found. Play will not publish a listing without one; it is a hard block, not a nag.'
                    : null,
                assets.listingDir ? null : 'No metadata directory (description, keywords, release notes) — `fastlane/metadata` is the convention, and it makes the listing reviewable in a diff like everything else.',
            ].filter(Boolean).join(' ')),
        });
    }
    /**
     * The user's own answers, applied last.
     *
     * `unknown` → `ok` only. A `gap` is something launchpad observed, and no
     * assertion may turn it green: that direction is the false pass this entire
     * file is written to avoid. So a stale confirmation cannot mask a problem
     * that has since become visible — the evidence simply wins.
     */
    const answers = readConfirmations(repo);
    for (const c of checks) {
        if (c.grade !== 'unknown')
            continue;
        c.answerable = true;
        const a = answers[c.id];
        if (!a)
            continue;
        c.grade = 'ok';
        c.confirmedAt = a.at;
        c.detail = '';
    }
    const applicable = checks.filter(c => c.grade !== 'n/a').length;
    const passed = checks.filter(c => c.grade === 'ok').length;
    const remaining = checks.filter(c => c.grade === 'gap').length;
    const unconfirmed = checks.filter(c => c.grade === 'unknown').length;
    // Critical gaps first, then ordinary gaps, then unknowns, then passes: the
    // list should open on what can actually hurt.
    const sorted = checks.sort((a, b) => rank(a) - rank(b));
    // Decidable only. An unanswerable row must not hold the ceiling down.
    const decidable = passed + remaining;
    return {
        project: st.project,
        checks: sorted,
        score: decidable ? Math.round((passed / decidable) * 100) : 0,
        applicable,
        passed,
        remaining,
        unconfirmed,
        next: sorted.find(c => c.grade === 'gap'),
    };
}
function rank(c) {
    if (c.grade === 'gap')
        return c.critical ? 0 : 1;
    if (c.grade === 'unknown')
        return c.critical ? 2 : 3;
    return 4;
}
/**
 * A queue, not a report card. The dashboard renders the same data as a grid.
 *
 * This used to open with `readiness 18% (2/11)`. Everything after that line was
 * useful and almost nobody got there in the right frame of mind: the first
 * thing a person with an unfinished app saw was a mark out of a hundred,
 * confirming what they already felt. The list itself is the product — the whole
 * premise is that they do not know what is on it — so the list leads, it has a
 * front, and the number that appears is a count of work rather than a grade.
 */
export function renderScorecard(s) {
    const icon = { ok: '✓', gap: '✗', unknown: '?', 'n/a': '·' };
    const out = [];
    if (s.remaining === 0) {
        out.push(`${s.project} — nothing left that launchpad can see.`);
    }
    else {
        out.push(`${s.project} — ${s.remaining} thing${s.remaining === 1 ? '' : 's'} between this and a product.`);
    }
    if (s.next) {
        out.push('', `  Start here: ${s.next.title}`, `    ${s.next.detail}`);
    }
    out.push('');
    // Passes last. Someone scanning for what to do next should not have to read
    // past the things that are already fine.
    const worklist = s.checks.filter(c => c.grade !== 'ok');
    const done = s.checks.filter(c => c.grade === 'ok');
    for (const c of worklist) {
        if (c === s.next)
            continue;
        out.push(`  ${icon[c.grade]} ${c.title}${c.critical && c.grade !== 'ok' ? '   [critical]' : ''}`);
        if (c.detail)
            out.push(`      ${c.detail}`);
    }
    if (s.unconfirmed) {
        out.push('', `  ${s.unconfirmed} of the above ${s.unconfirmed === 1 ? 'is' : 'are'} only yours to answer — `
            + 'launchpad cannot see inside a drawer or an inbox. They are not counted against you.');
    }
    if (done.length) {
        out.push('', `  Already done: ${done.map(c => c.title).join(' · ')}`);
    }
    return out.join('\n');
}
