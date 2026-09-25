import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
/**
 * Facts about a repository, read from `.git` rather than asked of `git`.
 *
 * No subprocess: these are read on every scorecard run and once per project in
 * the fleet view, and a `spawnSync` per fact per project is the difference
 * between a dashboard that feels instant and one that stutters. It also works
 * where `git` is not on PATH, which is a real state for a launchd job.
 */
const read = (repo, rel) => {
    try {
        return readFileSync(join(repo, rel), 'utf8');
    }
    catch {
        return '';
    }
};
/** Mainline names, in the order to prefer them when a repo has more than one. */
const MAINLINE = ['main', 'master', 'trunk', 'develop', 'development'];
/** Every local branch, from loose refs and the packed-refs file alike. */
function localBranches(repo) {
    const out = [];
    const walk = (rel, prefix) => {
        let names;
        try {
            names = readdirSync(join(repo, rel));
        }
        catch {
            return;
        }
        for (const name of names) {
            const child = join(rel, name);
            // A branch name can contain a slash (`release/1.2`), which git stores as
            // a directory. `readdirSync` on a file throws, which is the is-dir test.
            try {
                readdirSync(join(repo, child));
                walk(child, `${prefix}${name}/`);
            }
            catch {
                out.push(`${prefix}${name}`);
            }
        }
    };
    walk('.git/refs/heads', '');
    for (const line of read(repo, '.git/packed-refs').split('\n')) {
        const m = /^[0-9a-f]{40}\s+refs\/heads\/(.+)$/.exec(line.trim());
        if (m)
            out.push(m[1]);
    }
    return [...new Set(out)];
}
/** The branch currently checked out, or null on a detached HEAD. */
export function currentBranch(repo) {
    return /^ref:\s*refs\/heads\/(.+)$/m.exec(read(repo, '.git/HEAD').trim())?.[1] ?? null;
}
/**
 * The branch this repo actually treats as its trunk.
 *
 * `baseBranch` was hardcoded to `'main'` with no detection at all, which is a
 * bad assumption for exactly the buyer this product is sold to: someone with an
 * app they built eighteen months ago, on a repo that is very often still on
 * `master`. Nothing was destroyed by the wrong answer — the work is pushed to a
 * branch and `checkoutBase` is best-effort — but the pull request step failed
 * and the morning report explained nothing.
 *
 * Layered, most authoritative first:
 *
 *   1. What the REMOTE says its default is. This is the one that matters,
 *      because it is what a pull request has to target.
 *   2. The current branch, but only if it is a recognisable mainline name — at
 *      3am the user may well be sitting on a feature branch, and targeting a
 *      PR at that would be worse than guessing wrong.
 *   3. The only mainline branch that exists locally. Unambiguous when there is
 *      exactly one.
 *   4. `main`. A guess, and labelled as one by the caller.
 */
export function defaultBranch(repo) {
    return defaultBranchWithSource(repo).branch;
}
export function defaultBranchWithSource(repo) {
    const remoteHead = /^ref:\s*refs\/remotes\/origin\/(.+)$/m
        .exec(read(repo, '.git/refs/remotes/origin/HEAD').trim())?.[1];
    if (remoteHead)
        return { branch: remoteHead, source: 'remote' };
    const branches = localBranches(repo);
    const mainlines = MAINLINE.filter(m => branches.includes(m));
    const current = currentBranch(repo);
    if (current && MAINLINE.includes(current))
        return { branch: current, source: 'current' };
    if (mainlines.length)
        return { branch: mainlines[0], source: 'mainline' };
    // A repo with one branch and a non-standard name (`live`, `production`) is
    // telling us what its trunk is by having only one.
    if (branches.length === 1)
        return { branch: branches[0], source: 'only' };
    return { branch: 'main', source: 'guess' };
}
/**
 * The most recently written tag, and when its ref was written.
 *
 * Deliberately weak, and labelled that way everywhere it is shown. A ref's
 * mtime is when *this checkout* learned about the tag, not when it was created,
 * and the tag itself says a release was cut — not that a store accepted it.
 * Both are still the best evidence a repository can offer without calling
 * anybody's API, which this product does not do.
 *
 * Sorted by mtime rather than by name because version strings do not sort:
 * `v0.9.2` after `v0.10.0` is wrong under every string comparison and right
 * under none of them.
 */
export function latestTag(repo) {
    const dir = join(repo, '.git', 'refs', 'tags');
    const found = [];
    const walk = (rel, prefix) => {
        let names;
        try {
            names = readdirSync(join(dir, rel));
        }
        catch {
            return;
        }
        for (const name of names) {
            const child = rel ? join(rel, name) : name;
            try {
                readdirSync(join(dir, child));
                walk(child, `${prefix}${name}/`);
            }
            catch {
                try {
                    found.push({ name: `${prefix}${name}`, ms: statSync(join(dir, child)).mtimeMs });
                }
                catch { /* vanished */ }
            }
        }
    };
    walk('', '');
    if (found.length) {
        const best = found.sort((a, b) => b.ms - a.ms)[0];
        return { name: best.name, at: new Date(best.ms).toISOString() };
    }
    // A packed ref has no mtime of its own; the last one in the file is the best
    // available answer and the file's own date is the only date there is.
    const packed = [...read(repo, '.git/packed-refs').matchAll(/^[0-9a-f]{40}\s+refs\/tags\/(.+)$/gm)];
    if (!packed.length)
        return null;
    let at;
    try {
        at = new Date(statSync(join(repo, '.git', 'packed-refs')).mtimeMs).toISOString();
    }
    catch { /* none */ }
    return { name: packed[packed.length - 1][1], ...(at ? { at } : {}) };
}
/** The commit the current branch points at, short. What a push would deploy. */
export function headCommit(repo) {
    const head = read(repo, '.git/HEAD').trim();
    const direct = /^[0-9a-f]{40}$/.exec(head);
    if (direct)
        return head.slice(0, 7);
    const ref = /^ref:\s*(refs\/heads\/.+)$/.exec(head)?.[1];
    if (!ref)
        return null;
    const sha = read(repo, join('.git', ref)).trim();
    if (/^[0-9a-f]{40}$/.test(sha))
        return sha.slice(0, 7);
    const packed = new RegExp(`^([0-9a-f]{40})\\s+${ref.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm')
        .exec(read(repo, '.git/packed-refs'));
    return packed ? packed[1].slice(0, 7) : null;
}
/** Did this repo ever cut a release? A tag is the cheapest durable evidence. */
export function hasReleaseTag(repo) {
    try {
        if (readdirSync(join(repo, '.git/refs/tags')).length)
            return true;
    }
    catch { /* no loose tags */ }
    return /(^|\n)[0-9a-f]{40}\s+refs\/tags\//.test(read(repo, '.git/packed-refs'));
}
/** Is there a git repo here at all? */
export const isRepo = (repo) => existsSync(join(repo, '.git'));
