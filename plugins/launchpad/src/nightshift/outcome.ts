/**
 * What actually happened to a task last night.
 *
 * The old heartbeat read the outcome out of the task file's own `status:`
 * field — which the AGENT wrote. Nothing verified that the project's check
 * passed, that a commit landed, or that a push succeeded, so an agent that
 * marked its own homework `done` was reported as a success and the morning
 * summary said work had shipped that had not. The summary was not lying; it
 * was faithfully reporting a claim.
 *
 * So: the agent's `status:` is an input, never the answer. Every outcome here
 * is derived from something observable — an exit code, a moved HEAD, a push
 * that returned zero, a check that ran.
 */

export type Outcome =
  /** Commit landed AND reached the remote AND the project's own gate passed. */
  | 'pushed'
  /** Work committed locally but not on the remote — nobody else can see it. */
  | 'committed'
  /** The agent ran, honestly, and deliberately gave up on this task. */
  | 'blocked'
  /** The agent ran and produced nothing. A real result: the task may be wrong. */
  | 'no-change'
  /** The agent never really ran — auth, usage limit, crash. NOT the task's fault. */
  | 'infra-failed'
  /** Killed at the per-task timeout. */
  | 'timed-out';

export interface RunFacts {
  /** Exit status of the agent process. 124 is the timeout killer's code. */
  exitCode: number;
  durationS: number;
  /** Commit at the start and end of the attempt. */
  headBefore: string;
  headAfter: string;
  /** Whether the push command succeeded. undefined = never attempted. */
  pushed?: boolean;
  /** Whether the project's own check command passed. undefined = never ran. */
  checkPassed?: boolean;
  /** What the agent wrote into the task file. A CLAIM. */
  claimedStatus?: string;
  /** The session log, searched for evidence the agent never got going. */
  log: string;
}

/**
 * Signatures of the agent failing to start rather than failing at the work.
 * Each of these produced a run that looked like a task failure and was not.
 */
const INFRA_FAILURE = new RegExp([
  'Invalid authentication credentials',
  'Failed to authenticate',
  'API Error: 401',
  'API Error: 429',
  'Please run .*login',
  'OAuth token has expired',
  'usage limit',
  'rate.?limit',
  'Insufficient credit',
  'quota exceeded',
  'ECONNREFUSED|ENOTFOUND|ETIMEDOUT',
].join('|'), 'i');

/**
 * Below this, an agent that produced no diff cannot have done any work — it
 * takes longer than this just to read a CLAUDE.md. The old code treated such
 * a run as the task failing and, after two of them, permanently blocked a
 * legitimate task and pushed that block to main.
 */
const MIN_PLAUSIBLE_WORK_S = 30;

export function isInfraFailure(f: RunFacts): boolean {
  if (INFRA_FAILURE.test(f.log)) return true;
  // No log at all plus an instant exit: the process died before saying anything.
  return f.durationS < MIN_PLAUSIBLE_WORK_S
    && f.headBefore === f.headAfter
    && f.log.trim().length < 200;
}

export function deriveOutcome(f: RunFacts): Outcome {
  if (f.exitCode === 124) return 'timed-out';
  if (isInfraFailure(f)) return 'infra-failed';

  const committed = f.headAfter !== f.headBefore && f.headAfter !== '';
  // `blocked` is the one place the agent's claim is authoritative — it is a
  // statement of intent about its own reasoning, not a claim about the world.
  // It still only counts if the agent actually ran long enough to mean it.
  if (f.claimedStatus === 'blocked') return 'blocked';
  if (!committed) return 'no-change';

  // Committed. Whether it SHIPPED is a separate question, and the one the
  // morning summary kept getting wrong.
  const gatePassed = f.checkPassed !== false;
  return f.pushed === true && gatePassed ? 'pushed' : 'committed';
}

/** True when the outcome means work reached somewhere other than this machine. */
export function reachedRemote(o: Outcome): boolean {
  return o === 'pushed';
}

/**
 * True when the task itself is dealt with for tonight. `committed` counts: the
 * work is done and re-running the agent would only duplicate it. Whether it
 * reached the remote is a separate problem with a separate fix.
 */
export function isSettled(o: Outcome): boolean {
  return o === 'pushed' || o === 'blocked' || o === 'committed';
}

/**
 * Human phrasing, deliberately using the weakest true word.
 *
 * "Shipped" is reserved for something that reached users, which a push is not.
 * The old summary counted commits and called them shipped.
 */
export function describe(o: Outcome): string {
  switch (o) {
    case 'pushed': return 'pushed to the remote';
    case 'committed': return 'committed locally, NOT pushed';
    case 'blocked': return 'blocked by the agent';
    case 'no-change': return 'ran, produced no change';
    case 'infra-failed': return 'the agent could not run (not a task failure)';
    case 'timed-out': return 'hit the time limit';
  }
}
