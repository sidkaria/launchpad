import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = () => dirname(fileURLToPath(import.meta.url));
/** The plugin directory: `dist/` sits one level below it. */
export function pluginRoot(from = here()) {
    return join(from, '..');
}
function readJson(p) {
    try {
        return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
    }
    catch {
        return null;
    }
}
export function provenance(env = process.env, from = here()) {
    const root = pluginRoot(from);
    const pkg = readJson(join(root, 'package.json'));
    // The manifest is stamped twice by `publish`: at the package root, and INSIDE
    // the plugin directory. The inner copy exists because some loaders — the
    // `plugin eval` sandbox today, plausibly other containerised installs — grant
    // reads only within the plugin root, and a marker two levels above it is
    // then invisible. That made a genuine package tell its user "unverified for
    // customers" on every command (L2-F-14). Inner first, outer as fallback.
    const manifest = readJson(join(root, 'MANIFEST.json')) ??
        readJson(join(root, '..', '..', 'MANIFEST.json'));
    // A package carries a MANIFEST.json and has no `test/`. Both are checked: a
    // manifest could be copied by hand, and a missing `test/` could be a partial
    // checkout, but the pair together is unambiguous.
    //
    // This used to key on `src/`. `src/` now SHIPS (DECISIONS.md 2026-09-21), so
    // that check would have called every published package a working tree and
    // printed "running from a source checkout" to every customer on every
    // command. `test/` is the right discriminator and is the more honest one
    // anyway: what distinguishes the workshop is the half-finished work in it,
    // not the language the product is written in.
    const hasTests = existsSync(join(root, 'test'));
    const isPackage = Boolean(manifest) && !hasTests;
    const dev = env.LAUNCHPAD_DEV === '1';
    const origin = isPackage ? 'package' : dev ? 'dev-override' : 'working-tree';
    return {
        version: manifest?.version ?? pkg?.version ?? '0.0.0',
        origin,
        root,
        built: manifest?.built,
        isProduct: origin === 'package',
    };
}
/**
 * The warning shown when the author runs the working tree against a real
 * project. Not an error — this is a legitimate thing to do — but it must never
 * be silent, because a silent working tree is how "it works on my machine"
 * gets mistaken for "it works".
 */
export function provenanceNote(p) {
    if (p.origin === 'package')
        return null;
    if (p.origin === 'dev-override') {
        return 'launchpad: LAUNCHPAD_DEV=1 — running the working tree, not the published package.';
    }
    return 'launchpad: running from a source checkout, not the published package. '
        + 'Anything you verify here is unverified for customers — build and install one with `npm run publish`.';
}
export function renderVersion(p) {
    const originLabel = {
        'package': 'published package',
        'working-tree': 'source checkout (NOT what customers run)',
        'dev-override': 'source checkout, LAUNCHPAD_DEV=1',
    }[p.origin];
    const out = [
        `launchpad ${p.version}`,
        `  origin:  ${originLabel}`,
        `  root:    ${p.root}`,
    ];
    if (p.built)
        out.push(`  built:   ${p.built}`);
    return out.join('\n');
}
