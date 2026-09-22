import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Reading a Gradle build well enough to know whether it produces an Android app.
 *
 * The naive question — "does the string `com.android.application` appear in a
 * build file?" — has been the wrong question since AGP 8 (2023). Android
 * Studio's default template declares plugin ids **once**, in
 * `gradle/libs.versions.toml`, and every build file then refers to them through
 * a generated accessor:
 *
 * ```toml
 * # gradle/libs.versions.toml
 * [plugins]
 * android-application = { id = "com.android.application", version.ref = "agp" }
 * ```
 * ```kotlin
 * // app/build.gradle.kts
 * plugins { alias(libs.plugins.android.application) }
 * ```
 *
 * The literal id appears nowhere near the module that uses it. Google's own
 * reference app (`android/sunflower`) is laid out exactly this way, and against
 * it launchpad detected **zero surfaces** and then told the author of an Android
 * app that they had a JVM service to deploy to a server — never asking about
 * release signing or about the upload keystore whose loss is unrecoverable.
 * That is the most expensive detection failure in the product, and it is the
 * modern default project layout, not an exotic one.
 *
 * So: resolve the catalog, and answer the question the build file is actually
 * asking.
 */
const read = (p) => {
    try {
        return readFileSync(p, 'utf8');
    }
    catch {
        return '';
    }
};
const ls = (p) => {
    try {
        return readdirSync(p);
    }
    catch {
        return [];
    }
};
const isDir = (p) => {
    try {
        return statSync(p).isDirectory();
    }
    catch {
        return false;
    }
};
/** The Android Gradle plugin ids that matter, and the difference between them. */
export const ANDROID_APPLICATION_PLUGIN = 'com.android.application';
export const ANDROID_LIBRARY_PLUGIN = 'com.android.library';
/**
 * `[plugins]` entries from every version catalog under `gradle/`.
 *
 * Keyed by the accessor a build file would write — `libs.plugins.android.application`
 * — because that is the form the lookup has to match. Gradle derives it from the
 * catalog's file name (`libs.versions.toml` → `libs`) and turns `-` and `_` in
 * an alias into `.`, which is why `android-application` is reached as
 * `android.application`.
 *
 * Both TOML spellings are accepted, because both appear in real projects:
 *
 *   `alias = { id = "com.x", version.ref = "v" }`   the inline table
 *   `alias = "com.x:1.2.3"`                          the id:version shorthand
 */
export function pluginCatalog(dir) {
    const out = new Map();
    const gradleDir = join(dir, 'gradle');
    for (const name of ls(gradleDir)) {
        if (!name.endsWith('.versions.toml'))
            continue;
        const catalogName = name.slice(0, -'.versions.toml'.length);
        for (const [alias, id] of parsePluginsTable(read(join(gradleDir, name)))) {
            out.set(`${catalogName}.plugins.${alias.replace(/[-_]/g, '.')}`, id);
        }
    }
    return out;
}
/**
 * The `[plugins]` table of one catalog, as alias → plugin id.
 *
 * Hand-rolled rather than a TOML dependency: the product vendors exactly one
 * dependency on purpose, and this needs one table out of a file whose other
 * sections (`[versions]`, `[libraries]`, `[bundles]`) are irrelevant. Sections
 * are matched at the start of a line, so a `[plugins]` inside a string or a
 * comment cannot open one.
 */
export function parsePluginsTable(toml) {
    const out = new Map();
    let inPlugins = false;
    for (const raw of toml.split('\n')) {
        const line = raw.trim();
        if (line.startsWith('#'))
            continue;
        const section = /^\[\s*([A-Za-z0-9_.-]+)\s*\]$/.exec(line);
        if (section) {
            inPlugins = section[1] === 'plugins';
            continue;
        }
        if (!inPlugins)
            continue;
        const entry = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(line);
        if (!entry)
            continue;
        const [, alias, value] = entry;
        // `alias = { id = "com.x", … }`
        const inline = /\bid\s*=\s*["']([^"']+)["']/.exec(value);
        if (inline) {
            out.set(alias, inline[1]);
            continue;
        }
        // `alias = "com.x:1.2.3"` — the shorthand, version after the colon.
        const shorthand = /^["']([^"':]+)(?::[^"']*)?["']\s*$/.exec(value.trim());
        if (shorthand)
            out.set(alias, shorthand[1]);
    }
    return out;
}
/**
 * Does this build file APPLY the given plugin to its own module?
 *
 * Three forms, all of them current:
 *
 *   `plugins { id("com.x") }` / `plugins { id 'com.x' }`   quoted id
 *   `apply plugin: 'com.x'` / `apply(plugin = "com.x")`    the legacy form
 *   `alias(libs.plugins.x)` / `alias libs.plugins.x`        the catalog accessor
 *
 * `apply false` is excluded, and that exclusion is load-bearing rather than
 * tidy. A multi-module project's ROOT build file conventionally declares every
 * plugin its subprojects use:
 *
 * ```kotlin
 * plugins {
 *   alias(libs.plugins.android.application) apply false
 *   alias(libs.plugins.android.library) apply false
 * }
 * ```
 *
 * Counting that as an application module would name the repository root as the
 * app and put the pipeline in the wrong place — and would equally call a
 * library-only repository an app, since the same root declares both.
 */
