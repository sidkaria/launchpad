import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What is happening right now.
 *
 * Everything else launchpad shows is derived from files that are true whether
 * or not anything is running — a task's status, a commit, an events log. This
 * is the one genuinely volatile fact, and without persisting it the dashboard
 * cannot tell "building T330 for the last nine minutes" from "crashed three
 * days ago leaving T330 marked in_progress". Those look identical in the
 * backlog and mean opposite things.
 *
 * **Liveness is a pid check, not a heartbeat.** The drain is synchronous: it
 * blocks inside `spawnSync` for the entire agent run, so there is no thread to
 * write a heartbeat from, and a heartbeat that only ticks between phases would
 * declare a healthy hour-long build dead. Asking the OS whether the process
 * exists is exact and costs nothing. `startedAt` plus a max age bounds the pid
 * reuse case, which is the only way the check can lie.
 *
 * Still just a file. Adding a database here would mean two copies of the truth
 * and a migration story, to answer a question the filesystem already answers.
 */

export type Phase = 'starting' | 'grooming' | 'agent' | 'gate' | 'commit' | 'publish' | 'hook' | 'finished';

export interface RunState {
  /** ISO. When this run began. */
  startedAt: string;
  /** ISO. Bumped on every phase change — how the UI says "for 9 minutes". */
  updatedAt: string;
  pid: number;
  project: string;
  phase: Phase;
  taskId?: string;
  taskTitle?: string;
  /** Set when the run ended on purpose. Its absence after death means a crash. */
  finishedAt?: string;
}

export const RUN_PATH = join('.launchpad', 'nightshift', 'run.json');

export type Liveness =
  /** A process is alive and working. */
  | { state: 'running'; phase: Phase; taskId?: string; taskTitle?: string; sinceS: number }
  /** It ended cleanly. */
  | { state: 'idle'; endedAt: string }
  /** It stopped without finishing — the task it held is probably stuck in_progress. */
  | { state: 'crashed'; phase: Phase; taskId?: string; sinceS: number }
  /** Nothing has ever run here. */
  | { state: 'never' };

export function readRunState(repo: string): RunState | null {
  const p = join(repo, RUN_PATH);
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<RunState>;
    if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'string') return null;
    return {
      startedAt: raw.startedAt,
      updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.startedAt,
      pid: raw.pid,
      project: typeof raw.project === 'string' ? raw.project : '',
      phase: (raw.phase ?? 'starting') as Phase,
      taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
      taskTitle: typeof raw.taskTitle === 'string' ? raw.taskTitle : undefined,
      finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
    };
  } catch {
    // A half-written run file must not blank the project's whole row.
    return null;
  }
}

/** Atomic: the dashboard polls this file while the drain rewrites it. */
export function writeRunState(repo: string, s: RunState): void {
  const p = join(repo, RUN_PATH);
  try {
    mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch { /* status reporting must never be the thing that stops a night */ }
}

export function clearRunState(repo: string): void {
  try { unlinkSync(join(repo, RUN_PATH)); } catch { /* already gone */ }
}

/** Does this process exist? Signal 0 checks without delivering anything. */
export function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Beyond this, a live pid is assumed to be a reused one rather than our run.
 * Generous on purpose: a legitimate task may run for the whole window, and
 * calling a working night dead is worse than being slow to notice a crash.
 */
export const MAX_RUN_AGE_S = 12 * 3600;

export function liveness(
  s: RunState | null,
  now: Date,
  isAlive: (pid: number) => boolean = pidAlive,
  maxAgeS = MAX_RUN_AGE_S,
): Liveness {
  if (!s) return { state: 'never' };
  if (s.finishedAt) return { state: 'idle', endedAt: s.finishedAt };
  const sinceS = Math.max(0, Math.round((now.getTime() - new Date(s.updatedAt).getTime()) / 1000));
  const fresh = sinceS < maxAgeS;
  if (fresh && isAlive(s.pid)) {
    return { state: 'running', phase: s.phase, taskId: s.taskId, taskTitle: s.taskTitle, sinceS };
  }
  return { state: 'crashed', phase: s.phase, taskId: s.taskId, sinceS };
}

/** Human phrasing for a phase. Used by both the CLI and the dashboard. */
export function describePhase(p: Phase): string {
  return {
    starting: 'starting up',
    grooming: 'grooming the backlog',
    agent: 'the agent is working',
    gate: 'running the gate',
    commit: 'committing',
    publish: 'pushing',
    hook: 'running the post-drain hook',
    finished: 'finished',
  }[p];
}
