import { dirname } from 'node:path';
import type { Archetype, DetectedPipeline, Disposition, Surface } from './types.js';

/**
 * Making `disposition` load-bearing.
 *
 * `setup` has recorded a disposition per detected pipeline for a long time, the
 * setup skill has asked the user for one, and **nothing branched on it**. The
 * skill said so out loud: "a decision recorded for you and the user — no code
 * branches on it". So a user who answered "leave it alone" about their
 * hand-written release pipeline watched `apply` wire a second one beside it.
 *
 * What protected them was `writeGuarded`, which refuses to overwrite a file
 * launchpad did not generate. That is a good last line of defence and a bad
 * only one: the Fastfile survives, but the WORKFLOW gets written, and a
 * workflow calling a lane that does not exist is worse than no workflow at all.
 *
 * This could not be switched on before the ownership filter existed, and that
 * is not a detail. `detect` used to report launchpad's own generated
 * `fastlane/Fastfile` as a foreign pipeline, so a `leave-alone` default keyed on
 * detected pipelines would have made the SECOND `apply` stop wiring iOS —
 * silently breaking the byte-stable fixed point, on every wired repo, because
 * the pipeline being left alone was its own.
 */

/**
 * The archetype a pipeline unambiguously belongs to, or null.
 *
 * **Only where unambiguous**, which is the whole design constraint. A GitHub
 * Actions workflow can build anything — an ios lane, a web deploy, a lint job —
 * and guessing from its filename would block surfaces at random. So workflows
 * map to nothing and never block anything; if somebody's `release.yml` really
 * does own a surface, they say so by setting the disposition themselves.
 */
export function pipelineArchetype(p: DetectedPipeline): Archetype | null {
  const path = p.path.replace(/\\/g, '/');
  switch (p.kind) {
    case 'fastlane':
      // launchpad writes iOS's lane at `<workdir>/fastlane/Fastfile` and
      // Android's at `<workdir>/android/fastlane/Fastfile`, so the parent
      // directory is what tells the two apart.
      return /(^|\/)android\/fastlane\/Fastfile$/.test(path) ? 'android' : 'ios';
    case 'vercel': return 'web-app';
    case 'sparkle-dmg': return 'macos-dmg';
    // A workflow builds anything; a heartbeat is not a pipeline for a surface.
    case 'github-actions':
    case 'heartbeat':
    default: return null;
  }
}

/**
 * The directory a pipeline governs, repo-relative, `.` for the repository root.
 *
 * Scope matters in a monorepo: `apps/mobile/fastlane/Fastfile` is a statement
 * about `apps/mobile`, and must not stop `apps/other` from being wired.
 */
export function pipelineScope(p: DetectedPipeline): string {
  const path = p.path.replace(/\\/g, '/');
  let dir = dirname(path);
  if (/(^|\/)fastlane$/.test(dir)) dir = dirname(dir);          // …/fastlane/Fastfile
  if (/(^|\/)android$/.test(dir)) dir = dirname(dir);           // …/android/fastlane/Fastfile
  return dir === '' || dir === '.' ? '.' : dir;
}

/** Where a surface lives, in the same terms. */
export const surfaceScope = (s: Surface): string => s.target ?? '.';

/**
 * The pipeline that says "do not wire this surface", or null.
 *
 * `leave-alone` only. `adopt` and `migrate` are both decisions to go on and do
 * something, and neither is a reason to skip.
 */
export function blockingPipeline(s: Surface, pipelines: DetectedPipeline[]): DetectedPipeline | null {
  return pipelines.find(p =>
    p.disposition === 'leave-alone'
    && pipelineArchetype(p) === s.archetype
    && pipelineScope(p) === surfaceScope(s)) ?? null;
}

/**
 * What a newly detected foreign pipeline is assumed to mean.
 *
 * `leave-alone`, because PLAYBOOK §5 is not a preference: "Most real repos
 * already ship somehow. Treat anything without your own marker as untouchable,
 * and *report* it rather than silently preserving it." The safe default is the
 * one that does nothing to a repository that already works, and the user can
 * say otherwise in one line.
 *
 * It applies to NEWLY detected pipelines only. A pipeline already sitting in a
 * state file with no disposition was written by a version of launchpad that had
 * no default, on a repo somebody has probably already wired — turning that into
 * `leave-alone` behind their back would stop a working `apply` on an upgrade,
 * which is precisely the kind of surprise this whole mechanism exists to avoid.
 */
export const DEFAULT_DISPOSITION: Disposition = 'leave-alone';

/** The refusal `apply` prints. Names the pipeline, and how to say otherwise. */
export function dispositionRefusal(s: Surface, p: DetectedPipeline): string[] {
  return [
    `  ! ${s.id} (${s.archetype}): left alone — \`${p.path}\` already ships this, and launchpad`,
    '      does not wire a second pipeline beside one that works. Nothing was written.',
    `      To change that, set \`disposition: migrate\` (or \`adopt\`) on that pipeline in`,
    '      .launchpad/state.yml and re-run `apply`; `setup` preserves what you set.',
  ];
}
