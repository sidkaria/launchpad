import { existsSync, readdirSync, watch } from 'node:fs';
import { join } from 'node:path';
/**
 * What the live channel watches, and — the part that took a finding to learn —
 * what it does not.
 *
 * `stream()` used to register exactly two watchers per project: `<home>/
 * .launchpad` and `<project>/.launchpad`. Everything the scorecard actually
 * reads lives outside both of them: a privacy policy, a `.gitignore`, a
 * workflow under `.github/`, an app icon, a dependency in `package.json`. So a
 * change to the repository reached the screen only on the 15-second floor tick,
 * at an arbitrary phase between 0 and 15 seconds (L3 measured 12,739ms), while
 * a change under `.launchpad/` arrived in 402ms.
 *
 * That is worse than a latency nit, because the product's hero recording is
 * "cells flip green one by one" and eight of the replay's ten beats are outside
 * `.launchpad/` — so the take landed in clumps whenever the timer happened to
 * fire.
 *
 * ## The shape of the fix
 *
 * Watching `<project>` recursively is the obvious answer and it is half of one.
 * `fs.watch(dir, { recursive: true })` is a kernel subscription on macOS
 * (FSEvents) and Windows (ReadDirectoryChangesW), but on Linux it is inotify
 * plus a walk — so pointing it at a repository with a 300MB `node_modules`, a
 * Flutter `build/` and a `Pods/` costs thousands of watch descriptors to learn
 * about files whose contents can never change an answer.
 *
 * So the arming is deliberately two-level:
 *
 * 1. the repository root, **non-recursively** — which is what notices a new
 *    `PRIVACY.md`, `LICENSE` or `package.json` appearing at the top;
 * 2. every top-level directory that is not in `WATCH_IGNORED`, recursively.
 *
 * The heavy generated trees are therefore never subscribed to at all, on any
 * platform, rather than subscribed to and then filtered. `watchWorthy()` still
 * filters every event, because a monorepo has a nested `apps/web/node_modules`
 * that the top-level exclusion cannot reach.
 *
 * ## Why this list is safe
 *
 * It is the same set `scorecard.ts`, `assets.ts` and `workspace.ts` already
 * refuse to walk. That is not a coincidence to be maintained by hand — it is
 * the argument for correctness: **a directory the scorecard never reads cannot
 * hold a file whose change alters a grade**, so declining to watch it cannot
 * make the screen wrong. Anything added to those lists belongs here, and
 * anything here that they would walk is a bug.
 *
 * `.git` is the one exception in both directions. The scorecard skips it, but
 * `git.ts` reads `.git/refs` for the newest tag and the head commit — which is
 * what "what's live where" renders and what the replay's last beat moves. So
 * `.git` is not watched wholesale (it churns on every command: `index.lock`,
 * `ORIG_HEAD`, loose objects) and `.git/refs` is watched precisely, with the
 * `.git` root itself filtered down to the three names that matter.
 */
export const WATCH_IGNORED = new Set([
    // The three lists in scorecard.ts / assets.ts / workspace.ts, unioned.
    'node_modules', '.git', 'build', 'dist', '.next', '.dart_tool', 'Pods',
    'DerivedData', 'vendor', '.venv', 'target', '.gradle', 'coverage',
    '.claude', '.worktrees',
    // Generated trees those lists do not name because they never contain a file
    // a detector looks for either, and which churn hard while a dev server runs.
    '.turbo', '.cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.output',
    '.angular', '.expo', '.terraform', '.tox', '.mypy_cache', '.pytest_cache',
    '__pycache__', 'bower_components', 'Carthage', '.pnpm-store', '.yarn',
    'out', '.astro', '.vercel', '.netlify', '.serverless', '.nyc_output',
]);
/** The `.git` entries `git.ts` actually reads. Everything else there is churn. */
const GIT_WATCHED = new Set(['HEAD', 'packed-refs', 'refs']);
/**
 * How many directories one connection will subscribe to before it stops.
 *
 * A ceiling rather than a promise: a fleet of thirty monorepos is a real shape,
 * and exhausting the process's file descriptors would take the whole dashboard
 * down to make one panel live. When it is hit the floor tick is still running,
 * and the stream says so.
 */
