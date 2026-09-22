import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchBrace, ktSkip } from './flavors.js';
/**
 * Android release signing.
 *
 * `flutter create` ships an `android/app/build.gradle.kts` whose release
 * buildType is signed with the **debug** keystore — unshippable, and silently
 * so. launchpad's Android workflow already materialises the real keystore and
 * writes `android/key.properties` (storeFile/storePassword/keyAlias/keyPassword)
 * in CI; this module closes the last gap by rewriting the Gradle file to USE it.
 *
 * Same house rules as `flavors.ts`: a pure, idempotent text transform that
 * returns its input unchanged whenever the file already has release signing, or
 * has a shape we don't recognise. Re-running `apply` must produce a zero diff.
 */
/** `signingConfigs { … }` in the Kotlin DSL — not the `signingConfigs.getByName(…)` accessor. */
const SIGNING_CONFIGS_BLOCK = /(?:^|[^.\w])signingConfigs\s*\{/g;
const BUILD_TYPES = /\n([ \t]*)buildTypes\s*\{/;
const RELEASE_BUILD_TYPE = /\n([ \t]*)(?:release|getByName\(\s*"release"\s*\)|named\(\s*"release"\s*\))\s*\{/;
const DEBUG_SIGNING = /signingConfig\s*=\s*signingConfigs\.getByName\(\s*"debug"\s*\)/;
const ANY_SIGNING = /(?:^|\n)[ \t]*signingConfig\s*=/;
const RELEASE_SIGNING = 'signingConfig = signingConfigs.getByName("release")';
/**
 * `Properties` has to be imported rather than written out as
 * `java.util.Properties()`. Inside an AGP build script the bare name `java`
 * resolves to the Java plugin extension, which shadows the package: the
 * fully-qualified form fails to compile with "Unresolved reference: util"
 * (verified against a real `./gradlew tasks`). This is the same header the
 * Flutter release-signing docs add.
 */
const PROPERTIES_IMPORT = 'import java.util.Properties';
const HAS_PROPERTIES_IMPORT = /^[ \t]*import\s+java\.util\.Properties[ \t]*$/m;
/**
 * Comments `flutter create` leaves above the debug-keystore line. Once the
 * release config is wired they are actively misleading, so they go with it —
 * unrelated TODOs elsewhere in the file are never touched.
 */
const STALE_COMMENT = /^[ \t]*\/\/\s*(?:TODO:\s*)?(?:Add your own signing config|Signing with the debug keys)\b/i;
/**
 * Wire a real release keystore into an `android/app/build.gradle.kts`:
 *
 *  1. add a `signingConfigs { create("release") { … } }` block that loads
 *     `key.properties` from the **rootProject** dir (i.e. `android/key.properties`,
 *     exactly where the release workflow writes it), tolerating the file being
 *     absent so local builds still configure;
 *  2. repoint the release buildType from the debug keystore at that config, and
 *     drop the now-stale flutter-create comments;
 *  3. add the whole `buildTypes { release { … } }` block if the file has none;
 *  4. add the one `import java.util.Properties` that block needs.
 *
 * The block is emitted immediately *before* `buildTypes` because Gradle
 * evaluates the `android { }` body in order — `signingConfigs.getByName("release")`
 * has to resolve against a config that already exists. That anchor also makes
 * this transform commute with `injectAndroidFlavors`, which inserts after
 * `defaultConfig`: both orders converge on the same file.
 *
 * No-ops (returns the input unchanged) when the app already has its own release
 * signing — either a `create("release")` config, or a release buildType pointing
 * at some other named config. launchpad never clobbers real signing setup.
 */
export function injectAndroidReleaseSigning(kts) {
    if (hasReleaseSigningConfig(kts))
        return kts;
    const androidM = /(^|\n)([ \t]*)android\s*\{/.exec(kts);
    if (!androidM)
        return kts;
    const androidOpen = kts.indexOf('{', androidM.index + androidM[1].length);
    const androidClose = matchBrace(kts, androidOpen, ktSkip);
    const bt = findKtBlock(kts, BUILD_TYPES, androidOpen, androidClose);
    if (!bt) {
        // No buildTypes at all — append both blocks just inside `android { }`.
        const indent = `${androidM[2]}    `;
        const at = kts.lastIndexOf('\n', androidClose);
        const block = `${signingConfigsBlock(indent)}\n\n${buildTypesBlock(indent)}`;
        return addPropertiesImport(`${kts.slice(0, at)}\n\n${block}${kts.slice(at)}`);
    }
    const rel = findKtBlock(kts, RELEASE_BUILD_TYPE, bt.open, bt.close);
    let body;
    if (rel) {
        const inner = kts.slice(rel.open + 1, rel.close);
        // Already signed with something of the app's own — leave the file alone.
        if (ANY_SIGNING.test(inner) && !DEBUG_SIGNING.test(inner))
            return kts;
        body = kts.slice(bt.open + 1, rel.open + 1) + patchReleaseBody(inner, rel.indent) + kts.slice(rel.close, bt.close);
    }
    else {
        // buildTypes exists but has no release block — add one at the end of it.
        const inner = kts.slice(bt.open + 1, bt.close);
        body = addReleaseBuildType(inner, bt.indent);
    }
    // Patch the buildTypes body first (higher offsets), then insert the
    // signingConfigs block at the head of the `buildTypes` line, then the import
    // at the very top (each step only shifts offsets the next one recomputes).
    const out = kts.slice(0, bt.open + 1) + body + kts.slice(bt.close);
    const signed = out.slice(0, bt.lineStart) + signingConfigsBlock(bt.indent) + '\n\n' + out.slice(bt.lineStart);
    return addPropertiesImport(signed);
}
/**
 * Patch the app's `build.gradle.kts` for one Flutter app dir. Kotlin-DSL only:
 * a Groovy `android/app/build.gradle` is skipped rather than corrupted with
 * Kotlin-shaped text (same call as `wireFlutterFlavors`).
 *
 * Returns the repo-relative paths actually changed (empty on a re-run).
 */
export function wireAndroidReleaseSigning(repo, c) {
    const rel = c.workdir === '.'
        ? 'android/app/build.gradle.kts'
        : `${c.workdir}/android/app/build.gradle.kts`;
    const abs = join(repo, rel);
    if (!existsSync(abs))
        return [];
    const orig = readFileSync(abs, 'utf8');
    const next = injectAndroidReleaseSigning(orig);
    if (next === orig)
        return []; // unchanged → don't rewrite, don't report
    writeFileSync(abs, next, 'utf8');
    return [rel];
}
// ─────────────────────────────────────────────────────────────────────── helpers
/** Idempotency guard: a `signingConfigs { … }` block that already declares "release". */
function hasReleaseSigningConfig(kts) {
    const re = new RegExp(SIGNING_CONFIGS_BLOCK.source, 'g');
    for (let m = re.exec(kts); m; m = re.exec(kts)) {
        const open = kts.indexOf('{', m.index);
        if (/create\s*\(\s*"release"\s*\)/.test(kts.slice(open, matchBrace(kts, open, ktSkip))))
            return true;
    }
    return false;
}
/** First block matching `re` (which must start `\n([ \t]*)`) strictly inside (from, until). */
function findKtBlock(src, re, from, until) {
    const r = new RegExp(re.source, 'g');
    r.lastIndex = from;
    const m = r.exec(src);
    if (!m || m.index >= until)
        return undefined;
    const open = src.indexOf('{', m.index);
    return { lineStart: m.index + 1, indent: m[1], open, close: matchBrace(src, open, ktSkip) };
}
/** The text between a release buildType's braces, repointed at the release config. */
function patchReleaseBody(inner, indent) {
    const lines = inner.split('\n').filter((l) => !STALE_COMMENT.test(l));
    let done = false;
    const next = lines.map((l) => {
        if (!DEBUG_SIGNING.test(l))
            return l;
        done = true;
        return l.replace(DEBUG_SIGNING, RELEASE_SIGNING);
    });
    if (done)
        return next.join('\n');
    // No signingConfig of any kind — add the assignment as the block's last entry.
    const entryIndent = firstIndent(next) ?? `${indent}    `;
    if (next.length < 2)
        return `\n${entryIndent}${RELEASE_SIGNING}\n${indent}`;
    next.splice(next.length - 1, 0, `${entryIndent}${RELEASE_SIGNING}`);
    return next.join('\n');
}
/** The text between `buildTypes`' braces, with a release block appended. */
function addReleaseBuildType(inner, indent) {
    const i1 = `${indent}    `;
    const block = [`${i1}release {`, `${i1}    ${RELEASE_SIGNING}`, `${i1}}`].join('\n');
    const lines = inner.split('\n');
    if (lines.length < 2)
        return `\n${block}\n${indent}`;
    lines.splice(lines.length - 1, 0, block);
    return lines.join('\n');
}
/** Add `import java.util.Properties` at the top of the script, once. */
function addPropertiesImport(kts) {
    if (HAS_PROPERTIES_IMPORT.test(kts))
        return kts;
    const at = firstStatementStart(kts);
    const rest = kts.slice(at);
    // Sit flush against an existing import list; otherwise leave a blank line
    // before `plugins { }` (imports must precede every statement in a .kts).
    return `${kts.slice(0, at)}${PROPERTIES_IMPORT}\n${rest.startsWith('import ') ? '' : '\n'}${rest}`;
}
/** Offset of the first line that starts real code — leading comments stay on top. */
function firstStatementStart(kts) {
    let at = 0;
    let inComment = false;
    for (const line of kts.split('\n')) {
        const t = line.trim();
        if (inComment)
            inComment = !t.includes('*/');
        else if (t.startsWith('/*'))
            inComment = !t.includes('*/');
        else if (t !== '' && !t.startsWith('//'))
            return at;
        at += line.length + 1;
    }
    return 0; // nothing but comments — unreachable once an `android { }` block was found
}
function firstIndent(lines) {
    for (const l of lines.slice(0, -1)) {
        const m = /^([ \t]*)\S/.exec(l);
        if (m)
            return m[1];
    }
    return undefined;
}
/**
 * `file(it)` resolves storeFile against the `app` module, matching the
 * workflow's `storeFile=upload-keystore.jks` next to the .jks it decodes into
 * `android/app/`. Nothing secret is ever written into the repo — the values all
 * come from the CI-materialized `key.properties`, and a missing file just leaves
 * them null so local/dev builds still configure.
 */
function signingConfigsBlock(i1) {
    const i2 = i1.repeat(2);
    const i3 = i1.repeat(3);
    const i4 = i1.repeat(4);
    return [
        `${i1}signingConfigs {`,
        `${i2}create("release") {`,
        `${i3}val keyProps = Properties()`,
        `${i3}val keyPropsFile = rootProject.file("key.properties")`,
        `${i3}if (keyPropsFile.exists()) {`,
        `${i4}keyPropsFile.inputStream().use { keyProps.load(it) }`,
        `${i3}}`,
        `${i3}keyAlias = keyProps.getProperty("keyAlias")`,
        `${i3}keyPassword = keyProps.getProperty("keyPassword")`,
        `${i3}storeFile = keyProps.getProperty("storeFile")?.let { file(it) }`,
        `${i3}storePassword = keyProps.getProperty("storePassword")`,
        `${i2}}`,
        `${i1}}`,
    ].join('\n');
}
function buildTypesBlock(i1) {
    return [
        `${i1}buildTypes {`,
        `${i1.repeat(2)}release {`,
        `${i1.repeat(3)}${RELEASE_SIGNING}`,
        `${i1.repeat(2)}}`,
        `${i1}}`,
    ].join('\n');
}
