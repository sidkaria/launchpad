import type { Outcome } from './outcome.js';

/**
 * What to do after an attempt.
 *
 * The old drain loop auto-blocked a task after two attempts that made no
 * progress, REGARDLESS of why, then committed and pushed that block. The
 * 2026-07-12 log shows the consequence: real tasks ran for 2-4 seconds
 * (the agent never got going — usage limit or a transient error), twice each,
 * and were permanently blocked and pushed to main. A five-minute outage
 * destroyed a night's backlog, and the blocks stayed.
 *
 * The distinction that fixes it: **did the agent work and fail, or never run?**
 * Only the first is evidence about the task. The second is evidence about the
 * machine, and it is global — if the agent cannot run, no other task will fare
 * better, so the correct response is to stop the whole drain, not to burn
 * through the queue blocking everything in it.
 */

export type Action =
  /** Try this same task again, after waiting. */
  | { kind: 'retry'; afterS: number; reason: string }
  /** Mark the task blocked and move on. Only ever for genuine task failure. */
  | { kind: 'block'; reason: string }
  /** Task is settled; take the next one. */
  | { kind: 'next' }
  /** Stop everything: the problem is not this task. */
  | { kind: 'abort'; reason: string };

export interface AttemptHistory {
  /** Outcomes for THIS task, oldest first. */
  outcomes: Outcome[];
  /** Consecutive infra failures across the whole drain, any task. */
  consecutiveInfraFailures: number;
}

/** Give up on the night after this many infra failures in a row. */
export const INFRA_ABORT_THRESHOLD = 3;
/** Genuine no-progress attempts on one task before blocking it. */
export const NO_PROGRESS_BLOCK_THRESHOLD = 2;

const BACKOFF_S = [60, 300, 900];

export function nextAction(h: AttemptHistory): Action {
  const last = h.outcomes[h.outcomes.length - 1];
  if (!last) return { kind: 'next' };

  if (last === 'infra-failed') {
    if (h.consecutiveInfraFailures >= INFRA_ABORT_THRESHOLD) {
      return {
        kind: 'abort',
        reason:
          `the agent failed to run ${h.consecutiveInfraFailures} times in a row — this is the ` +
          `machine or the account, not the queue. Stopping so the backlog stays intact.`,
      };
    }
    return {
      kind: 'retry',
      afterS: BACKOFF_S[Math.min(h.consecutiveInfraFailures, BACKOFF_S.length - 1)],
      reason: 'the agent never ran; the task is untouched and stays ready',
    };
  }

  // A timeout is ambiguous — the agent WAS working. Retry once, then treat a
  // second one as a real signal that the task is too big as scoped.
  if (last === 'timed-out') {
    const timeouts = h.outcomes.filter(o => o === 'timed-out').length;
    return timeouts >= 2
      ? { kind: 'block', reason: 'hit the time limit twice — the task is too large as scoped' }
      : { kind: 'retry', afterS: 0, reason: 'timed out once' };
  }

  // `committed` counts as done, NOT as non-progress. The work landed; only the
  // push failed, which is a credentials or network problem and has nothing to
  // do with the task. Retrying here re-runs the AGENT on a task it already
  // completed — an end-to-end run against a repo with no remote produced two
  // commits and a duplicated file before blocking the task. The push failure
  // is surfaced loudly by the report instead.
  if (last === 'pushed' || last === 'blocked' || last === 'committed') return { kind: 'next' };

  // Genuine non-progress: the agent ran, honestly, and got nowhere.
  const genuine = h.outcomes.filter(o => o === 'no-change').length;
  if (genuine >= NO_PROGRESS_BLOCK_THRESHOLD) {
    return {
      kind: 'block',
      reason: `${genuine} real attempts produced no usable change — needs a human to re-scope`,
    };
  }
  return { kind: 'retry', afterS: 0, reason: 'no change yet' };
}

/**
 * Whether a fire should even start. An empty enabled-project list is the
 * current, silent failure: every 30 minutes the orchestrator logged
 * `fire: projects [ ]` followed by `fire complete`, which reads exactly like
 * a successful run that had nothing to do.
 */
export function preflight(enabled: string[], registered: string[]): { ok: boolean; message: string } {
  if (registered.length === 0) {
    return { ok: false, message: 'no projects registered — nothing to do. Run /launchpad:onboard inside a repo first.' };
  }
  if (enabled.length === 0) {
    return {
      ok: false,
      message:
        `all ${registered.length} registered project(s) are DISABLED, so this fire will do nothing. ` +
        `This is a configuration state, not a successful run — enable one to resume overnight work.`,
    };
  }
  return { ok: true, message: `${enabled.length} of ${registered.length} project(s) enabled` };
}
