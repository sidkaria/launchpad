import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Which launchpad is this, and where did it come from?
 *
 * The milestone this serves is not a feature, it is a discipline: **the
 * author's own machines must run the published artifact, not the working
 * tree.** Every "it still works on my own repo" is otherwise an assumption. A
 * repo checkout has `test/`, `scripts/`, a full `node_modules` and whatever is
 * half-finished on the branch; the package has `dist/`, `src/`, the skills, and
 * one vendored dependency. Those are different programs, and only one of them
 * is the product.
 *
 * So provenance is computed from what is actually on disk rather than declared,
 * and printed by `launchpad version`. `LAUNCHPAD_DEV=1` is the deliberate
 * override for when you are working ON launchpad rather than WITH it — and the
 * point of naming it is that you cannot be in dev mode by accident and think
 * you proved something about the product.
 */

export type Origin =
  /** Running out of a git checkout — this is launchpad's own source tree. */
  | 'working-tree'
  /** Running from a built, allowlisted package. What customers have. */
  | 'package'
  /** A working tree with LAUNCHPAD_DEV=1: deliberate, and announced. */
  | 'dev-override';

export interface Provenance {
  version: string;
  origin: Origin;
  /** The plugin root this process is actually executing from. */
  root: string;
  /** Present in a published package; the build stamp. */
  built?: string;
  /** True when this build is the product a customer would receive. */
  isProduct: boolean;
}

const here = () => dirname(fileURLToPath(import.meta.url));

/** The plugin directory: `dist/` sits one level below it. */
export function pluginRoot(from = here()): string {
  return join(from, '..');
}

function readJson<T>(p: string): T | null {
  try { return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as T) : null; } catch { return null; }
}

export function provenance(env: NodeJS.ProcessEnv = process.env, from = here()): Provenance {
  const root = pluginRoot(from);
  const pkg = readJson<{ version?: string }>(join(root, 'package.json'));
  // The manifest is stamped twice by `publish`: at the package root, and INSIDE
  // the plugin directory. The inner copy exists because some loaders — the
  // `plugin eval` sandbox today, plausibly other containerised installs — grant
  // reads only within the plugin root, and a marker two levels above it is
  // then invisible. That made a genuine package tell its user "unverified for
  // customers" on every command (L2-F-14). Inner first, outer as fallback.
  const manifest =
    readJson<{ version?: string; built?: string }>(join(root, 'MANIFEST.json')) ??
    readJson<{ version?: string; built?: string }>(join(root, '..', '..', 'MANIFEST.json'));

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

  const origin: Origin = isPackage ? 'package' : dev ? 'dev-override' : 'working-tree';
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
export function provenanceNote(p: Provenance): string | null {
  if (p.origin === 'package') return null;
  if (p.origin === 'dev-override') {
    return 'launchpad: LAUNCHPAD_DEV=1 — running the working tree, not the published package.';
  }
  return 'launchpad: running from a source checkout, not the published package. '
    + 'Anything you verify here is unverified for customers — build and install one with `npm run publish`.';
}

export function renderVersion(p: Provenance): string {
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
  if (p.built) out.push(`  built:   ${p.built}`);
  return out.join('\n');
}
