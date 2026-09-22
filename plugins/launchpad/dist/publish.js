import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
/**
 * What goes in the box.
 *
 * The development repository is the private source of truth and holds things a
 * customer must never receive — product briefs, positioning, pricing thinking,
 * the worklog. The sellable artifact is BUILT from it rather than mirrored into
 * a second repository, because the thing customers install is a package, not a
 * git remote they clone. Two repos would solve a problem that does not exist
 * and guarantee one that does: divergence.
 *
 * The rule that makes a single repo safe is that this is an **allowlist**.
 *
 * A denylist fails OPEN — add `internal/pricing/` next month, forget to update
 * the exclusion, and it ships. An allowlist fails CLOSED: a new directory is
 * simply absent from the package, which is noticed the first time something
 * needs it and is harmless when it does not. For a repo whose whole risk is
 * leaking the author's private material, only one of those failure modes is
 * survivable.
 *
 * `NEVER_PUBLISHED` below is therefore not the mechanism. It is an assertion
 * about the mechanism, so that widening the allowlist by mistake fails the
 * build instead of shipping.
 *
 * ## Why `src/` is on the allowlist (2026-09-21)
 *
 * It used to be on the denylist, with the reasoning "dist is what runs;
 * shipping both invites editing the wrong one". That argument was real but it
 * was answering the wrong question. Two things settled it:
 *
 * 1. **The licence skill and the terms already promised it.** Both tell a buyer
 *    they may open the source, read the licence check, and take the thing apart
 *    — one of them says it is *encouraged*. A package with no source made both
 *    of those sentences false, and a false sentence in the terms is the most
 *    expensive kind.
 * 2. **"Read what it does to your machine" is the trust signal** for a tool
 *    that writes to your repositories and holds your signing keys. `dist/`
 *    ships unminified already, so nothing is being protected by withholding the
 *    TypeScript — only made harder to read.
 *
 * The original worry is handled by saying the thing out loud rather than by
 * withholding the files: `dist/` is still what runs, editing `src/` changes
 * nothing until it is compiled, and an update overwrites the copy. The README
 * and the licence skill both say exactly that.
 *
 * `test/` and `scripts/` still do not ship. They are the workshop, not the
 * product, and `test/` is also what tells `provenance.ts` a checkout from a
 * package — see the note there.
 */
/** Paths, relative to the repo root, that make up the package. */
export const PUBLISHED_PATHS = [
    '.claude-plugin', // the marketplace manifest
    'plugins/launchpad/.claude-plugin', // the plugin manifest
    'plugins/launchpad/dist', // what actually runs
    'plugins/launchpad/src', // the TypeScript it was built from — to be READ
    'plugins/launchpad/skills', // what Claude reads — the product, for a stranger
    'plugins/launchpad/templates',
    'plugins/launchpad/PLAYBOOK.md',
    'plugins/launchpad/package.json',
    'README.md',
];
/**
 * Asserted to be absent from every package. Belt and braces over the allowlist:
 * these are the paths where a leak would actually cost something.
 */
export const NEVER_PUBLISHED = [
    'docs', // product briefs, positioning, the worklog
    'internal',
    'harness', // tests-as-a-customer; operator tooling
    'site', // the landing page deploys on its own
    'STATUS.md',
    'DECISIONS.md',
    'CLAUDE.md',
    '.superpowers',
    '.claude',
    '.git',
    'plugins/launchpad/test',
    'plugins/launchpad/evals', // agent-eval cases and transcripts — operator material
    'plugins/launchpad/.launchpad', // launchpad's own state and night logs
    'plugins/launchpad/scripts',
];
/**
 * Runtime dependencies to vendor into the package.
 *
 * A Claude Code plugin is a directory that gets loaded — there is no install
 * step, no `npm install`, nothing that resolves a dependency on the customer's
 * machine. `node_modules` is gitignored here, so a stranger who installed this
 * plugin got `Cannot find module 'yaml'` on their very first command while it
 * worked perfectly on the author's machine. That is the exact shape of bug this
 * whole packaging milestone exists to catch.
 *
 * `yaml` has no dependencies of its own, so vendoring it is a copy.
 */
export const VENDORED = ['yaml'];
const walk = (root, rel, out) => {
    const abs = join(root, rel);
    if (!existsSync(abs))
        return;
    if (!statSync(abs).isDirectory()) {
        out.push(rel);
        return;
    }
    for (const name of readdirSync(abs).sort()) {
        // A stray log or an OS turd inside an allowlisted directory is still not
        // something to ship.
        if (name === '.DS_Store' || name.endsWith('.log'))
            continue;
        walk(root, join(rel, name), out);
    }
};
export function planPackage(repoRoot) {
    const files = [];
    const missing = [];
    for (const p of PUBLISHED_PATHS) {
        if (!existsSync(join(repoRoot, p))) {
            missing.push(p);
            continue;
        }
        walk(repoRoot, p, files);
    }
    const vendored = [];
    for (const dep of VENDORED) {
        const rel = join('plugins', 'launchpad', 'node_modules', dep);
        if (!existsSync(join(repoRoot, rel))) {
            missing.push(rel);
            continue;
        }
        vendored.push(rel);
        walk(repoRoot, rel, files);
    }
    return { files: files.sort(), missing, vendored };
}
/**
 * Does this plan leak anything? Returns the offending files, empty when clean.
 * Called by the publish script AND by a test, so widening the allowlist by
 * accident turns the build red rather than shipping.
 */
export function leaks(plan) {
    return plan.files.filter(f => {
        const parts = f.split(sep);
        return NEVER_PUBLISHED.some(deny => {
            const d = deny.split('/');
            return d.every((seg, i) => parts[i] === seg);
        });
    });
}
/** Where the repo root is, from anywhere inside the plugin. */
export function repoRootFrom(start) {
    let dir = start;
    for (let i = 0; i < 8; i++) {
        if (existsSync(join(dir, '.claude-plugin', 'marketplace.json')))
            return dir;
        const up = join(dir, '..');
        if (relative(up, dir) === '')
            break;
        dir = up;
    }
    return start;
}
