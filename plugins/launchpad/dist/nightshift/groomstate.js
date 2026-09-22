import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export const GROOM_STATE = join('.launchpad', 'nightshift', 'groom-state.json');
/**
 * How many refusals before grooming stops re-reading the same task.
 *
 * Two, not one: the first failure is often the agent, not the task — a timeout,
 * a rate limit, a bad night. The second is evidence about the task itself.
 */
export const MAX_GROOM_ATTEMPTS = 2;
export const taskHash = (title, body) => createHash('sha256').update(`${title}\n${body}`).digest('hex').slice(0, 16);
export function readGroomMemory(repo) {
    const p = join(repo, GROOM_STATE);
    if (!existsSync(p))
        return {};
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw))
            return {};
        const out = {};
        for (const [id, v] of Object.entries(raw)) {
            if (!v || typeof v !== 'object')
                continue;
            out[id] = {
                attempts: Number.isFinite(v.attempts) ? Number(v.attempts) : 0,
                lastAt: typeof v.lastAt === 'string' ? v.lastAt : '',
                why: typeof v.why === 'string' ? v.why : '',
                hash: typeof v.hash === 'string' ? v.hash : '',
            };
        }
        return out;
    }
    catch {
        // Forgetting is the safe failure: it costs one wasted retry, where
        // throwing would stop the night.
        return {};
    }
}
export function writeGroomMemory(repo, m) {
    const p = join(repo, GROOM_STATE);
    try {
        mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
        const tmp = `${p}.tmp`;
        writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n', 'utf8');
        renameSync(tmp, p);
    }
    catch { /* bookkeeping must never stop a night */ }
}
/**
 * Should grooming skip this task tonight?
 *
 * Only when it has been refused enough times AND the wording has not changed
 * since. Editing the task is the human answering, and that always earns a
 * fresh attempt.
 */
export function isExhausted(mem, id, hash, max = MAX_GROOM_ATTEMPTS) {
    const a = mem[id];
    if (!a)
        return false;
    if (a.hash && a.hash !== hash)
        return false; // reworded — try again
    return a.attempts >= max;
}
export function recordRefusal(mem, id, hash, why, now) {
    const prev = mem[id];
    // A reworded task starts its count again rather than inheriting the old one.
    const attempts = prev && prev.hash === hash ? prev.attempts + 1 : 1;
    return { ...mem, [id]: { attempts, lastAt: now.toISOString(), why, hash } };
}
/** Grooming succeeded, so nothing about the past matters any more. */
export function clearAttempt(mem, id) {
    if (!(id in mem))
        return mem;
    const next = { ...mem };
    delete next[id];
    return next;
}
/**
 * Tasks grooming has given up on. These are a worklist for a person, not a
 * failure — surfacing them is the whole point of remembering.
 */
export function needsDecision(mem, max = MAX_GROOM_ATTEMPTS) {
    return Object.entries(mem)
        .filter(([, a]) => a.attempts >= max)
        .map(([id, a]) => ({ id, why: a.why, attempts: a.attempts }))
        .sort((a, b) => a.id.localeCompare(b.id));
}