export const WATCH_LIMIT = 512;
const segments = (rel) => rel.split(/[\\/]/).filter(Boolean);
/**
 * Is this event worth re-reading the fleet for?
 *
 * A `null` filename means the platform could not say which file moved, and the
 * safe answer to "something changed, I cannot tell you what" is to look.
 */
export function watchWorthy(rel) {
    if (rel == null || rel === '')
        return true;
    return !segments(rel).some(seg => WATCH_IGNORED.has(seg));
}
/** The same question for an event on the `.git` directory itself. */
export function gitWorthy(rel) {
    if (rel == null || rel === '')
        return true;
    const first = segments(rel)[0];
    return first !== undefined && GIT_WATCHED.has(first);
}
/** Top-level directories of a repo that are worth a recursive subscription. */
export function watchableDirs(repo) {
    let entries;
    try {
        entries = readdirSync(repo, { withFileTypes: true });
    }
    catch {
        return [];
    }
    return entries
        // `isDirectory()` is false for a symlink, which is the answer we want: a
        // link into another tree would either duplicate a watch or make a loop.
        .filter(e => e.isDirectory() && !WATCH_IGNORED.has(e.name))
        .map(e => join(repo, e.name))
        .sort();
}
/**
 * Watch a whole fleet, one connection's worth.
 *
 * `projects` is a function rather than an array because the registry changes
 * while a page is open — `--replay` adds six projects to it on a timer, and the
 * dashboard's own add button writes it — and a watcher set that was decided at
 * connection time is a watcher set that goes stale in exactly the demo the
 * feature exists for.
 */
export function watchFleet(opts) {
    const limit = opts.limit ?? WATCH_LIMIT;
    const watchers = new Map();
    const refused = [];
    let capped = false;
    const subscribe = (dir, recursive, worthy) => {
        if (watchers.has(dir))
            return;
        if (watchers.size >= limit) {
            capped = true;
            return;
        }
        if (!existsSync(dir))
            return;
        try {
            const w = watch(dir, { recursive }, (_event, name) => {
                if (worthy(name === null ? null : String(name)))
                    opts.onChange();
            });
            // A watched directory can be deleted under us — `adversarial` does
            // exactly that. An unhandled 'error' on an FSWatcher is an uncaught
            // exception, which would take the server down to report a directory
            // that no longer matters.
            w.on('error', () => { try {
                w.close();
            }
            catch { /* already gone */ } watchers.delete(dir); });
            watchers.set(dir, w);
        }
        catch {
            // Some network and container filesystems refuse to watch at all. That is
            // what the floor tick is for, and it is what `notice()` reports.
            if (!refused.includes(dir))
                refused.push(dir);
        }
    };
    const arm = () => {
        subscribe(join(opts.home, '.launchpad'), true, watchWorthy);
        for (const repo of opts.projects()) {
            if (!existsSync(repo))
                continue;
            // The root, shallow: this is what sees a new PRIVACY.md.
            subscribe(repo, false, watchWorthy);
            for (const dir of watchableDirs(repo))
                subscribe(dir, true, watchWorthy);
            // `.git` is excluded above; refs are read by `git.ts` and are the whole
            // of "what's live where".
            subscribe(join(repo, '.git'), false, gitWorthy);
            subscribe(join(repo, '.git', 'refs'), true, watchWorthy);
            const backlog = opts.backlogDirOf?.(repo);
            if (backlog)
                subscribe(join(repo, backlog), true, watchWorthy);
        }
    };
    return {
        arm,
        dirs: () => [...watchers.keys()],
        refused: () => [...refused],
        capped: () => capped,
        notice: () => {
            const live = watchers.size > 0;
            const degraded = !live || refused.length > 0 || capped;
            return {
                live,
                watching: watchers.size,
                degraded,
                reason: !degraded ? null
                    : !live
                        ? 'this filesystem refuses fs.watch, so the dashboard is refreshing every 15 seconds instead'
                        : capped
                            ? `watching ${watchers.size} directories, the per-connection ceiling — the rest of the fleet `
                                + 'refreshes every 15 seconds'
                            : `${refused.length} director${refused.length === 1 ? 'y' : 'ies'} could not be watched; `
                                + 'those refresh every 15 seconds',
            };
        },
        close: () => {
            for (const w of watchers.values()) {
                try {
                    w.close();
                }
                catch { /* already closed */ }
            }
            watchers.clear();
        },
    };
}
