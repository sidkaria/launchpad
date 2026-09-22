import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRegistry, writeRegistry } from '../registry.js';
import { demoCode } from './demo.js';

/**
 * The arrival sequence — the one recordable moment this product has.
 *
 * The launch plan describes the hero shot precisely: run onboard in a terminal
 * on the left; on the right the project card appears, the icon resolves, cells
 * flip green one by one and the "N things left" count ticks down. That is the
 * ad, the hero image and the pinned reel, and it needs to be something a screen
 * recorder can capture in one take.
 *
 * It is built the only way that keeps the numbers true. **Nothing here animates
 * a value.** The sequence moves real files in and out of the demo repositories
 * on a timer; the scorecard re-reads them; `fs.watch` notices; the existing SSE
 * stream pushes the new payload; the page re-renders. Every cell that turns
 * green turns green because the file that makes that check pass now exists.
 *
 * The distinction is not pedantry. The ring animation was deliberately removed
 * from this dashboard because a gauge sweeping to a number shows a value that
 * is not the data for as long as the sweep lasts. Re-introducing motion for the
 * sake of an advert would have put that bug back. Animating *arrival* — a cell
 * that has genuinely just changed — has no such failure mode: the worst case is
 * a fade on a value that was already correct.
 *
 * Only ever reachable behind `--demo`, and only against the demo's own
 * temporary directory.
 */

/** Files pulled out at the start and put back one at a time. Order is the story. */
interface Beat {
  /** Repo-relative path to restore. */
  path: string;
  /** What a viewer should understand just resolved. Printed to the terminal. */
  says: string;
}

/**
 * Fernweh is the project the camera follows: three surfaces, so the widest
 * spread of checks resolve, and it ends two short of finished rather than
 * perfect — which is both truer and a better advertisement, because the two
 * that remain are the ones nobody knew about.
 */
const LEAD = 'fernweh';

const BEATS: Beat[] = [
  { path: '.launchpad/state.yml', says: 'onboarded — three surfaces detected' },
  { path: '.gitignore', says: 'secrets are out of the repository' },
  { path: '.github/workflows/launchpad-validate.yml', says: 'builds in CI, and tests gate every push' },
  { path: 'apps/mobile/android/app/build.gradle.kts', says: 'Android release signs with a real key' },
  { path: 'docs/privacy.md', says: 'privacy policy — a rejection, not a nag' },
  { path: 'apps/mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset', says: 'app icon the store will accept' },
  { path: 'package.json', says: 'analytics and a paywall are wired' },
  { path: 'fastlane', says: 'store listing assets' },
  { path: '.launchpad/confirmed.yml', says: 'upload keystore confirmed backed up' },
  { path: '.git/refs/tags', says: 'a release has actually gone out' },
];

export interface Replay {
  stop: () => void;
  /** Exposed so a test can drive the sequence without waiting on wall-clock time. */
  step: () => boolean;
}

export interface ReplayOptions {
  /** Milliseconds between beats. */
  everyMs?: number;
  /** Quiet before the first beat, so a recording can start on a still frame. */
  leadInMs?: number;
  /** Called with each beat's caption. Defaults to nothing. */
  onBeat?: (says: string) => void;
  /** Drive it by hand instead of on a timer. */
  manual?: boolean;
}

/**
 * Take the fleet apart, then put it back together on a timer.
 *
 * Deliberately destructive-then-restorative rather than built-up-from-nothing:
 * the end state has to be exactly the fleet `--demo` shows without `--replay`,
 * or the recording would end somewhere the screenshots do not.
 */
export function startReplay(home: string, opts: ReplayOptions = {}): Replay {
  const root = dirname(home);
  const code = demoCode(root);
  const lead = join(code, LEAD);
  const stash = join(root, 'replay-stash');
  rmSync(stash, { recursive: true, force: true });
  mkdirSync(stash, { recursive: true });

  // The whole fleet, remembered, then reduced to the one project the sequence
  // follows — as if it had just been added and nothing else existed yet.
  const full = readRegistry(home).projects;
  const leadEntry = full.find(p => p.path === lead);
  writeRegistry({ projects: leadEntry ? [leadEntry] : [] }, home);

  const pulled: Beat[] = [];
  for (const beat of BEATS) {
    const from = join(lead, beat.path);
    if (!existsSync(from)) continue;
    const to = join(stash, beat.path);
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    pulled.push(beat);
  }

  // The other projects arrive after the lead has finished resolving, so the
  // camera sees one thing at a time rather than seven at once.
  const rest = full.filter(p => p.path !== lead);
  let i = 0;
  const onBeat = opts.onBeat ?? (() => undefined);

  const step = (): boolean => {
    if (i < pulled.length) {
      const beat = pulled[i++];
      const to = join(lead, beat.path);
      mkdirSync(dirname(to), { recursive: true });
      try { renameSync(join(stash, beat.path), to); } catch { /* already restored */ }
      onBeat(beat.says);
      return true;
    }
    const n = i - pulled.length;
    // Everything is back where it belongs; the empty shell of the stash is
    // litter in somebody's temp directory.
    if (n === 0) rmSync(stash, { recursive: true, force: true });
    if (n < rest.length) {
      i++;
      const reg = readRegistry(home);
      reg.projects.push(rest[n]);
      reg.projects.sort((a, b) => a.path.localeCompare(b.path));
      writeRegistry(reg, home);
      onBeat(`+ ${rest[n].path.split('/').pop()}`);
      return true;
    }
    return false;
  };

  if (opts.manual) return { stop: () => undefined, step };

  let timer: NodeJS.Timeout | null = null;
  const tick = (): void => {
    if (!step()) { stop(); return; }
    timer = setTimeout(tick, opts.everyMs ?? 1600);
  };
  const stop = (): void => { if (timer) clearTimeout(timer); timer = null; };
  timer = setTimeout(tick, opts.leadInMs ?? 3000);
  return { stop, step };
}
