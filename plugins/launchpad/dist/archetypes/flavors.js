import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { badgeDevPng } from './devbuild.js';
/**
 * Flutter dev/prod flavour injectors.
 *
 * Every function here is a pure, idempotent text transform: given the current
 * contents of a native project file it returns the flavoured contents, or the
 * input unchanged when the flavours are already wired (or the file has a shape
 * we don't recognise). Re-running `apply` must produce a zero diff.
 *
 * Invariant across the whole module: **prod is the current identity**. The prod
 * flavour never adds a suffix or renames anything, and on iOS the base
 * Debug/Profile/Release configs and the RunnerTests target are left in place so
 * a no-flavour `flutter build ipa --release` keeps working byte-for-byte.
 */
// ─────────────────────────────────────────────────────────── Android (Kotlin DSL)
/**
 * Insert an `env` flavour dimension with `prod`/`dev` product flavours into an
 * `android/app/build.gradle.kts`. Kotlin-DSL syntax (`create("x")`, `+=`, `=`),
 * inserted after `defaultConfig { }` inside the existing `android { }` block.
 *
 * `prodLabel` should be the app's *current* manifest label so prod keeps its
 * identity; it defaults to `appName`. `devLabel` defaults to "<appName> Dev".
 */
export function injectAndroidFlavors(kts, c) {
    if (/\bflavorDimensions\b/.test(kts) || /\bproductFlavors\b/.test(kts))
        return kts;
    const androidM = /(^|\n)([ \t]*)android\s*\{/.exec(kts);
    if (!androidM)
        return kts;
    const androidOpen = kts.indexOf('{', androidM.index + androidM[1].length);
    const androidClose = matchBrace(kts, androidOpen, ktSkip);
    let insertAt;
    let indent;
    const dcRe = /\n([ \t]*)defaultConfig\s*\{/g;
    dcRe.lastIndex = androidOpen;
    const dcM = dcRe.exec(kts);
    if (dcM && dcM.index < androidClose) {
        indent = dcM[1];
        insertAt = matchBrace(kts, kts.indexOf('{', dcM.index), ktSkip) + 1;
    }
    else {
        // No defaultConfig — fall back to just before the `android { }` closing brace.
        indent = `${androidM[2]}    `;
        insertAt = kts.lastIndexOf('\n', androidClose);
    }
    const devLabel = c.devLabel ?? `${c.appName} Dev`;
    const prodLabel = c.prodLabel ?? c.appName;
    const i1 = indent;
    const i2 = indent.repeat(2);
    const i3 = indent.repeat(3);
    const block = [
        `${i1}flavorDimensions += "env"`,
        `${i1}productFlavors {`,
        `${i2}create("prod") {`,
        `${i3}dimension = "env"`,
        `${i3}manifestPlaceholders["appLabel"] = "${prodLabel}"`,
        `${i2}}`,
        `${i2}create("dev") {`,
        `${i3}dimension = "env"`,
        `${i3}applicationIdSuffix = ".dev"`,
        `${i3}manifestPlaceholders["appLabel"] = "${devLabel}"`,
        `${i2}}`,
        `${i1}}`,
    ].join('\n');
    return `${kts.slice(0, insertAt)}\n\n${block}${kts.slice(insertAt)}`;
}
/**
 * Point the `<application>` label at the flavour placeholder so
 * `manifestPlaceholders["appLabel"]` drives the launcher name.
 */
export function injectAndroidManifestLabel(manifestXml) {
    const appTag = /<application\b[^>]*>/.exec(manifestXml);
    const region = appTag ? appTag[0] : manifestXml;
    const label = /android:label\s*=\s*"([^"]*)"/.exec(region);
    if (!label)
        return manifestXml;
    if (label[1] === '${appLabel}')
        return manifestXml;
    const patched = region.replace(label[0], 'android:label="${appLabel}"');
    if (!appTag)
        return patched;
    return manifestXml.slice(0, appTag.index) + patched + manifestXml.slice(appTag.index + appTag[0].length);
}
// ───────────────────────────────────────────────────────────────── iOS (pbxproj)
const IOS_MODES = ['Debug', 'Profile', 'Release'];
/**
 * Clone the build configurations into `<Mode>-dev` / `<Mode>-prod` variants and
 * register them in **every** `XCConfigurationList` in the project — the
 * PBXProject's plus each PBXNativeTarget's — each cloned from *its own* base
 * configs. That is exactly what Xcode does when you add a configuration in the
 * UI: the configuration appears on the project and on every target.
 *
 * N lists ⇒ 6×N new objects (a stock Flutter project has 3: project, Runner,
 * RunnerTests ⇒ 18). Cloning the app target's configs into the *other* lists
 * instead breaks two different things, neither of which `xcodebuild -list` or
 * `-showBuildSettings` notices:
 *
 * - The PBXProject's configs carry project-wide settings (`SDKROOT`,
 *   `SUPPORTED_PLATFORMS`). Without them Xcode resolves the flavour scheme's
 *   destinations to macOS — "Unable to find a destination matching the provided
 *   destination specifier: { generic:1, platform:iOS }" — and `flutter build ipa
 *   --flavor prod` fails.
 * - Leaving a target (e.g. RunnerTests) *without* a config of a given name makes
 *   CocoaPods resolve that target against the project-level config, which has no
 *   `SWIFT_VERSION` while the target's real configs do: "There may only be up to
 *   1 unique SWIFT_VERSION per target… RunnerTests: Swift / RunnerTests: Swift
 *   5.0", and `pod install` aborts inside `flutter build ipa`.
 *
 * So only the **app target's** clones get identity overrides
 * (`PRODUCT_BUNDLE_IDENTIFIER`, `APP_DISPLAY_NAME`,
 * `ASSETCATALOG_COMPILER_APPICON_NAME`); every other list — the project's and
 * non-app targets' — gets faithful copies of its own base configs, so inherited
 * settings survive verbatim.
 *
 * Hand-rolled and narrowly scoped on purpose — launchpad stays single-dependency,
 * so no pbxproj parser and no Ruby shell-out. Base configs are only ever *read*,
 * except for adding `APP_DISPLAY_NAME` to the base *app target* configs so the
 * untouched no-flavour build keeps its current name once `Info.plist` references
 * the variable.
 */
