import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launchpadHome } from '../home.js';
import { join } from 'node:path';
import { readRegistry } from '../registry.js';
import { readBacklog, readInbox, removeFromInbox, setStatus } from './backlog.js';
import { readConfig, inWindow, readiness } from './config.js';
import { drain } from './drain.js';
import { groom } from './groom.js';
import { makeHost } from './host.js';
import { preflight } from './policy.js';
import { readGroomMemory, writeGroomMemory, recordRefusal, clearAttempt } from './groomstate.js';
import { liveness, readRunState, writeRunState } from './runstate.js';
import { renderText, renderHtml, subject, } from './report.js';
export function runNight(opts = {}) {
    const now = opts.now ?? new Date();
    const registry = readRegistry(opts.home);
    const skipped = [];
    const results = [];
    const ran = [];
    const hooks = [];
    const groomed = [];
    let halted;
    const configs = registry.projects.map(p => ({ path: p.path, config: readConfig(p.path) }));
    const enabled = configs.filter(c => c.config?.enabled).map(c => c.path);
    const pre = preflight(enabled, registry.projects.map(p => p.path));
    if (!pre.ok) {
        return { report: { date: now.toISOString().slice(0, 10), results: [], halted: pre.message }, skipped, ran };
    }
    for (const { path, config } of configs) {
        const name = path.split('/').filter(Boolean).pop() ?? path;
        if (!config?.enabled) {
            skipped.push({ project: name, why: 'disabled' });
            continue;
        }
        const r = readiness(config);
        if (!r.ok) {
            skipped.push({ project: name, why: r.problems.join('; ') });
            continue;
        }
        if (!inWindow(config, now)) {
            skipped.push({ project: name, why: `outside the ${config.window} window` });
            continue;
        }
        /**
         * THE LOCK. A previous tick may still be working in this repo.
         *
         * The scheduler fires every 30 minutes and a single task may run for
         * `taskTimeoutS` (an hour by default), so overlap is not an edge case — it
         * is the arithmetic. Two drains in one repo means two agents editing the
         * same worktree while each one's `revert()` throws away the other's work
         * and each one's `commit()` stages it: the failure is silent, and it
         * corrupts rather than stops.
         *
         * `RunOptions.lockPath` has been declared since this file was written and
         * was never read, and the header comment above claims the lock is
         * "re-checked here". It was not. `liveness()` already answers exactly this
         * question — a pid that exists, a run that never wrote `finishedAt` — so
         * the guard is a call, not a new mechanism.
         *
         * Skipping is the whole behaviour. The next tick is thirty minutes away
         * and the window is eight hours long, so a busy project simply gets picked
         * up later; killing the incumbent to start fresh would throw away an
         * hour of real work to gain nothing.
         */
        const live = liveness(readRunState(path), now);
        if (live.state === 'running') {
            const mins = Math.round(live.sinceS / 60);
            skipped.push({
                project: name,
                why: `already running (${live.phase}${live.taskId ? ` on ${live.taskId}` : ''}, ${mins}m) — leaving it alone`,
            });
            continue;
        }
        // The host must share the caller's clock; two clocks meant the drain
        // compared a real `now` against an injected deadline.
        const host = makeHost({ repo: path, config, now: () => now, agentBin: opts.agentBin, sleep: opts.sleep });
        // Every project gets the rest of the window; the drain stops itself when
        // the queue empties, so a quiet project costs nothing and does not eat the
        // budget of the next one.
        const deadline = windowEnd(config.window, now);
        ran.push({ project: name, path });
        // Publish that this project is live BEFORE any work, so a crash in the
        // first second is still distinguishable from "never ran".
        writeRunState(path, {
            startedAt: now.toISOString(), updatedAt: now.toISOString(),
            pid: process.pid, project: name, phase: 'starting',
        });
        // Grooming runs BEFORE the drain, on purpose. An idea captured this
        // afternoon is only buildable tonight if something promoted it to `ready`
        // first, and a separate 22:45 scheduler entry to do that is one more thing
        // to install on three operating systems and one more thing to break.
        if (config.groom) {
            let memory = readGroomMemory(path);
            const g = groom(host, {
                config, deadline, memory,
                tasks: readBacklog(path, config.backlogDir),
                inbox: readInbox(path),
            });
            // Only lines that became task files are cleared, so a grooming pass that
            // died halfway does not take the un-captured ideas with it.
            removeFromInbox(path, g.captured.map(c => c.source));
            // Remember tonight's refusals so tomorrow reaches further down the queue.
            for (const r of g.refused)
                memory = recordRefusal(memory, r.id, r.hash, r.why, now);
            for (const id of g.succeeded)
                memory = clearAttempt(memory, id);
            writeGroomMemory(path, memory);
            groomed.push({ project: name, captured: g.captured.length, scoped: g.scoped.length, skipped: g.skipped.length });
        }
        // Read AFTER grooming: tasks promoted to `ready` a moment ago are exactly
        // the ones tonight should build.
        const tasks = readBacklog(path, config.backlogDir);
        const out = drain(host, { project: name, repo: path, config, tasks, deadline });
        // Statuses are persisted HERE, not inside the drain: the drain must stay
        // free of side effects so its ordering can be tested without a filesystem.
        for (const change of out.statusChanges)
            setStatus(path, change.id, change.status, change.reason, config.backlogDir);
        results.push(...out.results);
        hooks.push(...out.hooks);
        if (out.halted) {
            halted = `${name}: ${out.halted}`;
        }
        appendEvents(path, out.results, now);
        // `finishedAt` is what separates a clean end from a crash. Without it a
        // dead pid is indistinguishable from a finished one.
        const rs = readRunState(path);
        if (rs)
            writeRunState(path, { ...rs, phase: 'finished', updatedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), taskId: undefined, taskTitle: undefined });
    }
    return {
        report: { date: now.toISOString().slice(0, 10), results, halted, hooks, groom: groomed },
        skipped, ran,
    };
}
function windowEnd(window, now) {
    const m = /-(\d{1,2}):(\d{2})$/.exec(window);
    if (!m)
        return new Date(now.getTime() + 8 * 3600_000);
    const end = new Date(now);
    end.setHours(Number(m[1]), Number(m[2]), 0, 0);
    if (end <= now)
        end.setDate(end.getDate() + 1); // the window wraps past midnight
    return end;
}
/** Append-only history, in the project's repo. The morning report reads it. */
function appendEvents(repo, results, now) {
    if (!results.length)
        return;
    try {
        mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
        const lines = results.map(r => JSON.stringify({ ts: now.toISOString(), ...r })).join('\n');
        appendFileSync(join(repo, '.launchpad', 'nightshift', 'events.jsonl'), lines + '\n', 'utf8');
    }
    catch { /* never let bookkeeping stop the night */ }
}
/**
 * Write the morning report next to the logs. Delivery (email, a push
 * notification, the dashboard) is a separate concern with a separate failure
 * mode — the report existing on disk must not depend on an SMTP server.
 */
