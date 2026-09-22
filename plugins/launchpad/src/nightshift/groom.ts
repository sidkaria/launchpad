import { dirOf, type Task, type TaskStatus } from './backlog.js';
import type { NightshiftConfig } from './config.js';
import { isExhausted, taskHash, type GroomMemory } from './groomstate.js';

/**
 * Grooming — the step that turns a brain dump into work an agent can execute.
 *
 * Without it the loop is not autonomous, it is half autonomous: the inbox
 * captures ideas all day, the drain only ever takes from `ready`, and a human
 * has to sit in the middle promoting `idea → scoped → ready` by hand. That gap
 * is why a backlog fills up and a night still reports an empty queue.
 *
 * Two halves, deliberately separated:
 *
 *   1. **Capture** is mechanical — an inbox line becomes a task file at status
 *      `idea`. No judgement, no agent, no cost, and it is pure so it can be
 *      tested without either.
 *   2. **Scoping** needs judgement, so it runs the agent. But it runs it with a
 *      brief that says "rewrite this one file" and nothing else, and the result
 *      is checked against the filesystem afterwards — because a grooming agent
 *      that starts implementing is the failure mode here, and asking it not to
 *      is not the same as stopping it.
 *
 * Scoping is capped per night. A 305-task backlog would otherwise spend the
 * entire window grooming and never build anything.
 */

export interface CapturedTask {
  id: string;
  title: string;
  body: string;
  /** The exact inbox line this came from, so only consumed lines are cleared. */
  source: string;
}

/** Long enough to be a real title, short enough to read in a list. */
const TITLE_MAX = 72;

/**
 * Inbox lines → task files, without an agent.
 *
 * `addIdea` writes lines as `[YYYY-MM-DD] text`; the date is stripped back out
 * into `created` rather than left in the title, where it would be repeated in
 * every listing.
 */
