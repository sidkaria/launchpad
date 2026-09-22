import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dirOf, parseTask, taskPath, writeTask } from './backlog.js';
import { buildGroomPrompt } from './groom.js';
import { readRunState, writeRunState } from './runstate.js';
const MAX_LOG_CAPTURE = 200_000;
export function makeHost(o) {
    const { repo, config } = o;
    const agentBin = o.agentBin ?? process.env.LAUNCHPAD_AGENT_BIN ?? 'claude';
    const logFile = o.logFile ?? join(repo, '.launchpad', 'nightshift', 'nightshift.log');
    const backlogRel = dirOf(config.backlogDir).replace(/\/*$/, '/');
    /**
     * Directories `revert` must never undo.
     *
     * `.launchpad/` was always here. The backlog is the addition, and it matters
     * once grooming exists: an adopted backlog lives OUTSIDE `.launchpad`, at
     * whatever path that project already used, and its task files are tracked —
     * so a plain `git checkout -- .` after a gate failure would silently roll back
     * the whole night's grooming along with the failed attempt.
     */
    const preserved = [...new Set(['.launchpad/', backlogRel])];
    const isPreserved = (f) => preserved.some(p => f.startsWith(p));
    const gitRaw = (...args) => {
        try {
            return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        }
        catch {
            return '';
        }
    };
    const git = (...args) => gitRaw(...args).trim();
    const gitOk = (...args) => {
        const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
        return r.status === 0;
    };
    /** Untracked files, relative to the repo root. */
    const untracked = () => gitRaw('ls-files', '--others', '--exclude-standard').split('\n').map(l => l.trim()).filter(Boolean);
    /**
     * Untracked files that were present BEFORE this attempt started. These are
     * the human's — a draft, an un-added spec — or Nightshift's own backlog, and
     * revert must never destroy them.
     */
    let foreignUntracked = new Set();
    const log = (message) => {
        const line = `[${new Date().toISOString()}] ${message}\n`;
        try {
            mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
            appendFileSync(logFile, line, 'utf8');
        }
        catch { /* logging must never be the thing that stops the night */ }
        process.stderr.write(line);
    };
    /**
     * Untracked files count. A task that adds a new file and nothing else would
     * otherwise look like "the agent did nothing", and be retried and eventually
     * blocked with its work sitting on disk.
     *
     * Uses the RAW output: porcelain v1 is `XY PATH`, and an unstaged edit
     * begins with a space (` M README.md`). Trimming the whole output eats that
     * leading space on the first line only, so `slice(3)` then swallows a
     * character of the filename — which silently defeats the protected-path
     * check for whichever file happens to be listed first.
     */
    const changedFiles = () => gitRaw('status', '--porcelain', '--untracked-files=all')
        .split('\n')
        .filter(l => l.length > 3)
        .map(l => l.slice(3).trim())
        // A rename reads as `old -> new`; the new path is what was written.
        .map(p => (p.includes(' -> ') ? p.split(' -> ')[1] : p))
        // Paths with odd characters come back quoted.
        .map(p => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
        .filter(Boolean);
    /**
     * The tree as it stood when the grooming agent started.
     *
     * Grooming runs after capture has already written new task files, so a plain
     * `changedFiles()` would report those as the agent's doing and every groom
     * would be discarded for straying outside the backlog.
     */
    let beforeGroom = new Set();
    /**
     * The dirty tree as it stood when THIS attempt started.
     *
     * Without it, everything already modified in the working tree is attributed
     * to the agent: a half-finished edit of your own gets committed into a task's
     * commit, and — worse — a pre-existing change to a protected path blocks the
     * first task of the night with a reason that is simply untrue. The lock
     * serialises Nightshift against itself, never against its owner, so the tree
     * genuinely can be dirty when a night begins.
     */
    let beforeAgent = new Set();
    return {
        now: o.now ?? (() => new Date()),
        head: () => git('rev-parse', 'HEAD'),
        changedFiles,
        runAgent(task) {
            // Snapshot before the agent touches anything: everything untracked right
            // now is somebody else's and is off-limits to revert, and everything
            // already modified is somebody else's and is off-limits to commit.
            foreignUntracked = new Set(untracked());
            beforeAgent = new Set(changedFiles());
            const started = Date.now();
            const prompt = buildPrompt(repo, config, task);
            const r = spawnSync(agentBin, [
                ...(config.model ? ['--model', config.model] : []),
                '--dangerously-skip-permissions',
                '--print', prompt,
            ], {
                cwd: repo,
                encoding: 'utf8',
                timeout: config.taskTimeoutS * 1000,
                killSignal: 'SIGKILL',
                maxBuffer: MAX_LOG_CAPTURE,
            });
            const durationS = Math.round((Date.now() - started) / 1000);
            // The agent CLI exits 0 even on an auth failure, so the log is the only
            // signal — which is exactly why deriveOutcome reads it rather than
            // trusting the exit code. Capture both streams.
            const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`;
            const exitCode = r.signal === 'SIGKILL' || r.error?.name === 'TimeoutError' ? 124 : (r.status ?? 1);
            // "exited 1 after 0s" is what a missing binary looks like, and it reads
            // as the agent failing rather than as never having been found. Four
            // nights were spent on that ambiguity; name it instead.
            const missing = r.error?.code === 'ENOENT';
            if (missing) {
                log(`${task.id}: agent binary "${agentBin}" NOT FOUND. A scheduled job gets a minimal PATH — `
                    + 'reinstall the schedule with `nightshift schedule`, which sets one that includes it.');
            }
            else {
                log(`${task.id}: agent exited ${exitCode} after ${durationS}s`);
            }
            return { exitCode, durationS, log: missing ? `${out}\nagent binary not found: ${agentBin}` : out };
        },
        runGroomAgent(task) {
            beforeGroom = new Set(changedFiles());
            foreignUntracked = new Set(untracked());
            const started = Date.now();
            const prompt = buildGroomPrompt(repo, join(dirOf(config.backlogDir), `${task.id}.md`), task);
            const r = spawnSync(agentBin, [
                ...(config.model ? ['--model', config.model] : []),
                '--dangerously-skip-permissions',
                '--print', prompt,
            ], {
                cwd: repo,
                encoding: 'utf8',
                // Grooming is reading and writing one markdown file. Giving it the full
                // task budget is how a groom pass quietly consumes the build window.
                timeout: Math.min(config.taskTimeoutS, 600) * 1000,
                killSignal: 'SIGKILL',
                maxBuffer: MAX_LOG_CAPTURE,
            });
            const durationS = Math.round((Date.now() - started) / 1000);
            const exitCode = r.signal === 'SIGKILL' || r.error?.name === 'TimeoutError' ? 124 : (r.status ?? 1);
            log(`groom ${task.id}: agent exited ${exitCode} after ${durationS}s`);
            return { exitCode, durationS, log: `${r.stdout ?? ''}\n${r.stderr ?? ''}` };
        },
        changedByAgent: () => changedFiles().filter(f => !beforeGroom.has(f)),
        /**
         * What the AGENT changed — the current dirty set minus what was already
         * dirty. A file both the human and the agent touched counts as the
         * human's and is left alone: refusing to commit work is recoverable,
         * committing someone else's half-finished edit unattended is not.
         */
        changedByRun: () => changedFiles().filter(f => !beforeAgent.has(f)),
        /**
         * Record the current phase. Best-effort by design: this exists so an
         * observer can tell a working night from a dead one, and a failure to
         * report status must never be what stops the night.
         */
        setPhase(phase, task) {
            const prev = readRunState(repo);
            writeRunState(repo, {
                startedAt: prev?.startedAt ?? new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                pid: process.pid,
                project: prev?.project ?? repo.split('/').filter(Boolean).pop() ?? repo,
                phase,
                taskId: task?.id,
                taskTitle: task?.title,
            });
        },
        readTask(id) {
            const p = taskPath(repo, id, config.backlogDir);
            if (!existsSync(p))
                return null;
            try {
                return parseTask(id, readFileSync(p, 'utf8'));
            }
            catch {
                return null;
            }
        },
        writeTask: (t) => writeTask(repo, t, config.backlogDir),
        /**
         * A post-drain hook. Runs only after the night's work is committed, and
         * its failure is reported rather than thrown: a deploy that did not go out
         * is worth waking up to, but it does not retroactively make the code that
         * landed any less landed.
         */
        runHook(command, timeoutS) {
            const started = Date.now();
            const r = spawnSync(command, { cwd: repo, shell: true, encoding: 'utf8', timeout: timeoutS * 1000 });
            const ok = r.status === 0;
            const durationS = Math.round((Date.now() - started) / 1000);
            log(`post-drain \`${command}\` ${ok ? 'ok' : `FAILED (${r.status ?? 'timeout'})`} after ${durationS}s`);
            return { ok, durationS, log: `${r.stdout ?? ''}\n${r.stderr ?? ''}`.slice(-4000) };
        },
        /**
         * Run the gate through the shell, from the repo root, with the agent's
         * output discarded. Its exit status is the only thing that matters and the
         * only thing read.
         */
        runGate() {
            if (!config.gate.trim())
                return false;
            const r = spawnSync(config.gate, {
                cwd: repo, shell: true, encoding: 'utf8', timeout: config.taskTimeoutS * 1000,
            });
            const passed = r.status === 0;
            log(`gate \`${config.gate}\` ${passed ? 'passed' : `FAILED (${r.status})`}`);
            return passed;
        },
        commit(message, paths) {
            // Explicit paths, never a blanket `add -A`. A bare `-A` stages whatever
            // the human left in the tree and buries it inside a task's commit, under
            // a message describing work it has nothing to do with.
            if (!paths.length)
                return '';
            // `-A --` so deletions and new files among THOSE paths are included; a
            // partial commit would leave a tree the gate never actually validated.
            if (!gitOk('add', '-A', '--', ...paths))
                return '';
            if (!gitOk('commit', '-m', message))
                return ''; // nothing staged → no commit
            return git('rev-parse', 'HEAD');
        },
        publish(mode, branch) {
            if (mode === 'push') {
                const ok = gitOk('push', 'origin', 'HEAD');
                log(ok ? `pushed to ${config.baseBranch}` : 'push FAILED');
                return ok;
            }
            if (!gitOk('push', '-u', 'origin', branch)) {
                log(`push of ${branch} FAILED`);
                return false;
            }
            // A PR is a nicety; the work is already safely on the remote branch
            // without it, so a missing or unauthenticated `gh` must not turn a
            // successful night into a reported failure.
            const pr = spawnSync('gh', ['pr', 'create', '--fill', '--base', config.baseBranch, '--head', branch], { cwd: repo, encoding: 'utf8' });
            if (pr.status !== 0)
                log(`branch ${branch} pushed, but opening a PR failed — open it by hand`);
            return true;
        },
        /**
         * Undo the attempt — and ONLY the attempt.
         *
         * A blanket `git clean -fd` was the first implementation and it was
         * dangerous in two directions at once. It deletes every untracked file,
         * which includes **Nightshift's own backlog**: task files are untracked
         * until someone commits them, so the first gate failure of the night would
         * silently delete the queue it was working from. It also destroys whatever
         * the human left in the tree — a draft, an un-added spec — because the lock
         * only serialises Nightshift against itself, not against its owner.
         *
         * So: tracked files are restored, and of the untracked files only those
         * that appeared DURING this attempt are removed. Anything that was already
         * there when the agent started is foreign and is left alone. `.launchpad`
         * is never touched at all.
         */
        revert() {
            gitOk('restore', '--staged', '.');
            // Restore tracked files by path rather than `checkout -- .`, so the
            // backlog survives. An adopted backlog is tracked and lives outside
            // `.launchpad/`, and a blanket checkout would roll the night's grooming
            // back along with the failed attempt.
            // Tracked files only. `git checkout -- a b` fails outright if ANY
            // pathspec is untracked, so including a file the agent created would
            // leave every real edit un-reverted.
            const isUntracked = new Set(untracked());
            const dirty = changedFiles().filter(f => !isPreserved(f) && !isUntracked.has(f));
            if (dirty.length)
                gitOk('checkout', '--', ...dirty);
            const created = untracked().filter(f => !foreignUntracked.has(f) && !isPreserved(f));
            if (created.length)
                gitOk('clean', '-fd', '--', ...created);
        },
        createBranch(name) {
            gitOk('checkout', '-B', name);
        },
        checkoutBase(branch) {
            // Best-effort: if the base branch cannot be checked out — a conflicting
            // local change, a detached head — saying so beats failing the night for
            // a bookkeeping step.
            if (!gitOk('checkout', branch))
                log(`could not return to ${branch}`);
        },
        log,
        sleep: o.sleep ?? ((seconds) => {
            // Deliberately blocking: the drain is a batch job, and an async sleep
            // would let a second scheduler tick overlap this one.
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
        }),
    };
}
/**
 * The agent's brief. It states the gate as non-negotiable and names the
 * protected paths, but neither is enforced here — the drain checks both after
 * the fact, because a rule an agent can read is a rule an agent can rationalise.
 */
export function buildPrompt(repo, config, task) {
    return [
        `You are the overnight Nightshift agent working in ${repo}.`,
        '',
        '# Read first',
        '- CLAUDE.md (the project\'s operating manual) if it exists',
        '- STANDARDS.md if it exists',
        '',
        `# Your task: ${task.id} — ${task.title}`,
        task.body || '(no further detail was given; use your judgement and keep the change small)',
        '',
        '# Rules',
        `- Run \`${config.gate}\` before you finish. It MUST exit 0. NEVER edit it to make it pass.`,
        '- Do not modify: ' + [...config.protectedPaths, '.launchpad/', '.github/workflows/'].join(', '),
        '- Do NOT commit or push. Leave your work uncommitted; the runner commits only if the gate passes.',
        '- If you cannot complete it honestly, leave the tree clean and say why. A task returned',
        '  untouched is a fine outcome; a task faked as done is not.',
        '- Change one thing. This is a single task, not a refactor.',
        '',
        'Begin.',
    ].join('\n');
}
