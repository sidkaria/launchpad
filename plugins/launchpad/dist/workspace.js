import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Finding the packages in a monorepo by asking the monorepo.
 *
 * Detection used to list the **immediate** children of `apps/` and `packages/`
 * and stop. That is one layout out of several, and the one it misses is the
 * standard structure for every Flutter plugin monorepo:
 *
 *   packages/<name>/<name>/
 *   packages/<name>/<name>_android/
 *   packages/<name>/<name>_ios/
 *
 * On the real `fluttercommunity/plus_plugins`, which has twelve packages,
 * exactly two produced surfaces — the two that happen not to be federated — and
 * a buyer with that repository was told confidently about a sixth of it and
 * never learned the rest existed. "Flutter monorepo" is a named case in the
 * launch plan and in the setup skill, so this is not an edge.
 *
 * The fix is to honour the globs the workspace file already declares
 * (`melos.yaml`'s `packages:`, `pnpm-workspace.yaml`'s `packages:`, npm/yarn's
 * `workspaces`), because that is the only definition of "what is in here" that
 * cannot drift from the project's own idea of itself. The old `apps/` +
 * `packages/` scan remains as the fallback for a workspace that declares
 * nothing usable.
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
/** Never walked: enormous, generated, or somebody else's checkout. */
const SKIP = new Set([
    'node_modules', '.git', '.dart_tool', 'build', 'dist', '.next', 'Pods',
    'DerivedData', 'vendor', '.venv', 'target', '.gradle', '.claude', '.worktrees',
]);
/** A directory is a package when it carries a manifest one of our detectors reads. */
const MANIFESTS = ['pubspec.yaml', 'package.json'];
export const isPackageDir = (abs) => MANIFESTS.some(m => existsSync(join(abs, m)));
/**
 * The `packages:` / `workspaces:` list, however this repo spells it.
 *
 * A deliberately small YAML/JSON reader rather than a parse of the whole file:
 * `melos.yaml` and `pnpm-workspace.yaml` both put a flat list of strings under
 * one top-level key, and everything else in those files is irrelevant here.
 */
export function workspaceGlobs(repo) {
    const globs = [];
    for (const file of ['melos.yaml', 'pnpm-workspace.yaml']) {
        const text = read(join(repo, file));
        if (!text)
            continue;
        let inList = false;
        for (const raw of text.split('\n')) {
            if (/^packages\s*:/.test(raw)) {
                inList = true;
                continue;
            }
            if (!inList)
                continue;
            const item = /^\s+-\s*["']?([^"'#\s]+)["']?\s*$/.exec(raw);
            if (item) {
                globs.push(item[1]);
                continue;
            }
            // A non-list line at any indentation ends the block.
            if (raw.trim() && !raw.trim().startsWith('#'))
                break;
        }
    }
    // npm / yarn / bun: `"workspaces": [...]`, or `{ "packages": [...] }`.
    try {
        const pkg = JSON.parse(read(join(repo, 'package.json')));
        const w = pkg.workspaces;
        if (Array.isArray(w))
            globs.push(...w);
        else if (w && Array.isArray(w.packages))
            globs.push(...w.packages);
    }
    catch { /* an unparseable package.json is not this module's problem */ }
    return [...new Set(globs.filter(g => g && !g.startsWith('!')))];
}
/**
 * Expand one glob to the package directories under it, repo-relative.
 *
 * `*` matches a single path segment; `**` matches one or more, which is what
 * `packages/**` in a melos file means and what the federated layout needs.
 * `maxStar` bounds `**` so a deep repository cannot turn detection into a full
 * filesystem walk — three levels covers `packages/<name>/<name>/example`, which
 * is the deepest thing anybody actually nests.
 */
export function expandGlob(repo, glob, maxStar = 3) {
    const parts = glob.split('/').filter(Boolean);
    const out = [];
    const walk = (rel, i, starBudget) => {
        if (i === parts.length) {
            if (rel && isPackageDir(join(repo, rel)))
                out.push(rel);
            return;
        }
        const part = parts[i];
        const children = ls(join(repo, rel))
            .filter(n => !SKIP.has(n) && !n.startsWith('.') && isDir(join(repo, rel, n)));
        if (part === '**') {
            // `**` matches one segment and may match more, up to the budget.
            for (const n of children) {
                const child = rel ? `${rel}/${n}` : n;
                walk(child, i + 1, maxStar);
                if (starBudget > 0)
                    walk(child, i, starBudget - 1);
            }
            return;
        }
        if (part === '*') {
            for (const n of children)
                walk(rel ? `${rel}/${n}` : n, i + 1, starBudget);
            return;
        }
        const child = rel ? `${rel}/${part}` : part;
        if (isDir(join(repo, child)))
            walk(child, i + 1, starBudget);
    };
    walk('', 0, maxStar);
    return out;
}
/** Is this repository a workspace at all? */
export const isWorkspace = (repo) => existsSync(join(repo, 'pnpm-workspace.yaml'))
    || existsSync(join(repo, 'melos.yaml'))
    || /"workspaces"\s*:/.test(read(join(repo, 'package.json')));
/**
 * Every package directory in this workspace, repo-relative and sorted.
 *
 * Falls back to the historical `apps/*` + `packages/*` scan when the workspace
 * declares no usable globs, so a repo that only has a `"workspaces"` key
 * launchpad cannot read behaves exactly as it did before.
 */
export function workspacePackageDirs(repo) {
    if (!isWorkspace(repo))
        return [];
    const globs = workspaceGlobs(repo);
    const found = globs.length
        ? globs.flatMap(g => expandGlob(repo, g))
        : ['apps', 'packages'].flatMap(group => ls(join(repo, group))
            .filter(n => isDir(join(repo, group, n)))
            .map(n => `${group}/${n}`));
    return [...new Set(found)].sort();
}
/**
 * Is this package's `pubspec.yaml` a Flutter PLUGIN rather than an app?
 *
 * A plugin declares `plugin:` under its top-level `flutter:` key. Its `ios/` and
 * `android/` directories hold the platform implementation of a library — there
 * is no app in there to upload to TestFlight, and wiring one a pipeline would
 * be writing a store release for something that ships to pub.dev.
 *
 * Read structurally rather than with one regex, because `plugin:` appears in
 * plenty of pubspecs as a dependency name.
 */
export function isFlutterPlugin(abs) {
    const pubspec = read(join(abs, 'pubspec.yaml'));
    if (!pubspec)
        return false;
    let inFlutter = false;
    for (const raw of pubspec.split('\n')) {
        if (/^flutter\s*:/.test(raw)) {
            inFlutter = true;
            continue;
        }
        if (!inFlutter)
            continue;
        if (/^\S/.test(raw))
            break; // dedented out of the block
        if (/^\s+plugin\s*:/.test(raw))
            return true;
    }
    return false;
}
/** `packages/x/x/example` and friends — a demo harness, not something anyone ships. */
export const isExampleDir = (rel) => rel.split('/').some(seg => seg === 'example' || seg === 'examples');
