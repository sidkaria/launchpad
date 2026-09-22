import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
export const RUN_PATH = join('.launchpad', 'nightshift', 'run.json');
export function readRunState(repo) {
    const p = join(repo, RUN_PATH);
    if (!existsSync(p))
        return null;
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof raw.pid !== 'number' || typeof raw.startedAt !== 'string')
            return null;
        return {
            startedAt: raw.startedAt,
            updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : raw.startedAt,
            pid: raw.pid,
            project: typeof raw.project === 'string' ? raw.project : '',
            phase: (raw.phase ?? 'starting'),
            taskId: typeof raw.taskId === 'string' ? raw.taskId : undefined,
            taskTitle: typeof raw.taskTitle === 'string' ? raw.taskTitle : undefined,
            finishedAt: typeof raw.finishedAt === 'string' ? raw.finishedAt : undefined,
        };
    }
    catch {
        // A half-written run file must not blank the project's whole row.
        return null;
    }
}
/** Atomic: the dashboard polls this file while the drain rewrites it. */
export function writeRunState(repo, s) {
    const p = join(repo, RUN_PATH);
    try {
        mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
        const tmp = `${p}.tmp`;
        writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', 'utf8');
        renameSync(tmp, p);
    }
    catch { /* status reporting must never be the thing that stops a night */ }
}
export function clearRunState(repo) {
    try {
        unlinkSync(join(repo, RUN_PATH));
    }
    catch { /* already gone */ }
}
/** Does this process exist? Signal 0 checks without delivering anything. */
export function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch {
        return false;
    }
}
/**
 * Beyond this, a live pid is assumed to be a reused one rather than our run.
 * Generous on purpose: a legitimate task may run for the whole window, and
 * calling a working night dead is worse than being slow to notice a crash.
 */
export const MAX_RUN_AGE_S = 12 * 3600;
export function liveness(s, now, isAlive = pidAlive, maxAgeS = MAX_RUN_AGE_S) {
    if (!s)
        return { state: 'never' };
    if (s.finishedAt)
        return { state: 'idle', endedAt: s.finishedAt };
    const sinceS = Math.max(0, Math.round((now.getTime() - new Date(s.updatedAt).getTime()) / 1000));
    const fresh = sinceS < maxAgeS;
    if (fresh && isAlive(s.pid)) {
        return { state: 'running', phase: s.phase, taskId: s.taskId, taskTitle: s.taskTitle, sinceS };
    }
    return { state: 'crashed', phase: s.phase, taskId: s.taskId, sinceS };
}
/** Human phrasing for a phase. Used by both the CLI and the dashboard. */
export function describePhase(p) {
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