export function planCapture(inbox: string[], existingIds: string[], now: Date): CapturedTask[] {
  const out: CapturedTask[] = [];
  let n = highestId(existingIds);
  for (const raw of inbox) {
    const line = raw.trim();
    if (!line) continue;
    const dated = /^\[(\d{4}-\d{2}-\d{2})\]\s*(.*)$/.exec(line);
    const text = (dated ? dated[2] : line).trim();
    if (!text) continue;
    n += 1;
    const id = `T${String(n).padStart(3, '0')}`;
    // The whole line is kept as the body even when it is also the title: the
    // title is truncated for display and the agent must see the full thing.
    const title = text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1).trimEnd()}…` : text;
    out.push({
      id, title, source: raw,
      body: `${text}\n\n(captured ${dated ? dated[1] : now.toISOString().slice(0, 10)} from the inbox; not yet scoped)`,
    });
  }
  return out;
}

/**
 * Highest number used by any existing id.
 *
 * Reads the leading digits of any id, not `^T(\d+)$`: real backlogs carve a
 * task into `T154a`..`T154f`, and an exact match ignores all six — so the next
 * id would be `T154` again and collide with the task it was derived from.
 */
export function highestId(ids: string[]): number {
  const nums = ids
    .map(id => /^[A-Za-z]*(\d+)/.exec(id)?.[1])
    .filter((s): s is string => Boolean(s))
    .map(Number)
    .filter(Number.isFinite);
  return nums.length ? Math.max(...nums) : 0;
}

export interface GroomHost {
  now(): Date;
  setPhase(phase: 'grooming', task?: Task): void;
  /** Run the agent with the scoping brief. */
  runGroomAgent(task: Task): { exitCode: number; durationS: number; log: string };
  /** Repo-relative paths the last `runGroomAgent` call changed. */
  changedByAgent(): string[];
  /** Re-read a task from disk — the agent rewrote the file, so memory is stale. */
  readTask(id: string): Task | null;
  writeTask(t: Task): void;
  revert(): void;
  log(message: string): void;
}

export interface GroomOptions {
  config: NightshiftConfig;
  tasks: Task[];
  inbox: string[];
  /** Stop taking new grooming work at this instant. */
  deadline: Date;
  /** What grooming has already refused. Absent means it remembers nothing. */
  memory?: GroomMemory;
}

export interface GroomResult {
  captured: CapturedTask[];
  scoped: { id: string; from: TaskStatus; to: TaskStatus }[];
  skipped: { id: string; why: string }[];
  /** Refusals to persist: id → why, so the next night does not repeat them. */
  refused: { id: string; hash: string; why: string }[];
  /** Promoted, so any past refusal can be forgotten. */
  succeeded: string[];
  /** Passed over because grooming already gave up on them. Not attempts. */
  exhausted: { id: string; why: string }[];
  halted?: string;
}

/** Statuses grooming is allowed to promote a task to. */
const PROMOTABLE: TaskStatus[] = ['ready', 'blocked', 'scoped'];

export function groom(host: GroomHost, opts: GroomOptions): GroomResult {
  const { config } = opts;
  const backlog = dirOf(config.backlogDir).replace(/\/*$/, '/');
  const result: GroomResult = { captured: [], scoped: [], skipped: [], refused: [], succeeded: [], exhausted: [] };
  const memory = opts.memory ?? {};

  // Capture first, and unconditionally. It costs nothing, it is the step that
  // loses data if it is skipped, and a captured idea is useful even if the
  // scoping half never gets to run tonight.
  host.setPhase('grooming');
  const captured = planCapture(opts.inbox, opts.tasks.map(t => t.id), host.now());
  for (const c of captured) {
    host.writeTask({
      id: c.id, title: c.title, status: 'idea', body: c.body,
      created: host.now().toISOString().slice(0, 10),
    });
  }
  result.captured = captured;
  if (captured.length) host.log(`groom: captured ${captured.length} inbox line(s) as tasks`);

  /**
   * The candidates, minus the ones grooming has already given up on.
   *
   * The filter has to happen BEFORE the budget is applied, not after. A handful
   * of un-scopable tasks near the top of the backlog would otherwise fill the
   * nightly allowance every night and nothing behind them would ever be
   * reached — five tasks, five nights, five invocations each, and the rest of
   * the queue never seen.
   */
  const eligible = [
    ...captured.map(c => ({ id: c.id, status: 'idea' as TaskStatus, hash: taskHash(c.title, c.body) })),
    ...opts.tasks
      .filter(t => t.status === 'idea' || t.status === 'scoped')
      .map(t => ({ id: t.id, status: t.status, hash: taskHash(t.title, t.body) })),
  ];

  const queue: typeof eligible = [];
  for (const item of eligible) {
    if (isExhausted(memory, item.id, item.hash)) {
      result.exhausted.push({ id: item.id, why: memory[item.id].why });
      continue;
    }
    if (queue.length < Math.max(0, config.maxGroomPerNight)) queue.push(item);
  }
  if (result.exhausted.length) {
    host.log(`groom: skipping ${result.exhausted.length} task(s) already refused — they need a human decision`);
  }

  for (const item of queue) {
    if (host.now() >= opts.deadline) { result.halted = 'the window closed during grooming'; break; }

    const before = host.readTask(item.id);
    if (!before) { result.skipped.push({ id: item.id, why: 'task file disappeared' }); continue; }

    const run = host.runGroomAgent(before);
    const touched = host.changedByAgent();
    const strayed = touched.filter(f => !f.startsWith(backlog));
    if (strayed.length) {
      // The whole point of a separate grooming pass is that it writes prose,
      // not code. An agent that edited source during it has misunderstood the
      // job, and its edit has been through no gate at all.
      host.log(`groom ${item.id}: touched ${strayed.join(', ')} outside the backlog — discarding`);
      host.revert();
      const why = `wrote outside the backlog (${strayed.slice(0, 3).join(', ')})`;
      result.skipped.push({ id: item.id, why });
      result.refused.push({ id: item.id, hash: item.hash, why });
      continue;
    }

    const after = host.readTask(item.id);
    if (!after) { result.skipped.push({ id: item.id, why: 'task file was deleted' }); continue; }

    if (after.status === item.status || !PROMOTABLE.includes(after.status)) {
      // Not an error. An idea that genuinely cannot be scoped without a human
      // decision should stay where it is rather than be forced to `ready`,
      // where the drain would pick it up tonight.
      const why = run.exitCode === 0
        ? 'left un-promoted — it needs a human decision'
        : `the agent exited ${run.exitCode}`;
      result.skipped.push({ id: item.id, why });
      result.refused.push({ id: item.id, hash: item.hash, why });
      continue;
    }
    result.scoped.push({ id: item.id, from: item.status, to: after.status });
    result.succeeded.push(item.id);
    host.log(`groom ${item.id}: ${item.status} → ${after.status}`);
  }

  return result;
}

/**
 * The scoping brief.
 *
 * It says "do not write code" and it also does not need to be believed: the
 * caller diffs the tree afterwards and discards anything that reached outside
 * the backlog directory.
 */
export function buildGroomPrompt(repo: string, taskFile: string, task: Task): string {
  return [
    `You are grooming ONE backlog task in ${repo}. You are not implementing it.`,
    '',
    '# Read first',
    '- CLAUDE.md and STANDARDS.md, if they exist — a task must fit how this project works',
    `- ${taskFile}, the task you are grooming`,
    '',
    `# The raw idea (${task.id})`,
    task.title,
    task.body || '(nothing else was captured)',
    '',
    '# What to write',
    `Rewrite ONLY ${taskFile}. Keep the frontmatter format. Give it:`,
    '- a `title:` that names the change, specifically',
    '- `priority:` P0 (broken for users) / P1 (this release) / P2 (someday)',
    '- a body an engineer could execute in one sitting without asking a question:',
    '  what to change, which files, and how you would know it worked',
    '',
    '# Then set the status, honestly',
    '- `status: ready` — scoped, self-contained, and safe for an unattended agent',
    '- `status: scoped` — understood, but too large for one night. Say what it should be split into.',
    '- `status: blocked` with a `reason:` — it needs a decision, a credential, or a person.',
    '  Preferring `blocked` over a guess is correct; a vague `ready` task is how an',
    '  overnight agent spends four hours building the wrong thing.',
    '',
    '# Rules',
    `- Edit NOTHING except ${taskFile}. Do not write code. Do not run the build.`,
    '- Do not commit or push.',
    '- Investigating the codebase to scope the task properly is encouraged. Changing it is not.',
    '',
    'Begin.',
  ].join('\n');
}
