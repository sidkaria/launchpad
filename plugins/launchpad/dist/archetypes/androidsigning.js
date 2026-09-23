import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { matchBrace, ktSkip } from './flavors.js';
import { androidFramework } from './android.js';
import { gradleDir, isGradleFramework, moduleOutDir } from './androidgradle.js';
/** `signingConfigs { … }` — not the `signingConfigs.getByName(…)` accessor. */
const SIGNING_CONFIGS_BLOCK = /(?:^|[^.\w])signingConfigs\s*\{/g;
const BUILD_TYPES = /\n([ \t]*)buildTypes\s*\{/;
const RELEASE_BUILD_TYPE = /\n([ \t]*)(?:release|getByName\(\s*["']release["']\s*\)|named\(\s*["']release["']\s*\))\s*\{/;
const DEFAULT_CONFIG = /\n([ \t]*)defaultConfig\s*\{/;
const DEBUG_SIGNING = /signingConfig\s*=?\s*signingConfigs\.(?:getByName\(\s*["']debug["']\s*\)|debug)/;
const ANY_SIGNING = /(?:^|\n)[ \t]*signingConfig\s*[=\s]/;
/**
 * The release-signing assignment, per DSL.
 *
 * `takeIf { it.storeFile != null }` (and its Groovy ternary) is the whole point
 * — see the module header. Without it a repo with no `key.properties` cannot
 * configure a release build at all.
 */
const releaseSigningAssignment = (dsl) => dsl === 'kotlin'
    ? 'signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null }'
    : 'signingConfig = signingConfigs.release.storeFile != null ? signingConfigs.release : null';
const RELEASE_SIGNING_MARK = /signingConfigs\.(?:getByName\(\s*["']release["']\s*\)|release)/;
/**
 * `Properties` has to be imported rather than written out as
 * `java.util.Properties()`. Inside an AGP Kotlin build script the bare name
 * `java` resolves to the Java plugin extension, which shadows the package: the
 * fully-qualified form fails to compile with "Unresolved reference: util"
 * (verified against a real `./gradlew tasks`). This is the same header the
 * Flutter release-signing docs add. Groovy needs no import — `java.util` is
 * auto-imported there — which is why this is Kotlin-only.
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
 * Groovy: strings in BOTH quote styles, plus the comment forms `ktSkip` knows.
 *
 * Reusing `ktSkip` on Groovy would be a real bug rather than a rough edge: a
 * single-quoted Groovy string containing a brace — `exclude '**\/{a,b}'`, which
 * is ordinary in a packaging block — would desynchronise brace matching and
 * this transform would splice its output into the middle of a string.
 */
export function groovySkip(src, i) {
    if (src[i] === "'") {
        for (let j = i + 1; j < src.length; j++) {
            if (src[j] === '\\') {
                j++;
                continue;
            }
            if (src[j] === "'")
                return j;
        }
        return src.length;
    }
    return ktSkip(src, i);
}
const skipperFor = (dsl) => (dsl === 'groovy' ? groovySkip : ktSkip);
/** Which DSL a build file is written in, from its name. */
export const dslOf = (relPath) => (relPath.endsWith('.kts') ? 'kotlin' : 'groovy');
/**
 * Wire a real release keystore into an app module's build file:
 *
 *  1. add a `signingConfigs` block declaring `release`, loading
 *     `key.properties` from the **rootProject** dir (i.e. right where the
 *     release workflow writes it), tolerating the file being absent so local
 *     builds still configure;
 *  2. repoint the release buildType at that config — conditionally, so a build
 *     without the keystore is unsigned rather than broken — and drop the
 *     now-stale flutter-create comments;
 *  3. add the whole `buildTypes { release { … } }` block if the file has none;
 *  4. add the one `import java.util.Properties` a Kotlin script needs.
 *
 * The block is emitted immediately *before* `buildTypes` because Gradle
 * evaluates the `android { }` body in order — the release buildType's reference
 * has to resolve against a config that already exists. That anchor also makes
 * this transform commute with `injectAndroidFlavors`, which inserts after
 * `defaultConfig`: both orders converge on the same file.
 *
 * No-ops (returns the input unchanged) when the app already has its own release
 * signing — either a `release` signing config, or a release buildType pointing
 * at some other named config. launchpad never clobbers real signing setup.
 */
export function injectAndroidReleaseSigning(text, dsl = 'kotlin') {
    if (hasReleaseSigningConfig(text, dsl))
        return text;
    const skip = skipperFor(dsl);
    const androidM = /(^|\n)([ \t]*)android\s*\{/.exec(text);
    if (!androidM)
        return text;
    const androidOpen = text.indexOf('{', androidM.index + androidM[1].length);
    const androidClose = matchBrace(text, androidOpen, skip);
    const bt = findBlock(text, BUILD_TYPES, androidOpen, androidClose, skip);
    if (!bt) {
        // No buildTypes at all — append both blocks just inside `android { }`.
        const indent = `${androidM[2]}    `;
        const at = text.lastIndexOf('\n', androidClose);
        const block = `${signingConfigsBlock(indent, dsl)}\n\n${buildTypesBlock(indent, dsl)}`;
        return addPropertiesImport(`${text.slice(0, at)}\n\n${block}${text.slice(at)}`, dsl);
    }
    const rel = findBlock(text, RELEASE_BUILD_TYPE, bt.open, bt.close, skip);
    let body;
    if (rel) {
        const inner = text.slice(rel.open + 1, rel.close);
        // Already signed with something of the app's own — leave the file alone.
        if (ANY_SIGNING.test(inner) && !DEBUG_SIGNING.test(inner))
            return text;
        body = text.slice(bt.open + 1, rel.open + 1)
            + patchReleaseBody(inner, rel.indent, dsl)
            + text.slice(rel.close, bt.close);
    }
    else {
        // buildTypes exists but has no release block — add one at the end of it.
        body = addReleaseBuildType(text.slice(bt.open + 1, bt.close), bt.indent, dsl);
    }
    // Patch the buildTypes body first (higher offsets), then insert the
    // signingConfigs block at the head of the `buildTypes` line, then the import
    // at the very top (each step only shifts offsets the next one recomputes).
    const out = text.slice(0, bt.open + 1) + body + text.slice(bt.close);
    const signed = out.slice(0, bt.lineStart) + signingConfigsBlock(bt.indent, dsl) + '\n\n' + out.slice(bt.lineStart);
    return addPropertiesImport(signed, dsl);
}
/**
 * Let CI set the release `versionCode` without the developer doing anything.
 *
 * Every upload to Play needs a versionCode strictly higher than the last, and
 * Firebase App Distribution shows the number to testers, so a repo whose
 * `defaultConfig` says `versionCode = 1` forever ships every build as version 1
 * — which reads as "nothing changed" and, on Play, is a hard rejection.
 *
 * The injected line reads a Gradle **project property**, which is inert unless
 * something passes it: a local `./gradlew assembleRelease` is byte-identical to
 * what it was, and the generated workflow passes
 * `-PlaunchpadVersionCode=$(git rev-list --count HEAD)` — monotonic by
 * construction and stable across re-runs of the same commit.
 *
 * It is deliberately NOT a rewrite of the developer's own `versionCode`: their
 * value stays in the file, stays authoritative everywhere except CI, and is
 * what a reader sees. No-op when there is no `defaultConfig` block to add it
 * to, or when it is already there.
 */
export function injectAndroidVersionCode(text, dsl = 'kotlin') {
    if (text.includes(VERSION_CODE_PROPERTY))
        return text;
    const skip = skipperFor(dsl);
    const androidM = /(^|\n)([ \t]*)android\s*\{/.exec(text);
    if (!androidM)
        return text;
    const androidOpen = text.indexOf('{', androidM.index + androidM[1].length);
    const dc = findBlock(text, DEFAULT_CONFIG, androidOpen, matchBrace(text, androidOpen, skip), skip);
    if (!dc)
        return text;
    // The block's OWN entry indentation, not the header's plus a guess. Android
    // Studio's template indents by four and Google's own samples by two, and a
    // line that does not line up with its neighbours reads as something a tool
    // did TO the file rather than something that belongs in it.
    const i1 = firstIndent(text.slice(dc.open + 1, dc.close).split('\n')) ?? `${dc.indent}    `;
    const lines = [
        '',
        `${i1}// launchpad: CI passes -P${VERSION_CODE_PROPERTY}=<commit count> so every`,
        `${i1}// upload has a higher version code than the last. Unset locally, where the`,
        `${i1}// value above stands.`,
        ...(dsl === 'kotlin'
            ? [`${i1}(findProperty("${VERSION_CODE_PROPERTY}") as String?)?.let { versionCode = it.toInt() }`]
            : [`${i1}if (project.hasProperty('${VERSION_CODE_PROPERTY}')) { versionCode = project.property('${VERSION_CODE_PROPERTY}').toInteger() }`]),
    ].join('\n');
    const at = text.lastIndexOf('\n', dc.close);
    return text.slice(0, at) + lines + text.slice(at);
}
/** The Gradle project property both halves agree on. */
export const VERSION_CODE_PROPERTY = 'launchpadVersionCode';
/**
 * The app module's build file, repo-relative, or null when there is none.
 *
 * Flutter's is always `<workdir>/android/app/build.gradle.kts`, because that is
 * what `flutter create` writes. Everything else is wherever `gradle.ts` found
 * the module that applies `com.android.application`, in whichever DSL that
 * module happens to use — so both spellings are tried and the one on disk wins.
 */
export function appBuildFile(repo, c) {
    const framework = androidFramework(c);
    const candidates = [];
    if (isGradleFramework(framework)) {
        const dir = gradleDir(c);
        const prefix = dir === '.' ? '' : `${dir}/`;
        // `moduleOutDir` already knows how to turn `:a:b` into a directory path.
        const moduleDir = moduleOutDir(c.appModule).replace(/\/?build\/outputs$/, '');
        const base = moduleDir ? `${prefix}${moduleDir}/` : prefix;
        candidates.push(`${base}build.gradle.kts`, `${base}build.gradle`);
    }
    else {
        const base = c.workdir === '.' || !c.workdir ? '' : `${c.workdir}/`;
        candidates.push(`${base}android/app/build.gradle.kts`, `${base}android/app/build.gradle`);
    }
    return candidates.find(rel => existsSync(join(repo, rel))) ?? null;
}
/**
 * Does the app already declare its own release signing, so launchpad left it
 * alone? Returns the build file that does, or null.
 *
 * This is reported rather than just obeyed, and the reason is a real
 * repository. A pinned bare-React-Native template declares
 * `signingConfigs { release {} }` — an EMPTY config its own fastlane lanes fill
 * in from the environment — and a release buildType pointing at it. launchpad
 * correctly refuses to touch that (it never clobbers real signing setup), and
 * then just as correctly writes a workflow that materialises the keystore and
 * `key.properties`… which that config does not read.
 *
 * Both halves are right and the combination is a silent mis-wire: the buyer
 * stores four secrets, watches them be decoded, and gets an unsigned build
 * anyway with nothing anywhere connecting the two facts. Saying it once, at
 * the moment `apply` makes the choice, is the whole fix.
 */
export function ownReleaseSigning(repo, c) {
    const rel = appBuildFile(repo, c);
    if (!rel)
        return null;
    const text = readFileSync(join(repo, rel), 'utf8');
    const dsl = dslOf(rel);
    if (!hasReleaseSigningConfig(text, dsl))
        return null;
    // Ours, from a previous `apply` — that one reads key.properties by
    // construction, so there is nothing to warn about.
    if (text.includes('key.properties'))
        return null;
    return { path: rel, verdict: releaseSigning(text, dsl) };
}
/**
 * Patch the app module's build file: release signing, and the CI version-code
 * hook. Returns the repo-relative paths actually changed (empty on a re-run).
 */
export function wireAndroidReleaseSigning(repo, c) {
    const rel = appBuildFile(repo, c);
    if (!rel)
        return [];
    const abs = join(repo, rel);
    const dsl = dslOf(rel);
    const orig = readFileSync(abs, 'utf8');
    let next = injectAndroidReleaseSigning(orig, dsl);
    // Only the Gradle path passes a version code; a Flutter build number comes
    // from the Fastfile's `--build-number`, so injecting here would be a second,
    // silently competing source for the same number.
    if (isGradleFramework(androidFramework(c)))
        next = injectAndroidVersionCode(next, dsl);
    if (next === orig)
        return []; // unchanged → don't rewrite, don't report
    writeFileSync(abs, next, 'utf8');
    return [rel];
}
// ─────────────────────────────────────────────────────────────────────── helpers
/** Idempotency guard: a `signingConfigs { … }` block that already declares release. */
function hasReleaseSigningConfig(text, dsl) {
    const skip = skipperFor(dsl);
    const declares = dsl === 'kotlin'
        ? /create\s*\(\s*"release"\s*\)/
        : /(?:^|\n)[ \t]*release\s*\{|create\s*\(\s*['"]release['"]\s*\)/;
    const re = new RegExp(SIGNING_CONFIGS_BLOCK.source, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const open = text.indexOf('{', m.index);
        if (declares.test(text.slice(open, matchBrace(text, open, skip))))
            return true;
    }
    return false;
}
/** First block matching `re` (which must start `\n([ \t]*)`) strictly inside (from, until). */
function findBlock(src, re, from, until, skip) {
    const r = new RegExp(re.source, 'g');
    r.lastIndex = from;
    const m = r.exec(src);
    if (!m || m.index >= until)
        return undefined;
    const open = src.indexOf('{', m.index);
    return { lineStart: m.index + 1, indent: m[1], open, close: matchBrace(src, open, skip) };
}
/** The text between a release buildType's braces, repointed at the release config. */
function patchReleaseBody(inner, indent, dsl) {
    const assignment = releaseSigningAssignment(dsl);
    const lines = inner.split('\n').filter((l) => !STALE_COMMENT.test(l));
    let done = false;
    const next = lines.map((l) => {
        if (!DEBUG_SIGNING.test(l))
            return l;
        done = true;
        return l.replace(/signingConfig\s*=?\s*signingConfigs\.(?:getByName\(\s*["']debug["']\s*\)|debug)/, assignment);
    });
    if (done)
        return next.join('\n');
    // No signingConfig of any kind — add the assignment as the block's last entry.
    const entryIndent = firstIndent(next) ?? `${indent}    `;
    if (next.length < 2)
        return `\n${entryIndent}${assignment}\n${indent}`;
    next.splice(next.length - 1, 0, `${entryIndent}${assignment}`);
    return next.join('\n');
}
/** The text between `buildTypes`' braces, with a release block appended. */
function addReleaseBuildType(inner, indent, dsl) {
    const i1 = `${indent}    `;
    const block = [`${i1}release {`, `${i1}    ${releaseSigningAssignment(dsl)}`, `${i1}}`].join('\n');
    const lines = inner.split('\n');
    if (lines.length < 2)
        return `\n${block}\n${indent}`;
    lines.splice(lines.length - 1, 0, block);
    return lines.join('\n');
}
/** Add `import java.util.Properties` at the top of a Kotlin script, once. */
function addPropertiesImport(text, dsl) {
    if (dsl !== 'kotlin')
        return text;
    if (HAS_PROPERTIES_IMPORT.test(text))
        return text;
    const at = firstStatementStart(text);
    const rest = text.slice(at);
    // Sit flush against an existing import list; otherwise leave a blank line
    // before `plugins { }` (imports must precede every statement in a .kts).
    return `${text.slice(0, at)}${PROPERTIES_IMPORT}\n${rest.startsWith('import ') ? '' : '\n'}${rest}`;
}
/** Offset of the first line that starts real code — leading comments stay on top. */
function firstStatementStart(text) {
    let at = 0;
    let inComment = false;
    for (const line of text.split('\n')) {
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
 * `file(it)` resolves storeFile against the module this file belongs to,
 * matching the workflow's `storeFile=upload-keystore.jks` next to the .jks it
 * decodes into that module's directory. Nothing secret is ever written into the
 * repo — the values all come from the CI-materialized `key.properties`, and a
 * missing file just leaves them null so local and dev builds still configure.
 */
function signingConfigsBlock(i1, dsl) {
    const i2 = i1.repeat(2);
    const i3 = i1.repeat(3);
    const i4 = i1.repeat(4);
    if (dsl === 'kotlin') {
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
    return [
        `${i1}signingConfigs {`,
        `${i2}release {`,
        `${i3}def keyProps = new Properties()`,
        `${i3}def keyPropsFile = rootProject.file('key.properties')`,
        `${i3}if (keyPropsFile.exists()) {`,
        `${i4}keyPropsFile.withInputStream { keyProps.load(it) }`,
        `${i3}}`,
        `${i3}keyAlias = keyProps.getProperty('keyAlias')`,
        `${i3}keyPassword = keyProps.getProperty('keyPassword')`,
        `${i3}storeFile = keyProps.getProperty('storeFile') ? file(keyProps.getProperty('storeFile')) : null`,
        `${i3}storePassword = keyProps.getProperty('storePassword')`,
        `${i2}}`,
        `${i1}}`,
    ].join('\n');
}
function buildTypesBlock(i1, dsl) {
    return [
        `${i1}buildTypes {`,
        `${i1.repeat(2)}release {`,
        `${i1.repeat(3)}${releaseSigningAssignment(dsl)}`,
        `${i1.repeat(2)}}`,
        `${i1}}`,
    ].join('\n');
}
/**
 * Read the release buildType and answer what actually signs it.
 *
 * The scorecard used to ask this with `/signingConfigs[\s\S]*release/`, and the
 * only reason that never produced a false pass is that it was reading the wrong
 * file and getting `''`. Pointed at a real one it is catastrophic: Google's own
 * `sunflower` contains the word `signingConfigs` (in a *benchmark* buildType,
 * assigning the **debug** keystore) and the word `release` further down, so the
 * regex matched and the scorecard reported "Android release is signed with a
 * real key — ok" about an app whose release build is not signed at all.
 *
 * That is a false pass on a check marked critical, about the single trap
 * PLAYBOOK §3 opens with. `CLAUDE.md`: a false pass is worse than a false gap.
 *
 * So: find the release buildType, read its `signingConfig`, and answer from
 * that. `declared` rather than `signed` when the named config sets no store
 * file, because a config somebody else fills in at build time is evidence of
 * intent, not of an outcome — and config-shaped evidence grades `unknown`.
 */
export function releaseSigning(text, dsl = 'kotlin') {
    const skip = skipperFor(dsl);
    const androidM = /(^|\n)([ \t]*)android\s*\{/.exec(text);
    if (!androidM)
        return 'none';
    const androidOpen = text.indexOf('{', androidM.index + androidM[1].length);
    const androidClose = matchBrace(text, androidOpen, skip);
    const bt = findBlock(text, BUILD_TYPES, androidOpen, androidClose, skip);
    if (!bt)
        return 'none';
    const rel = findBlock(text, RELEASE_BUILD_TYPE, bt.open, bt.close, skip);
    if (!rel)
        return 'none';
    const inner = text.slice(rel.open + 1, rel.close);
    if (!ANY_SIGNING.test(inner) && !/\bsigningConfig\b/.test(inner))
        return 'none';
    if (DEBUG_SIGNING.test(inner))
        return 'none';
    // It points at a named config. Which one, and does that config resolve a
    // store file anywhere?
    const named = /signingConfigs\.(?:getByName\(\s*["']([A-Za-z0-9_]+)["']\s*\)|([A-Za-z0-9_]+))/.exec(inner);
    const name = named?.[1] ?? named?.[2];
    if (!name)
        return 'declared';
    const re = new RegExp(SIGNING_CONFIGS_BLOCK.source, 'g');
    for (let m = re.exec(text); m; m = re.exec(text)) {
        const open = text.indexOf('{', m.index);
        const body = text.slice(open, matchBrace(text, open, skip));
        const decl = new RegExp(`(?:create\\s*\\(\\s*["']${name}["']\\s*\\)|(?:^|\\n)[ \\t]*${name})\\s*\\{`);
        const at = decl.exec(body);
        if (!at)
            continue;
        const cfgOpen = body.indexOf('{', at.index + at[0].length - 1);
        const cfgBody = body.slice(cfgOpen, matchBrace(body, cfgOpen, skip));
        return /\bstoreFile\b\s*[=\s]/.test(cfgBody) ? 'signed' : 'declared';
    }
    // Named but never declared in this file — a convention plugin or a sibling
    // script may declare it. Not observable here.
    return 'declared';
}