export function writeReport(dir, report) {
    const text = renderText(report);
    const html = renderHtml(report);
    try {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'last-night.md'), text, 'utf8');
        writeFileSync(join(dir, 'last-night.html'), html, 'utf8');
    }
    catch { /* the caller still gets the strings */ }
    return { text, html };
}
/**
 * Every report the night should leave behind.
 *
 * One per project, holding only that project's rows — a cross-project summary
 * committed into one customer's repo leaks the names of the others — plus one
 * machine-level report covering the whole night, which is what the morning
 * actually wants to read and what the dashboard renders.
 */
export function writeReports(summary, home = launchpadHome()) {
    const date = summary.report.date;
    /**
     * Rendered from the append-only event log, not from this tick alone.
     *
     * The scheduler fires every 30 minutes, and each tick used to overwrite
     * `last-night.md` with only its own results. So a night that blocked four
     * tasks at 23:43 was replaced at 04:41 by a quiet tick that found an empty
     * queue, and the morning report read:
     *
     *     Nothing ran: the queue was empty.
     *
     * That is the exact failure this system was built to end — a report more
     * comfortable than the night it describes — arriving through the back door.
     * The events are already append-only and already written before this runs,
     * so replaying the day's is both the truth and free.
     */
    const allToday = [];
    for (const { project, path } of summary.ran) {
        const mine = eventsOn(path, date);
        allToday.push(...mine);
        writeReport(join(path, '.launchpad', 'nightshift'), {
            ...summary.report,
            results: mine,
            groom: summary.report.groom?.filter(g => g.project === project),
        });
    }
    return writeReport(join(home, '.launchpad', 'nightshift'), { ...summary.report, results: allToday });
}
/** Every result recorded for this project on this date. */
export function eventsOn(repo, date) {
    const p = join(repo, '.launchpad', 'nightshift', 'events.jsonl');
    if (!existsSync(p))
        return [];
    try {
        return readFileSync(p, 'utf8').split('\n').filter(Boolean)
            .map(l => JSON.parse(l))
            .filter(r => r.ts.slice(0, 10) === date)
            .map(({ ts, ...rest }) => rest);
    }
    catch {
        return [];
    }
}
export { subject };