export function appliesPlugin(buildText, pluginId, catalog) {
    const idPattern = new RegExp(`(^|[^\\w.])${pluginId.replace(/\./g, '\\.')}([^\\w.]|$)`);
    for (const raw of buildText.split('\n')) {
        // A declaration for somebody else's module, not an application of it here.
        if (/\bapply\s+false\b/.test(raw))
            continue;
        const line = raw.replace(/\/\/.*$/, '');
        if (idPattern.test(line))
            return true;
        // Groovy allows the call without parentheses, so both spellings are read.
        for (const m of line.matchAll(/\balias\s*\(\s*([A-Za-z0-9_.]+)\s*\)|\balias\s+([A-Za-z0-9_.]+)/g)) {
            if (catalog.get(m[1] ?? m[2]) === pluginId)
                return true;
        }
    }
    return false;
}
/** Every build file belonging to one module, concatenated. Groovy and Kotlin DSL. */
export const moduleBuildText = (dir, rel) => read(join(dir, rel, 'build.gradle')) + '\n' + read(join(dir, rel, 'build.gradle.kts'));
/** Candidate module directories: the root itself, plus its immediate children. */
export function moduleDirs(dir) {
    return ['', ...ls(dir).filter(n => isDir(join(dir, n)) && !n.startsWith('.'))];
}
/**
 * The module that applies `com.android.application`, or null.
 *
 * `''` means the root is itself the app module (a single-module project).
 */
export function androidAppModule(dir) {
    const catalog = pluginCatalog(dir);
    for (const rel of moduleDirs(dir)) {
        if (appliesPlugin(moduleBuildText(dir, rel), ANDROID_APPLICATION_PLUGIN, catalog))
            return rel;
    }
    return null;
}
/** Does any module apply `com.android.library`? Used only to explain a no-app answer. */
export function hasAndroidLibraryModule(dir) {
    const catalog = pluginCatalog(dir);
    return moduleDirs(dir).some(rel => appliesPlugin(moduleBuildText(dir, rel), ANDROID_LIBRARY_PLUGIN, catalog));
}
/** A bounded grep for a literal string under one directory. */
function containsUnder(dir, rel, needle, maxDepth = 4) {
    const walk = (cur, depth) => {
        if (depth > maxDepth)
            return null;
        for (const name of ls(join(dir, cur))) {
            if (name === 'build' || name === '.gradle' || name.startsWith('.'))
                continue;
            const child = cur ? join(cur, name) : name;
            if (isDir(join(dir, child))) {
                const hit = walk(child, depth + 1);
                if (hit)
                    return hit;
            }
            else if (/\.(gradle|kts|kt|java|toml|properties)$/.test(name)
                && read(join(dir, child)).includes(needle)) {
                return child;
            }
        }
        return null;
    };
    return isDir(join(dir, rel)) ? walk(rel, 0) : null;
}
/**
 * Weaker evidence that this repository is an Android app, for when no module
 * applies the plugin directly.
 *
 * The case this exists for is a **convention plugin**: a large project moves
 * `com.android.application` into a precompiled script plugin under `build-logic/`
 * or `buildSrc/`, and the app module then applies something like
 * `myproject.android.application` — a name launchpad cannot know. Resolving that
 * properly means executing Gradle, which is out of the question here.
 *
 * The alternative is what used to happen: zero surfaces, and an Android author
 * told they have a JVM service. A low-confidence surface that names its own
 * weak evidence is strictly better than that — it keeps the scorecard in
 * Android's terms and the keystore warning on screen — and `apply` refuses to
 * wire a native Gradle pipeline either way, so nothing is mis-generated from it.
 */
export function weakAndroidEvidence(dir) {
    for (const conventions of ['build-logic', 'buildSrc']) {
        const hit = containsUnder(dir, conventions, ANDROID_APPLICATION_PLUGIN);
        if (hit) {
            return `${hit} applies ${ANDROID_APPLICATION_PLUGIN} through a convention plugin; `
                + 'the app module itself could not be identified without running Gradle';
        }
    }
    const manifest = launcherManifest(dir);
    return manifest ? `${manifest} declares a launcher activity` : null;
}
/**
 * An `AndroidManifest.xml` declaring a LAUNCHER activity — i.e. something a user
 * can tap. A library's manifest has no launcher, which is what keeps this from
 * calling every `com.android.library` module an app.
 */
export function launcherManifest(dir, maxDepth = 4) {
    const walk = (cur, depth) => {
        if (depth > maxDepth)
            return null;
        for (const name of ls(join(dir, cur))) {
            if (name === 'build' || name === '.gradle' || name.startsWith('.'))
                continue;
            const child = cur ? join(cur, name) : name;
            if (isDir(join(dir, child))) {
                const hit = walk(child, depth + 1);
                if (hit)
                    return hit;
            }
            else if (name === 'AndroidManifest.xml'
                && /android\.intent\.category\.LAUNCHER/.test(read(join(dir, child)))) {
                return child.replace(/\\/g, '/');
            }
        }
        return null;
    };
    return existsSync(dir) ? walk('', 0) : null;
}
