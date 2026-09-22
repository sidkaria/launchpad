import { deriveOutcome } from './outcome.js';
import { nextAction } from './policy.js';
import { nextTask } from './backlog.js';
import { hooksToRun, violations } from './config.js';
/** Default ceiling for a post-drain hook. A deploy is minutes, not hours. */
export const HOOK_TIMEOUT_S = 1800;
const branchName = (taskId, d) => `nightshift/${taskId}-${d.toISOString().slice(0, 10)}`;
export function drain(host, opts) {
    const { config, project } = opts;
    const results = [];
    const statusChanges = [];
    const tasks = [...opts.tasks];
    const attempts = new Map();
    let consecutiveInfraFailures = 0;
    let halted;
    // Paths that actually reached a commit. Gated work that failed and was
    // reverted must never appear here — a post-drain deploy fired on rejected
    // changes would ship exactly what the gate refused.
    const committedPaths = new Set();
    const setStatus = (id, status, reason) => {
        const t = tasks.find(x => x.id === id);
        if (t) {
            t.status = status;
            if (reason)
                t.reason = reason;
        }
        statusChanges.push({ id, status, reason });
    };
    while (results.length < config.maxTasksPerNight) {
        if (host.now() >= opts.deadline) {
            halted = 'the window closed';
            break;
        }
        const task = nextTask(tasks);
        if (!task)
            break;
        // Marked in_progress BEFORE the agent starts, so a crash leaves a trail
        // and `nextTask` resumes it rather than losing it.
        setStatus(task.id, 'in_progress');
        if (config.mode === 'pr') {
            // From the BASE branch, never from wherever the last task left HEAD.
            // Otherwise each branch is cut from the previous one, so every pull
            // request contains the preceding task's commits and reviewing one means
            // reviewing all of them.
            host.checkoutBase(config.baseBranch);
            host.createBranch(branchName(task.id, host.now()));
        }
        const headBefore = host.head();
        host.setPhase('agent', task);
        const run = host.runAgent(task);
        // The gate runs BEFORE any commit, and only if the agent actually did
        // something. Committing first and checking after is how unreviewed code
        // reaches a branch.
        // Only what the agent did. The tree may have been dirty before the night
        // started — the lock serialises Nightshift against itself, not against its
        // owner — and attributing a human's edit to the agent gets a task blocked
        // for touching a protected path it never touched.
        const touched = host.changedByRun();
        let checkPassed;
        let pushed;
        let headAfter = headBefore;
        const blocked = violations(touched, config);
        if (blocked.length) {
            // Not negotiable and not partially recoverable: the whole attempt is
            // discarded, because an agent that edited a protected path has already
            // demonstrated it is not doing what was asked.
            host.log(`${task.id}: touched protected path(s) ${blocked.join(', ')} — discarding the attempt`);
            host.revert();
            setStatus(task.id, 'blocked', `modified protected path(s): ${blocked.join(', ')}`);
            results.push({ project, taskId: task.id, title: task.title, outcome: 'blocked', durationS: run.durationS });
            continue;
        }
        if (touched.length) {
            host.setPhase('gate', task);
            checkPassed = host.runGate();
            if (checkPassed) {
                host.setPhase('commit', task);
                headAfter = host.commit(`${task.title}\n\nNightshift: ${task.id}`, touched) || headBefore;
                if (headAfter !== headBefore) {
                    for (const f of touched)
                        committedPaths.add(f);
                    host.setPhase('publish', task);
                    pushed = host.publish(config.mode, branchName(task.id, host.now()));
                }
            }
            else {
                host.log(`${task.id}: gate failed — reverting`);
                host.revert();
            }
        }
        const facts = {
            exitCode: run.exitCode, durationS: run.durationS, headBefore, headAfter,
            pushed, checkPassed, log: run.log,
        };
        const outcome = deriveOutcome(facts);
        results.push({
            project, taskId: task.id, title: task.title, outcome,
            commit: headAfter !== headBefore ? headAfter.slice(0, 7) : undefined,
            durationS: run.durationS,
        });
        consecutiveInfraFailures = outcome === 'infra-failed' ? consecutiveInfraFailures + 1 : 0;
        const history = {
            outcomes: [...(attempts.get(task.id) ?? []), outcome],
            consecutiveInfraFailures,
        };
        attempts.set(task.id, history.outcomes);
        const action = nextAction(history);
        if (action.kind === 'abort') {
            // Put the task back so tomorrow picks it up; it was never attempted in
            // any meaningful sense.
            setStatus(task.id, 'ready');
            halted = action.reason;
            break;
        }
        if (action.kind === 'block') {
            setStatus(task.id, 'blocked', action.reason);
            continue;
        }
        if (action.kind === 'retry') {
            setStatus(task.id, 'ready');
            if (action.afterS)
                host.sleep(action.afterS);
            continue;
        }
        setStatus(task.id, outcome === 'blocked' ? 'blocked' : 'done');
    }
    if (!halted && results.length >= config.maxTasksPerNight)
        halted = 'nightly task cap reached';
    // Leave the repo where its owner left it. A night that ends on
    // `nightshift/T339-2026-07-31` means the next thing anyone does in that repo
    // — including their own commits — happens on a branch they never chose.
    if (config.mode === 'pr')
        host.checkoutBase(config.baseBranch);
    return { results, halted, statusChanges, hooks: runHooks(host, config, [...committedPaths], halted) };
}
/**
 * Post-drain hooks, last and least.
 *
 * Two conditions, both learned rather than chosen. It only fires on paths that
 * were **committed**, so a deploy never ships work the gate rejected. And it
 * does not fire at all when the drain aborted on infrastructure failure: at
 * that point the agent could not start, nothing meaningful landed, and running
 * a deploy is the least useful thing a broken machine could do next.
 */
function runHooks(host, config, paths, halted) {
    if (!config.postDrain.length)
        return [];
    const due = hooksToRun(config, paths);
    if (halted?.includes('failed to run')) {
        return due.map(h => ({ command: h.run, ok: false, skipped: 'the drain aborted before anything landed', durationS: 0 }));
    }
    return due.map(h => {
        host.setPhase('hook');
        host.log(`post-drain: ${h.run}`);
        const r = host.runHook(h.run, h.timeoutS ?? HOOK_TIMEOUT_S);
        return { command: h.run, ok: r.ok, durationS: r.durationS, log: r.ok ? undefined : r.log };
    });
}