export function injectIosFlavors(pbxproj, c) {
    const objects = scanPbxObjects(pbxproj);
    if (!objects.length)
        return pbxproj;
    const nativeTargets = objects.filter((o) => /\bisa = PBXNativeTarget;/.test(o.text));
    const appTarget = nativeTargets.find((o) => /productType = "com\.apple\.product-type\.application"/.test(o.text));
    const projectObj = objects.find((o) => /\bisa = PBXProject;/.test(o.text));
    if (!appTarget || !projectObj)
        return pbxproj;
    const targetListUuid = refOf(appTarget.text, 'buildConfigurationList');
    const projectListUuid = refOf(projectObj.text, 'buildConfigurationList');
    if (!targetListUuid || !projectListUuid)
        return pbxproj;
    const byUuid = new Map(objects.map((o) => [o.uuid, o]));
    if (!byUuid.has(targetListUuid) || !byUuid.has(projectListUuid))
        return pbxproj;
    const configsOf = (list) => listedUuids(list.text)
        .map((u) => byUuid.get(u))
        .filter((o) => !!o && /\bisa = XCBuildConfiguration;/.test(o.text));
    // Every configuration list in the project, in file order, each tagged with its
    // owner (which becomes part of the uuid seed so no two lists share a clone).
    // A degenerate project pointing two owners at one list is flavoured once, and
    // the app target wins so the identity overrides are not lost.
    const owners = [
        { listUuid: projectListUuid, owner: 'project', isApp: false },
        ...nativeTargets.flatMap((t) => {
            const listUuid = refOf(t.text, 'buildConfigurationList');
            if (!listUuid)
                return [];
            const label = configName(t.text) ?? (t.comment || t.uuid);
            return [{ listUuid, owner: `target:${label}`, isApp: t.uuid === appTarget.uuid }];
        }),
    ];
    const seen = new Map();
    for (const { listUuid, owner, isApp } of owners) {
        const list = byUuid.get(listUuid);
        if (!list)
            continue;
        const prev = seen.get(listUuid);
        if (prev) {
            if (isApp)
                Object.assign(prev, { owner, isApp }); // app target wins a shared list
            continue;
        }
        const base = configsOf(list);
        if (!base.length)
            continue; // nothing of its own to clone — leave it alone
        seen.set(listUuid, { list, owner, isApp, base });
    }
    // The project's and the app target's lists must both have resolved, or the file
    // has a shape we don't understand and we leave it entirely alone.
    if (!seen.has(projectListUuid) || !seen.has(targetListUuid))
        return pbxproj;
    const lists = [...seen.values()];
    const baseNames = lists.flatMap((l) => l.base.map((o) => configName(o.text))).filter((n) => !!n);
    // Idempotency: any flavoured clone already present means we're done.
    if (baseNames.some((n) => new RegExp(`name = "?${escapeRe(n)}-(?:dev|prod)"?;`).test(pbxproj)))
        return pbxproj;
    const devSuffix = c.devSuffix ?? '.dev';
    const devIcon = c.devIcon === undefined ? FLUTTER_DEV_ICON : c.devIcon;
    const taken = new Set(pbxproj.match(/[0-9A-F]{24}/g) ?? []);
    // base uuid → the replacement text for that object (itself, plus its clones).
    const cloned = new Map();
    const edits = [];
    for (const { list, owner, isApp, base: baseConfigs } of lists) {
        const minted = [];
        for (const base of baseConfigs) {
            const name = configName(base.text);
            if (!name)
                continue;
            let slot = cloned.get(base.uuid);
            if (!slot)
                cloned.set(base.uuid, (slot = { base, head: base.text, made: [] }));
            // The base config itself only ever gains APP_DISPLAY_NAME, and only on the
            // app target — a display name is that target's identity, nobody else's.
            if (isApp)
                slot.head = setBuildSetting(slot.head, 'APP_DISPLAY_NAME', c.appName, { quote: true });
            for (const flavor of ['dev', 'prod']) {
                const cloneName = `${name}-${flavor}`;
                // The owning list is part of the seed, so clones of the same config name
                // for different lists get different uuids.
                const uuid = mintUuid(`${c.bundleId}:${owner}:${cloneName}`, taken);
                let text = cloneConfig(base.text, uuid, cloneName);
                if (isApp) {
                    text = setBuildSetting(text, 'APP_DISPLAY_NAME', flavor === 'dev' ? `${c.appName} Dev` : c.appName, { quote: true });
                    if (flavor === 'dev') {
                        text = setBuildSetting(text, 'PRODUCT_BUNDLE_IDENTIFIER', `${c.bundleId}${devSuffix}`);
                        // `AppIcon-dev` is lowercase ON PURPOSE — do not "fix" it to AppIcon-Dev.
                        // Flutter flavor names must be lowercase (the CLI maps `--flavor dev` to the
                        // scheme/config suffix), and `flutter_launcher_icons` emits the asset-catalog
                        // set as `AppIcon-<flavor>`. The native/macOS dev-variant path in devbuild.ts
                        // uses its own `AppIcon-Dev` convention; the two are separate subsystems.
                        // `wireFlutterFlavors` makes the set this names (ensureFlavorDevIconSet).
                        if (devIcon)
                            text = setBuildSetting(text, 'ASSETCATALOG_COMPILER_APPICON_NAME', devIcon);
                    }
                }
                slot.made.push(text);
                minted.push({ uuid, name: cloneName });
            }
        }
        edits.push({ start: list.start, end: list.end, text: registerConfigs(list.text, minted) });
    }
    for (const { base, head, made } of cloned.values()) {
        const indent = lineIndent(pbxproj, base.start);
        edits.push({ start: base.start, end: base.end, text: [head, ...made].join(`\n${indent}`) });
    }
    // Apply back-to-front so earlier offsets stay valid.
    let out = pbxproj;
    for (const e of edits.sort((a, b) => b.start - a.start)) {
        out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
}
/** Extend the `project 'Runner', { … }` build-mode map with the flavoured configs. */
export function injectPodfileConfigs(podfile, flavors) {
    const m = /project\s+(['"])[^'"]+\1\s*,\s*\{/.exec(podfile);
    if (!m)
        return podfile;
    const open = podfile.indexOf('{', m.index);
    const close = matchBrace(podfile, open, rubySkip);
    const body = podfile.slice(open + 1, close);
    const entryRe = /(['"])([^'"]+)\1\s*=>\s*(:[A-Za-z_]+)/g;
    const base = [];
    const present = new Set();
    for (let e = entryRe.exec(body); e; e = entryRe.exec(body)) {
        present.add(e[2]);
        if (!e[2].includes('-'))
            base.push({ name: e[2], mode: e[3] });
    }
    if (!base.length)
        return podfile;
    const indentM = /\n([ \t]+)\S/.exec(body);
    const indent = indentM ? indentM[1] : '  ';
    const added = [];
    for (const flavor of flavors) {
        for (const b of base) {
            const name = `${b.name}-${flavor}`;
            if (present.has(name))
                continue;
            present.add(name);
            added.push(`${indent}'${name}' => ${b.mode},`);
        }
    }
    if (!added.length)
        return podfile;
    const insertAt = podfile.lastIndexOf('\n', close);
    return `${podfile.slice(0, insertAt)}\n${added.join('\n')}${podfile.slice(insertAt)}`;
}
/**
 * Turn the base `Runner.xcscheme` into a flavour scheme: Run/Test/Analyze on
 * `Debug-<flavor>`, Profile on `Profile-<flavor>`, Archive on `Release-<flavor>`.
 * The caller writes the result to `xcshareddata/xcschemes/<flavor>.xcscheme`.
 */
export function iosSchemeXml(flavor, base) {
    const actions = [
        ['TestAction', 'Debug'],
        ['LaunchAction', 'Debug'],
        ['AnalyzeAction', 'Debug'],
        ['ProfileAction', 'Profile'],
        ['ArchiveAction', 'Release'],
    ];
    let out = base;
    for (const [action, mode] of actions) {
        const re = new RegExp(`(<${action}\\b[\\s\\S]*?buildConfiguration = ")([^"]*)(")`);
        out = out.replace(re, (_m, head, _cur, tail) => `${head}${mode}-${flavor}${tail}`);
    }
    return out;
}
/** Drive `CFBundleDisplayName` off the per-config `APP_DISPLAY_NAME` build setting. */
export function injectInfoPlistDisplayName(plistXml) {
    const VALUE = '$(APP_DISPLAY_NAME)';
    const existing = /(<key>CFBundleDisplayName<\/key>\s*<string>)([\s\S]*?)(<\/string>)/.exec(plistXml);
    if (existing) {
        if (existing[2] === VALUE)
            return plistXml;
        return plistXml.replace(existing[0], () => `${existing[1]}${VALUE}${existing[3]}`);
    }
    const close = plistXml.lastIndexOf('</dict>');
    if (close < 0)
        return plistXml;
    const lineStart = plistXml.lastIndexOf('\n', close);
    const indent = plistXml.slice(lineStart + 1, close).match(/^[ \t]*/)?.[0] ?? '';
    const entry = `\n${indent}\t<key>CFBundleDisplayName</key>\n${indent}\t<string>${VALUE}</string>`;
    return plistXml.slice(0, lineStart) + entry + plistXml.slice(lineStart);
}
const FLAVORS = ['dev', 'prod'];
const SCHEMES_DIR = 'ios/Runner.xcodeproj/xcshareddata/xcschemes';
/**
 * Wire dev/prod flavours across a Flutter app dir by composing the injectors
 * above. Every step is guarded by `existsSync` and idempotent: an app missing a
 * file (no Podfile, no Info.plist, an Android-only or iOS-only app) simply skips
 * it, and a file whose contents don't change is not rewritten.
 *
 * Groovy `android/app/build.gradle` is deliberately skipped — the injector is
 * Kotlin-DSL only, and silently emitting Groovy-shaped text would corrupt the
 * build file. Groovy support is a future milestone.
 *
 * The dev configs name an `AppIcon-dev` set, so this also MAKES that set — a
 * DEV-badged copy of `AppIcon` (see `ensureFlavorDevIconSet`). Naming it
 * without making it was a real bug: every dev-flavour iOS build died in
 * `actool` until somebody ran a runbook step nobody knew about. With no
 * `AppIcon` set to copy, the dev configs keep the base icon name instead, and
 * `log` says so.
 *
 * Returns the repo-relative paths actually changed (empty on a re-run).
 */
export function wireFlutterFlavors(repo, c, log = console.log, opts = {}) {
    const changed = [];
    const dry = opts.dryRun === true;
    if (dry)
        log = () => { };
    /** What each patched file WOULD hold, so a dry run can plan what follows from it. */
    const planned = new Map();
    const rel = (p) => (c.workdir === '.' ? p : `${c.workdir}/${p}`);
    const patch = (relPath, fn) => {
        const abs = join(repo, relPath);
        if (!existsSync(abs))
            return;
        const orig = readFileSync(abs, 'utf8');
        const next = fn(orig);
        if (next === orig)
            return; // unchanged → don't rewrite, don't report
        if (dry)
            planned.set(relPath, next);
        else
            writeFileSync(abs, next, 'utf8');
        changed.push(relPath);
    };
    // Prod keeps the app's current launcher name, so read the label before the
    // manifest is rewritten to `${appLabel}` (a re-run finds the placeholder and
    // falls through to appName — by then the flavour block already exists).
    const manifestRel = rel('android/app/src/main/AndroidManifest.xml');
    const prodLabel = c.androidLabel ?? currentManifestLabel(join(repo, manifestRel));
    const ktsRel = rel('android/app/build.gradle.kts');
    patch(ktsRel, (s) => injectAndroidFlavors(s, { appName: c.appName, prodLabel }));
    /**
     * The manifest's `${appLabel}` is only satisfiable when the build file
     * supplies `manifestPlaceholders["appLabel"]`. A Groovy `build.gradle` is
     * skipped above, and rewriting the label anyway left every Android build
     * failing manifest merge on an unknown placeholder — observed on a real
     * Groovy Flutter app by the buyer journey's replay.
     */
    const ktsText = planned.get(ktsRel) ?? (existsSync(join(repo, ktsRel)) ? readFileSync(join(repo, ktsRel), 'utf8') : '');
    if (/manifestPlaceholders\["appLabel"\]/.test(ktsText))
        patch(manifestRel, injectAndroidManifestLabel);
    else if (existsSync(join(repo, manifestRel)) && readFileSync(join(repo, manifestRel), 'utf8').includes('android:label="${appLabel}"')
        && !existsSync(join(repo, ktsRel))) {
        // An older launchpad did exactly that to a Groovy app. Say so; the
        // manifest is the user's file, so launchpad does not rewrite it back.
        log(`  ! ${manifestRel} sets android:label="\${appLabel}", and nothing supplies that placeholder`);
        log('      (a Groovy build.gradle gets no flavours) — every Android build fails at manifest merge.');
        log('      Put the app\'s own name back in android:label.');
    }
    // Name the dev icon set only when it exists or can be made from AppIcon.
    const pbxRel = rel('ios/Runner.xcodeproj/project.pbxproj');
    const iosDir = join(repo, rel('ios'));
    const canHaveDevIcon = !!findIconSet(iosDir, FLUTTER_DEV_ICON) || !!findIconSet(iosDir, FLUTTER_BASE_ICON);
    patch(pbxRel, (s) => injectIosFlavors(s, { bundleId: c.bundleId, appName: c.appName, devIcon: canHaveDevIcon ? FLUTTER_DEV_ICON : null }));
    if (!canHaveDevIcon && changed.includes(pbxRel)) {
        log(`  ! ${rel('ios')}: no \`${FLUTTER_BASE_ICON}.appiconset\` to make a DEV icon from, so the dev flavour`);
        log('      keeps the prod icon. Add one (e.g. `dart run flutter_launcher_icons`) and set');
        log(`      ASSETCATALOG_COMPILER_APPICON_NAME = ${FLUTTER_DEV_ICON} on the *-dev configs to tell them apart.`);
    }
    patch(rel('ios/Podfile'), (s) => injectPodfileConfigs(s, [...FLAVORS]));
    patch(rel('ios/Runner/Info.plist'), injectInfoPlistDisplayName);
    // Flavour schemes are copies of the base Runner scheme, which stays in place.
    const baseSchemeAbs = join(repo, rel(`${SCHEMES_DIR}/Runner.xcscheme`));
    if (existsSync(baseSchemeAbs)) {
        const base = readFileSync(baseSchemeAbs, 'utf8');
        for (const flavor of FLAVORS) {
            const schemeRel = rel(`${SCHEMES_DIR}/${flavor}.xcscheme`);
            const abs = join(repo, schemeRel);
            if (existsSync(abs))
                continue; // never clobber a hand-tuned scheme
            if (!dry) {
                mkdirSync(dirname(abs), { recursive: true });
                writeFileSync(abs, iosSchemeXml(flavor, base), 'utf8');
            }
            changed.push(schemeRel);
        }
    }
    changed.push(...ensureFlavorDevIconSet(repo, c, log, { dryRun: dry, pbxproj: planned.get(pbxRel) }));
    return changed;
}
/**
 * Every native file wiring the flavours WOULD change or add, repo-relative,
 * without touching any of them — what `apply` prints before it edits a file
 * the user wrote. Empty once the flavours are wired.
 */
export function planFlutterFlavors(repo, c) {
    return [
        ...wireFlutterFlavors(repo, c, () => { }, { dryRun: true }),
        ...writeFlavorIconConfig(repo, c, { dryRun: true }),
    ];
}
/**
 * Why this app already has flavours of its own — or a native project shaped by
 * hand — that launchpad's dev/prod wiring would collide with. Empty for a
 * project `flutter create` made (or one launchpad itself flavoured).
 *
 * Each line is evidence a person can check, never a guess:
 *
 * - an Android `productFlavors`/`flavorDimensions` block that is not
 *   launchpad's own `env` dimension of `dev` + `prod`;
 * - an iOS build configuration beyond Debug/Release/Profile and launchpad's
 *   `-dev`/`-prod` clones (`Release-staging` is somebody's flavour);
 * - a shared scheme beyond `Runner`, `dev` and `prod`;
 * - an iOS target that is neither the app nor its tests — an app extension's
 *   bundle id has to be prefixed by the app's, and the dev flavour only moves
 *   the app's, so its build would fail validation;
 * - `flutter_flavorizr` config, or `lib/main_<flavour>.dart` entry points.
 */
export function ownFlavorEvidence(repo, workdir) {
    const rel = (p) => (workdir === '.' ? p : `${workdir}/${p}`);
    const read = (p) => { try {
        return readFileSync(join(repo, rel(p)), 'utf8');
    }
    catch {
        return '';
    } };
    const out = [];
    for (const f of ['android/app/build.gradle.kts', 'android/app/build.gradle']) {
        const text = read(f);
        const at = /\bproductFlavors\s*\{/.exec(text);
        if (!at && !/\bflavorDimensions\b/.test(text))
            continue;
        // launchpad's own: the `env` dimension holding exactly `dev` and `prod`.
        let ours = false;
        if (at && /flavorDimensions \+= "env"/.test(text)) {
            const open = text.indexOf('{', at.index);
            const block = text.slice(open, matchBrace(text, open, ktSkip) + 1);
            const names = [...block.matchAll(/create\("([^"]+)"\)/g)].map(m => m[1]).sort();
            ours = names.join(',') === 'dev,prod';
        }
        if (!ours)
            out.push(`${rel(f)} already declares productFlavors`);
    }
    const pbx = read('ios/Runner.xcodeproj/project.pbxproj');
    if (pbx) {
        const objects = scanPbxObjects(pbx);
        const stock = new Set(IOS_MODES.flatMap(m => [m, `${m}-dev`, `${m}-prod`]));
        const configs = [...new Set(objects
                .filter(o => /\bisa = XCBuildConfiguration;/.test(o.text))
                .map(o => configName(o.text))
                .filter((n) => !!n))];
        const foreign = configs.filter(n => !stock.has(n));
        if (foreign.length)
            out.push(`${rel('ios/Runner.xcodeproj')} has build configurations of its own (${foreign.slice(0, 4).join(', ')})`);
        const extras = objects
            .filter(o => /\bisa = PBXNativeTarget;/.test(o.text))
            .filter(o => !/productType = "com\.apple\.product-type\.(application|bundle\.unit-test|bundle\.ui-testing)"/.test(o.text))
            .map(o => configName(o.text) ?? (o.comment || o.uuid));
        if (extras.length)
            out.push(`${rel('ios/Runner.xcodeproj')} has targets besides the app and its tests (${extras.slice(0, 4).join(', ')})`);
    }
    const schemes = safeLs(join(repo, rel(SCHEMES_DIR)))
        .filter(f => f.endsWith('.xcscheme'))
        .map(f => f.replace(/\.xcscheme$/, ''))
        .filter(n => !['Runner', ...FLAVORS].includes(n));
    if (schemes.length)
        out.push(`${rel(SCHEMES_DIR)} has schemes of its own (${schemes.slice(0, 4).join(', ')})`);
    if (existsSync(join(repo, rel('flavorizr.yaml'))) || /^flavorizr\s*:/m.test(read('pubspec.yaml'))) {
        out.push(`${rel(existsSync(join(repo, rel('flavorizr.yaml'))) ? 'flavorizr.yaml' : 'pubspec.yaml')} configures flutter_flavorizr`);
    }
    const mains = safeLs(join(repo, rel('lib'))).filter(f => /^main_[a-z0-9_]+\.dart$/i.test(f));
    if (mains.length)
        out.push(`${rel('lib')} has per-flavour entry points (${mains.slice(0, 4).join(', ')})`);
    return out;
}
export function flavorDecision(repo, workdir, surfaces) {
    const knobs = surfaces.map(s => s.config?.flavors);
    if (knobs.includes(false))
        return { wire: false, why: 'explicit', evidence: [] };
    if (knobs.includes(true))
        return { wire: true, why: 'explicit', evidence: [] };
    if (surfaces.some(s => s.status === 'wired'))
        return { wire: true, why: 'wired-before', evidence: [] };
    const evidence = ownFlavorEvidence(repo, workdir);
    return evidence.length ? { wire: false, why: 'own-flavors', evidence } : { wire: true, why: 'fresh', evidence: [] };
}
/** The icon set a Flutter dev flavour names (`flutter_launcher_icons` spells it this way). */
const FLUTTER_DEV_ICON = 'AppIcon-dev';
const FLUTTER_BASE_ICON = 'AppIcon';
/**
 * Every icon set name a project file asks `actool` for — from a `.pbxproj`
 * (`ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon-dev;`) or an xcodegen
 * `project.yml` (`ASSETCATALOG_COMPILER_APPICON_NAME: AppIcon-dev`). A value
 * that is a build-setting reference (`$(…)`) is not a name and is skipped.
 */
export function appIconNamesIn(projectText) {
    const re = /ASSETCATALOG_COMPILER_APPICON_NAME"?\s*[=:]\s*["']?([A-Za-z0-9_.\- ]+?)["']?\s*(?:;|$)/gm;
    const out = new Set();
    for (let m = re.exec(projectText); m; m = re.exec(projectText))
        out.add(m[1].trim());
    return [...out];
}
/**
 * `<catalog>/<name>.appiconset` under a Flutter `ios/` dir, matched
 * case-INsensitively: the macOS runner's filesystem is, so a repo holding both
 * `AppIcon-Dev` and a freshly made `AppIcon-dev` cannot even be checked out
 * there. Looks in every `ios/<dir>/*.xcassets` (Flutter's is
 * `ios/Runner/Assets.xcassets`). Returns the absolute path, or undefined.
 */
function findIconSet(iosDir, name) {
    const want = `${name}.appiconset`.toLowerCase();
    for (const dir of safeLs(iosDir)) {
        for (const cat of safeLs(join(iosDir, dir)).filter((n) => n.endsWith('.xcassets'))) {
            const hit = safeLs(join(iosDir, dir, cat)).find((n) => n.toLowerCase() === want);
            if (hit)
                return join(iosDir, dir, cat, hit);
        }
    }
    return undefined;
}
function safeLs(dir) {
    try {
        return readdirSync(dir).sort();
    }
    catch {
        return [];
    }
}
/**
 * Make the dev icon set the iOS project names, if it does not exist yet.
 *
 * Reads the names out of the project itself — the `.pbxproj` `apply` edited,
 * or an xcodegen `project.yml` — so it repairs a project flavoured before this
 * existed as well as one flavoured now, without touching either file again.
 * For each `<Base>-dev` name with no set, `<Base>.appiconset` is copied beside
 * it: `Contents.json` verbatim (same filenames, same sizes) and every PNG
 * DEV-badged by `badgeDevPng`. A PNG it cannot decode is copied unbadged and
 * said — a dev icon that looks like prod still builds.
 *
 * Never overwrites: an existing set, under any capitalisation, is left exactly
 * as it is — including one `flutter_launcher_icons` rendered — so a second run
 * is a no-op. With no base set to copy there is nothing to make, and `log`
 * names the file and the two ways to fix it rather than letting `actool` be
 * the one to say it.
 *
 * Returns the repo-relative set directories it created.
 */
export function ensureFlavorDevIconSet(repo, c, log = console.log, opts = {}) {
    const rel = (p) => (c.workdir === '.' ? p : `${c.workdir}/${p}`);
    const iosDir = join(repo, rel('ios'));
    // A dry run plans against the pbxproj the wiring WOULD write.
    const projectText = ['ios/Runner.xcodeproj/project.pbxproj', 'ios/project.yml']
        .map((p) => (opts.pbxproj !== undefined && p.endsWith('.pbxproj') ? opts.pbxproj
        : existsSync(join(repo, rel(p))) ? readFileSync(join(repo, rel(p)), 'utf8') : ''))
        .join('\n');
    const wanted = appIconNamesIn(projectText).filter((n) => /-dev$/i.test(n));
    const made = [];
    for (const name of wanted) {
        if (findIconSet(iosDir, name))
            continue; // exists — never touched
        const baseName = name.replace(/-dev$/i, '');
        const base = findIconSet(iosDir, baseName);
        if (!base) {
            log(`  ! ${rel('ios')}: the dev flavour names an \`${name}\` icon set, and there is no`);
            log(`      \`${baseName}.appiconset\` to make it from — a dev iOS build will fail in actool.`);
            log(`      Copy your ${baseName}.appiconset to ${name}.appiconset, or render one with`);
            log('      `dart run flutter_launcher_icons -f flutter_launcher_icons-dev.yaml`.');
            continue;
        }
        const out = join(dirname(base), `${name}.appiconset`);
        if (opts.dryRun) {
            made.push(rel(`ios/${out.slice(iosDir.length + 1).split(/[\\/]/).join('/')}`));
            continue;
        }
        mkdirSync(out, { recursive: true });
        const unbadged = [];
        for (const file of safeLs(base)) {
            const src = join(base, file);
            let bytes;
            try {
                bytes = readFileSync(src);
            }
            catch {
                continue;
            } // a subdirectory — not part of a set
            if (/\.png$/i.test(file)) {
                const badged = badgeDevPng(bytes);
                if (badged)
                    bytes = badged;
                else
                    unbadged.push(file);
            }
            writeFileSync(join(out, file), bytes);
        }
        const outRel = rel(`ios/${out.slice(iosDir.length + 1).split(/[\\/]/).join('/')}`);
        made.push(outRel);
        if (unbadged.length) {
            log(`  ~ ${outRel}: ${unbadged.length} icon(s) copied without the DEV badge (not a PNG this can`);
            log(`      re-encode: ${unbadged.slice(0, 3).join(', ')}${unbadged.length > 3 ? ', …' : ''}). The build is unaffected.`);
        }
    }
    return made;
}
/** Keys whose value is an icon path (`adaptive_icon_background` may be a colour — never touched). */
const ICON_PATH_KEYS = ['image_path', 'image_path_android', 'image_path_ios', 'adaptive_icon_foreground'];
/**
 * Write the dev-flavour `flutter_launcher_icons` config (§5): the pubspec's own
 * block, repointed at the `-dev` icon masters, plus `flavor: dev`. Rendering the
 * badged PNGs is a runbook step (`dart run flutter_launcher_icons -f …`) — this
 * only lands the config, so launchpad stays shell-out free.
 *
 * Returns `[]` (badge skipped) when the app has no `flutter_launcher_icons:`
 * block, and never overwrites an existing dev config.
 */
export function writeFlavorIconConfig(repo, c, opts = {}) {
    const rel = (p) => (c.workdir === '.' ? p : `${c.workdir}/${p}`);
    const pubspecAbs = join(repo, rel('pubspec.yaml'));
    if (!existsSync(pubspecAbs))
        return [];
    let block;
    try {
        const doc = parse(readFileSync(pubspecAbs, 'utf8'));
        const b = doc?.flutter_launcher_icons;
        if (b && typeof b === 'object' && !Array.isArray(b))
            block = { ...b };
    }
    catch {
        return []; // unparseable pubspec — leave the app alone
    }
    if (!block)
        return [];
    const outRel = rel('flutter_launcher_icons-dev.yaml');
    const outAbs = join(repo, outRel);
    if (existsSync(outAbs))
        return []; // idempotent: a written config is never regenerated
    if (opts.dryRun)
        return [outRel];
    for (const key of ICON_PATH_KEYS) {
        const v = block[key];
        if (typeof v === 'string' && v)
            block[key] = devVariantPath(v);
    }
    block.flavor = 'dev';
    const header = [
        '# launchpad — dev flavour icons. Generated once; edit freely (never regenerated).',
        '# Badge the masters, then: dart run flutter_launcher_icons -f flutter_launcher_icons-dev.yaml',
        '',
    ].join('\n');
    mkdirSync(dirname(outAbs), { recursive: true });
    writeFileSync(outAbs, header + stringify({ flutter_launcher_icons: block }), 'utf8');
    return [outRel];
}
/** `assets/icon.png` → `assets/icon-dev.png` (extension-less paths just get the suffix). */
function devVariantPath(p) {
    const slash = p.lastIndexOf('/');
    const dot = p.lastIndexOf('.');
    return dot > slash + 1 ? `${p.slice(0, dot)}-dev${p.slice(dot)}` : `${p}-dev`;
}
/**
 * The Flutter app dirs `apply` should flavour, derived from the wired surfaces.
 *
 * An `ios` surface counts when its config says `framework: flutter`; an
 * `android` surface counts when its workdir holds a `pubspec.yaml`
 * (`AndroidConfig` has no framework field). A pair sharing `apps/mobile`
 * collapses into a single target so the work happens exactly once — with the
 * bundle id taken from whichever surface knows it (the iOS one).
 */
export function flutterFlavorTargets(repo, surfaces) {
    const byWorkdir = new Map();
    for (const s of surfaces) {
        if (!s.config)
            continue;
        let workdir;
        let bundleId = s.bundleId ?? '';
        if (s.archetype === 'ios') {
            const cfg = s.config;
            if (cfg.framework !== 'flutter')
                continue;
            workdir = cfg.workdir;
            bundleId = cfg.bundleId || bundleId;
        }
        else if (s.archetype === 'android') {
            const cfg = s.config;
            const wd = cfg.workdir;
            if (!existsSync(join(repo, wd === '.' ? 'pubspec.yaml' : `${wd}/pubspec.yaml`)))
                continue;
            workdir = wd;
        }
        else
            continue;
        if (workdir == null)
            continue;
        const appName = s.config.appName ?? s.id;
        const existing = byWorkdir.get(workdir);
        if (existing) {
            // Later surfaces only fill in what the first one didn't know.
            if (!existing.config.bundleId && bundleId)
                existing.config.bundleId = bundleId;
            existing.surfaceIds.push(s.id);
            continue;
        }
        byWorkdir.set(workdir, { surfaceId: s.id, config: { workdir, appName, bundleId }, surfaceIds: [s.id] });
    }
    return [...byWorkdir.values()];
}
/**
 * `--dart-define` args for a Fastfile build step. The record maps a define name
 * to the CI environment variable holding its value (defaulting to the same
 * name), and the value is fetched at build time — `ENV.fetch` fails loudly on a
 * missing secret, and nothing sensitive is ever written into the repo. Sorted
 * for deterministic output.
 */
/**
 * The workflow `env:` lines feeding `dartDefineArgs`. The Fastfile does
 * `ENV.fetch("<VAR>")`, which raises KeyError if the workflow never exported it
 * — so the build step MUST carry one line per define. Values come from repo
 * secrets; nothing is ever inlined into the repo.
 *
 * Returns a leading-newline fragment (or '') so it can be appended to the last
 * line of an existing `env:` block.
 */
export function dartDefineEnv(defines) {
    if (!defines)
        return '';
    const keys = Object.keys(defines).sort();
    if (!keys.length)
        return '';
    return '\n' + keys
        .map((k) => `          ${defines[k] || k}: \${{ secrets.${defines[k] || k} }}`)
        .join('\n');
}
export function dartDefineArgs(defines) {
    if (!defines)
        return [];
    return Object.keys(defines)
        .sort()
        .map((k) => `--dart-define=${k}=#{ENV.fetch("${defines[k] || k}")}`);
}
/** The app's current `android:label`, unless it's already the flavour placeholder. */
function currentManifestLabel(manifestAbs) {
    if (!existsSync(manifestAbs))
        return undefined;
    const xml = readFileSync(manifestAbs, 'utf8');
    const appTag = /<application\b[^>]*>/.exec(xml);
    const label = /android:label\s*=\s*"([^"]*)"/.exec(appTag ? appTag[0] : xml)?.[1];
    return label && label !== '${appLabel}' ? label : undefined;
}
/** Skip a double-quoted string starting at `i`; returns the index of its closing quote. */
function skipQuoted(src, i) {
    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') {
            j++;
            continue;
        }
        if (src[j] === '"')
            return j;
    }
    return src.length;
}
/** pbxproj: quoted strings (shellScripts contain `${…}`) and `/* … *\/` comments. */
function pbxSkip(src, i) {
    if (src[i] === '"')
        return skipQuoted(src, i);
    if (src[i] === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        return e < 0 ? src.length : e + 1;
    }
    return i;
}
/**
 * Kotlin DSL: strings (incl. `"${…}"` templates), `//` and `/* … *\/` comments.
 * Exported (with `matchBrace`) for `androidsigning.ts`, the other Kotlin-DSL
 * transform over `android/app/build.gradle.kts`.
 */
export function ktSkip(src, i) {
    if (src[i] === '"')
        return skipQuoted(src, i);
    if (src[i] === '/' && src[i + 1] === '/') {
        const e = src.indexOf('\n', i);
        return e < 0 ? src.length : e - 1;
    }
    if (src[i] === '/' && src[i + 1] === '*') {
        const e = src.indexOf('*/', i + 2);
        return e < 0 ? src.length : e + 1;
    }
    return i;
}
/** Ruby: strings and `#` comments. */
function rubySkip(src, i) {
    if (src[i] === '"' || src[i] === "'") {
        const q = src[i];
        for (let j = i + 1; j < src.length; j++) {
            if (src[j] === '\\') {
                j++;
                continue;
            }
            if (src[j] === q)
                return j;
        }
        return src.length;
    }
    if (src[i] === '#') {
        const e = src.indexOf('\n', i);
        return e < 0 ? src.length : e - 1;
    }
    return i;
}
/** Index of the `}` closing the block whose `{` is at (or after) `open`. */
export function matchBrace(src, open, skip = pbxSkip) {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        const skipped = skip(src, i);
        if (skipped !== i) {
            i = skipped;
            continue;
        }
        if (src[i] === '{')
            depth++;
        else if (src[i] === '}') {
            depth--;
            if (depth === 0)
                return i;
        }
    }
    return src.length - 1;
}
/**
 * Direct children of the pbxproj `objects = { … }` dict. Deliberately shallow:
 * we only need native targets, the project object, build configurations and
 * configuration lists, and nested dicts (e.g. `TargetAttributes`) must not be
 * mistaken for top-level objects.
 */
function scanPbxObjects(src) {
    const objOpen = src.indexOf('objects = {');
    if (objOpen < 0)
        return [];
    const brace = src.indexOf('{', objOpen);
    const objClose = matchBrace(src, brace);
    const entryRe = /^([0-9A-F]{24})(?: \/\* ((?:(?!\*\/)[\s\S])*?) \*\/)? = \{/;
    const out = [];
    let i = brace + 1;
    while (i < objClose) {
        const ch = src[i];
        if (ch === '"' || (ch === '/' && src[i + 1] === '*')) {
            i = pbxSkip(src, i) + 1;
            continue;
        }
        if (/\s/.test(ch) || ch === ';') {
            i++;
            continue;
        }
        const m = entryRe.exec(src.slice(i, i + 240));
        if (m) {
            const open = i + m[0].length - 1;
            const close = matchBrace(src, open);
            let end = close + 1;
            if (src[end] === ';')
                end++;
            out.push({ uuid: m[1], comment: m[2] ?? '', start: i, end, text: src.slice(i, end) });
            i = end;
            continue;
        }
        const nl = src.indexOf('\n', i);
        i = nl < 0 ? objClose : nl + 1;
    }
    return out;
}
function refOf(objText, key) {
    return new RegExp(`\\b${key} = ([0-9A-F]{24})`).exec(objText)?.[1];
}
function listedUuids(listText) {
    const m = /buildConfigurations = \(([\s\S]*?)\);/.exec(listText);
    return m ? (m[1].match(/[0-9A-F]{24}/g) ?? []) : [];
}
function configName(objText) {
    return /\n[ \t]*name = "?([^";\n]+)"?;/.exec(objText)?.[1];
}
function lineIndent(src, at) {
    const start = src.lastIndexOf('\n', at) + 1;
    return src.slice(start, at).match(/^[ \t]*/)?.[0] ?? '';
}
function escapeRe(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function quoted(v) {
    return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
/** Quote a build-setting value the way Xcode would. */
function pbxValue(v) {
    return /^[A-Za-z0-9_.$/]+$/.test(v) ? v : quoted(v);
}
/** Deterministic 24-hex uuid derived from `seed`, guaranteed unused. */
function mintUuid(seed, taken) {
    for (let n = 0;; n++) {
        const uuid = createHash('sha1')
            .update(`launchpad-flavors:${seed}:${n}`)
            .digest('hex')
            .slice(0, 24)
            .toUpperCase();
        if (!taken.has(uuid)) {
            taken.add(uuid);
            return uuid;
        }
    }
}
/** Copy an XCBuildConfiguration object under a new uuid + name. */
function cloneConfig(baseText, uuid, name) {
    return baseText
        .replace(/^[0-9A-F]{24}(?: \/\* (?:(?!\*\/)[\s\S])*? \*\/)? = \{/, `${uuid} /* ${name} */ = {`)
        .replace(/\n([ \t]*)name = [^\n]*;/, (_m, ind) => `\n${ind}name = ${pbxValue(name)};`);
}
/**
 * Set (or replace) one key in an XCBuildConfiguration's `buildSettings` dict,
 * keeping Xcode's alphabetical ordering. `quote` forces quoting for values that
 * are user-facing strings (a display name is quoted even when it's one word, so
 * renaming the app later never changes the quoting).
 */
function setBuildSetting(objText, key, value, opts) {
    const at = objText.indexOf('buildSettings = {');
    if (at < 0)
        return objText;
    const open = objText.indexOf('{', at);
    const close = matchBrace(objText, open);
    const block = objText.slice(open + 1, close);
    const lines = block.split('\n');
    const entryIndent = lines.map((l) => /^([ \t]+)\S/.exec(l)?.[1]).find((x) => !!x) ?? '\t\t\t\t';
    const keyOf = (l) => {
        if (!l.startsWith(entryIndent) || /^\s/.test(l.slice(entryIndent.length)))
            return undefined;
        return /^(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*)) = /.exec(l.slice(entryIndent.length))?.slice(1).find(Boolean);
    };
    const entry = `${entryIndent}${key} = ${opts?.quote ? quoted(value) : pbxValue(value)};`;
    let replaceFrom = -1;
    let replaceTo = -1;
    let insertAt = -1;
    for (let i = 0; i < lines.length; i++) {
        const k = keyOf(lines[i]);
        if (!k)
            continue;
        if (k === key) {
            replaceFrom = i;
            replaceTo = i;
            // Multi-line values (arrays) run until the line that closes them.
            while (replaceTo < lines.length - 1 && !lines[replaceTo].trimEnd().endsWith(';'))
                replaceTo++;
            break;
        }
        if (insertAt < 0 && k > key)
            insertAt = i;
    }
    const next = [...lines];
    if (replaceFrom >= 0)
        next.splice(replaceFrom, replaceTo - replaceFrom + 1, entry);
    else if (insertAt >= 0)
        next.splice(insertAt, 0, entry);
    else
        next.splice(Math.max(lines.length - 1, 1), 0, entry);
    return objText.slice(0, open + 1) + next.join('\n') + objText.slice(close);
}
/** Append the flavoured config uuids to an XCConfigurationList's list. */
function registerConfigs(listText, clones) {
    const m = /buildConfigurations = \(([\s\S]*?)\n([ \t]*)\);/.exec(listText);
    if (!m)
        return listText;
    const closeAt = m.index + m[0].length - `\n${m[2]});`.length;
    const indent = /\n([ \t]+)\S/.exec(m[1])?.[1] ?? `${m[2]}\t`;
    const missing = clones.filter((c) => !listText.includes(c.uuid));
    if (!missing.length)
        return listText;
    const added = missing.map((c) => `\n${indent}${c.uuid} /* ${c.name} */,`).join('');
    return listText.slice(0, closeAt) + added + listText.slice(closeAt);
}
