import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What grooming has already tried and been unable to scope.
 *
 * Without this, grooming takes the first N `idea`/`scoped` tasks in backlog
 * order every single night — so a handful near the top that genuinely need a
 * human decision consume the entire grooming budget forever, and nothing
 * further down is ever reached. Observed on a real backlog: the same five
 * tasks re-attempted on five consecutive nights, at five agent invocations a
 * night, while newer ideas sat untouched behind them.
 *
 * "It could not scope this" is a fact worth remembering, and remembering it is
 * the difference between a queue that drains and one that stalls on its own
 * first hard problem.
 *
 * **It lives in `.launchpad/`, never in the task file.** An adopted backlog is
 * somebody else's format with somebody else's validator — writing a private
 * bookkeeping field into it is how a status change turned a whole repo
 * unpushable once already. launchpad reads that format and writes back only
 * `status` and `reason`; anything else it wants to remember is its own to
 * store.
 */

export interface GroomAttempt {
  attempts: number;
  lastAt: string;
  why: string;
  /**
   * Hash of the task text at the last attempt.
   *
   * Editing the task is how a human answers the question grooming could not.
   * A changed body earns a fresh attempt, so refusing a task is never
   * permanent — it just stops being retried while it is still the same words
   * that failed last time.
   */
  hash: string;
}

export type GroomMemory = Record<string, GroomAttempt>;

export const GROOM_STATE = join('.launchpad', 'nightshift', 'groom-state.json');

/**
 * How many refusals before grooming stops re-reading the same task.
 *
 * Two, not one: the first failure is often the agent, not the task — a timeout,
 * a rate limit, a bad night. The second is evidence about the task itself.
 */
export const MAX_GROOM_ATTEMPTS = 2;

export const taskHash = (title: string, body: string): string =>
  createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16);

export function readGroomMemory(repo: string): GroomMemory {
  const p = join(repo, GROOM_STATE);
  if (!existsSync(p)) return {};
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: GroomMemory = {};
    for (const [id, v] of Object.entries(raw as Record<string, Partial<GroomAttempt>>)) {
      if (!v || typeof v !== 'object') continue;
      out[id] = {
        attempts: Number.isFinite(v.attempts) ? Number(v.attempts) : 0,
        lastAt: typeof v.lastAt === 'string' ? v.lastAt : '',
        why: typeof v.why === 'string' ? v.why : '',
        hash: typeof v.hash === 'string' ? v.hash : '',
      };
    }
    return out;
  } catch {
    // Forgetting is the safe failure: it costs one wasted retry, where
    // throwing would stop the night.
    return {};
  }
}

export function writeGroomMemory(repo: string, m: GroomMemory): void {
  const p = join(repo, GROOM_STATE);
  try {
    mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
  } catch { /* bookkeeping must never stop a night */ }
}

/**
 * Should grooming skip this task tonight?
 *
 * Only when it has been refused enough times AND the wording has not changed
 * since. Editing the task is the human answering, and that always earns a
 * fresh attempt.
 */
export function isExhausted(mem: GroomMemory, id: string, hash: string, max = MAX_GROOM_ATTEMPTS): boolean {
  const a = mem[id];
  if (!a) return false;
  if (a.hash && a.hash !== hash) return false;   // reworded — try again
  return a.attempts >= max;
}

export function recordRefusal(mem: GroomMemory, id: string, hash: string, why: string, now: Date): GroomMemory {
  const prev = mem[id];
  // A reworded task starts its count again rather than inheriting the old one.
  const attempts = prev && prev.hash === hash ? prev.attempts + 1 : 1;
  return { ...mem, [id]: { attempts, lastAt: now.toISOString(), why, hash } };
}

/** Grooming succeeded, so nothing about the past matters any more. */
export function clearAttempt(mem: GroomMemory, id: string): GroomMemory {
  if (!(id in mem)) return mem;
  const next = { ...mem };
  delete next[id];
  return next;
}

/**
 * Tasks grooming has given up on. These are a worklist for a person, not a
 * failure — surfacing them is the whole point of remembering.
 */
export function needsDecision(mem: GroomMemory, max = MAX_GROOM_ATTEMPTS): { id: string; why: string; attempts: number }[] {
  return Object.entries(mem)
    .filter(([, a]) => a.attempts >= max)
    .map(([id, a]) => ({ id, why: a.why, attempts: a.attempts }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
