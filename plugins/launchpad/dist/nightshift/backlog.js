import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
export const BACKLOG_DIR = join('.launchpad', 'nightshift', 'backlog');
/**
 * A project may already keep tasks somewhere else in the same format. Pointing
 * at it beats copying: two backlogs diverge the moment either side is edited,
 * and whatever generates the project's roadmap keeps working untouched.
 *
 * Passed explicitly rather than held in module state: a single night drains
 * several projects in one process, and a global override set by one project
 * would silently send the next one's writes to the wrong directory.
 */
export const dirOf = (override) => override || BACKLOG_DIR;
// Must allow a sub-id suffix: real backlogs carve a task into T154b, T154e,
// T154f. Requiring digits at the end silently dropped six live tasks in one.
// Requiring at least one digit is what excludes ARCHITECTURE.md/HISTORY.md.
const TASK_FILE = /^[A-Za-z]*\d+[A-Za-z0-9._-]*\.md$/;
const ORDER = ['idea', 'scoped', 'ready', 'in_progress', 'done', 'blocked'];
export function isStatus(s) {
    return ORDER.includes(s);
}
/**
 * Deliberately hand-rolled rather than a YAML dependency: the frontmatter is a
 * flat map of scalars and one list, and a task file that a human edited badly
 * must degrade to a readable task rather than throwing and stalling the drain.
 */
export function parseTask(id, text) {
    // A BOM before the opening fence breaks `^---` exactly as CRLF does, and
    // arrives the same way: an editor on the same machine that produced the CRLF.
    const bom = text.charCodeAt(0) === 0xfeff;
    const src = bom ? text.slice(1) : text;
    // Whatever the file's first line break is, that is this file's convention.
    const eol = (/\r\n|\n/.exec(src)?.[0] ?? '\n');
    // Trailing spaces after a fence are common in hand-edited files and are not a
    // reason to treat the whole document as prose.
    const m = /^---[ \t]*(?:\r\n|\n)([\s\S]*?)(?:\r\n|\n)---[ \t]*(?:\r\n|\n)?/.exec(src);
    const body = m ? src.slice(m[0].length) : src;
    const task = { id, title: id, status: 'idea', body: body.trim(), eol, ...(bom ? { bom } : {}) };
    if (!m)
        return task;
    task.raw = body;
    // Split on either, so a CRLF file does not leave a stray `\r` on the end of
    // every value — which would survive parsing and be doubled on write.
    task.frontmatter = m[1].split(/\r?\n/);
    for (const line of task.frontmatter) {
        const kv = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
        if (!kv)
            continue;
        const [, key, raw] = kv;
        const value = raw.trim().replace(/^["']|["']$/g, '');
        switch (key) {
            case 'title':
                task.title = value || id;
                break;
            case 'status':
                if (isStatus(value))
                    task.status = value;
                break;
            // `P0`/`P1`/`P2` is the common convention and is what real backlogs use;
            // parsing only bare numbers silently dropped every priority in one.
            case 'priority': {
                const n = Number(/^P?(\d+)$/i.exec(value)?.[1] ?? NaN);
                if (Number.isFinite(n))
                    task.priority = n;
                break;
            }
            case 'created':
                task.created = value;
                break;
            case 'reason':
                task.reason = value;
                break;
            case 'depends_on':
                task.dependsOn = value.replace(/^\[|\]$/g, '').split(',').map(s => s.trim()).filter(Boolean);
                break;
        }
    }
    return task;
}
/**
 * Write a task back, editing in place rather than regenerating.
 *
 * Only `status` and `reason` are launchpad's to change; every other line is
 * returned exactly as it arrived, in its original order and formatting —
 * including `priority: P1`, which the canonical writer used to normalise to
 * `priority: 1` and break the project's own tooling.
 */
export function renderTask(t) {
    const nl = t.eol ?? '\n';
    const fm = t.frontmatter ? editFrontmatter(t.frontmatter, t) : freshFrontmatter(t);
    // `raw` is present whenever this task came off disk with frontmatter, so the
    // prose is returned exactly as it arrived. Only a task built from scratch
    // gets the canonical blank-line-then-body layout.
    const body = t.raw ?? `${nl}${t.body.trim()}${nl}`;
    return `${t.bom ? '﻿' : ''}---${nl}${fm.join(nl)}${nl}---${nl}${body}`;
}
const keyOf = (line) => /^([a-zA-Z_]+):/.exec(line)?.[1] ?? null;
/**
 * The ` # …` a human left on a line, so rewriting the value does not delete it.
 *
 * `status: ready  # do not auto-run` is somebody telling the agent something.
 * Dropping it while flipping the status is a small silent loss of exactly the
 * kind that makes a person stop trusting a tool with their files.
 *
 * Skipped when the value is quoted, where `#` is data rather than a comment.
 */
const trailingComment = (line) => {
    const value = line.slice(line.indexOf(':') + 1);
    if (/["']/.test(value))
        return '';
    return /(\s+#.*)$/.exec(value)?.[1] ?? '';
};
function editFrontmatter(original, t) {
    const out = [];
    let sawStatus = false;
    for (const line of original) {
        const key = keyOf(line);
        if (key === 'status') {
            out.push(`status: ${t.status}${trailingComment(line)}`);
            sawStatus = true;
            continue;
        }
        // A stale "blocked because X" on a ready task is read by the agent as a
        // live constraint, so the line goes rather than lingering.
        if (key === 'reason') {
            if (t.reason)
                out.push(`reason: ${t.reason}${trailingComment(line)}`);
            continue;
        }
        out.push(line);
    }
    if (!sawStatus)
        out.push(`status: ${t.status}`);
    if (t.reason && !out.some(l => keyOf(l) === 'reason'))
        out.push(`reason: ${t.reason}`);
    return out;
}
function freshFrontmatter(t) {
    const fm = [`title: ${t.title}`, `status: ${t.status}`];
    if (t.priority !== undefined)
        fm.push(`priority: ${t.priority}`);
    if (t.created)
        fm.push(`created: ${t.created}`);
    if (t.dependsOn?.length)
        fm.push(`depends_on: [${t.dependsOn.join(', ')}]`);
    if (t.reason)
        fm.push(`reason: ${t.reason}`);
    return fm;
}
export function readBacklog(repo, override) {
    const dir = join(repo, dirOf(override));
    if (!existsSync(dir))
        return [];
    const tasks = [];
    for (const name of readdirSync(dir).sort()) {
        // A task filename is an id: T010.md, 001.md. Real backlogs keep docs in
        // the same directory — ARCHITECTURE.md and HISTORY.md, in one real case — and
        // parsing those as tasks inflates every count and puts a design document
        // in the queue.
        if (!TASK_FILE.test(name))
            continue;
        try {
            tasks.push(parseTask(name.replace(/\.md$/, ''), readFileSync(join(dir, name), 'utf8')));
        }
        catch {
            // An unreadable file must not stall the whole drain.
        }
    }
    return tasks;
}
export function taskPath(repo, id, override) {
    return join(repo, dirOf(override), `${id}.md`);
}
/**
 * Write atomically. The drain writes a task file while an agent may be running
 * in the same tree, and a half-written frontmatter would parse as a task with
 * the wrong status — which, given the status drives what runs next, is the
 * worst possible corruption.
 */
export function writeTask(repo, t, override) {
    const p = taskPath(repo, t.id, override);
    mkdirSync(join(repo, dirOf(override)), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, renderTask(t), 'utf8');
    renameSync(tmp, p);
}
export function setStatus(repo, id, status, reason, override) {
    const p = taskPath(repo, id, override);
    if (!existsSync(p))
        return null;
    const t = parseTask(id, readFileSync(p, 'utf8'));
    t.status = status;
    if (reason)
        t.reason = reason;
    // Clearing the reason on unblock matters: a stale "blocked because X" on a
    // ready task is read by the agent as a live constraint.
    if (status !== 'blocked')
        delete t.reason;
    writeTask(repo, t, override);
    return t;
}
/**
 * Next id in the T001 sequence, so ids stay sortable and stable.
 *
 * Takes the override for the same reason every other write does: without it,
 * a project that adopted an existing backlog numbers from T001 against an
 * empty directory and collides with 305 tasks it never looked at.
 *
 * Matches leading digits rather than `^T(\d+)$`, because real backlogs carve a
 * task into `T154a`..`T154f` and an exact match ignores all six.
 */
export function nextId(repo, override) {
    const nums = readBacklog(repo, override)
        .map(t => /^[A-Za-z]*(\d+)/.exec(t.id)?.[1])
        .filter((s) => Boolean(s))
        .map(Number)
        .filter(Number.isFinite);
    return `T${String((nums.length ? Math.max(...nums) : 0) + 1).padStart(3, '0')}`;
}
export function addTask(repo, title, body = '', status = 'idea', now = new Date(), override) {
    const t = { id: nextId(repo, override), title, status, created: now.toISOString().slice(0, 10), body };
    writeTask(repo, t, override);
    return t;
}
/**
 * What to work on next.
 *
 * Only `ready` is eligible — `idea` and `scoped` have not been through
 * grooming, and running an un-scoped idea overnight is how an agent spends
 * four hours on something nobody wanted. A task whose dependencies are not
 * `done` is skipped rather than blocked: the dependency may land tonight.
 */
export function nextTask(tasks) {
    const done = new Set(tasks.filter(t => t.status === 'done').map(t => t.id));
    // An interrupted run leaves a task in_progress; resume it before starting new
    // work, or a crash mid-task silently drops it forever.
    const resumable = tasks.find(t => t.status === 'in_progress');
    if (resumable)
        return resumable;
    const eligible = tasks
        .filter(t => t.status === 'ready')
        .filter(t => (t.dependsOn ?? []).every(d => done.has(d)));
    if (!eligible.length)
        return null;
    return eligible.sort((a, b) => (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
        || a.id.localeCompare(b.id))[0];
}
export function summarize(tasks) {
    const n = (s) => tasks.filter(t => t.status === s).length;
    return {
        idea: n('idea'), scoped: n('scoped'), ready: n('ready'),
        in_progress: n('in_progress'), done: n('done'), blocked: n('blocked'),
        total: tasks.length,
    };
}
/** The brain-dump inbox — one file, appended to, triaged later. */
export const INBOX = join('.launchpad', 'nightshift', 'inbox.md');
export function addIdea(repo, text, now = new Date()) {
    const p = join(repo, INBOX);
    mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
    const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
    // Same rule as the task files above, for the same reason: appending an LF
    // line to a file a Windows checkout made CRLF leaves it mixed, and the
    // mixture is what `git diff` reports back to the user.
    const eol = (/\r\n|\n/.exec(existing)?.[0] ?? '\n');
    const line = `- [${now.toISOString().slice(0, 10)}] ${text.replace(/[\r\n]+/g, ' ').trim()}${eol}`;
    const head = existing || `# Inbox${eol}${eol}`;
    writeFileSync(p, head + line, 'utf8');
}
export function readInbox(repo) {
    const p = join(repo, INBOX);
    if (!existsSync(p))
        return [];
    // Split on either ending: a CRLF inbox would otherwise hand every idea back
    // with a trailing `\r`, which then rides into the task title grooming writes.
    return readFileSync(p, 'utf8').split(/\r?\n/).filter(l => l.startsWith('- ')).map(l => l.slice(2));
}
/**
 * Drop exactly the lines that became tasks.
 *
 * Not "clear the inbox": grooming can consume some lines and fail on others,
 * and truncating the file would silently discard whatever it did not get to.
 * Anything unmatched stays for the next pass.
 */
export function removeFromInbox(repo, consumed) {
    const p = join(repo, INBOX);
    if (!existsSync(p) || !consumed.length)
        return;
    const gone = new Set(consumed.map(s => s.trim()));
    const kept = readFileSync(p, 'utf8')
        .split('\n')
        .filter(l => !(l.startsWith('- ') && gone.has(l.slice(2).trim())));
    writeFileSync(p, kept.join('\n'), 'utf8');
}
export function conventionOf(tasks) {
    const withFm = tasks.filter(t => t.frontmatter?.length);
    if (!withFm.length) {
        return { keys: ['title', 'status', 'priority', 'created'], priorityPrefixed: false, listKeys: new Set() };
    }
    // The most common key ORDER, so a single hand-mangled file cannot redefine
    // the format for every task created afterwards.
    const tally = new Map();
    const listKeys = new Set();
    let prefixed = 0, priorities = 0;
    for (const t of withFm) {
        const keys = [];
        for (const line of t.frontmatter) {
            const m = /^([a-zA-Z_]+):\s*(.*)$/.exec(line);
            if (!m)
                continue;
            keys.push(m[1]);
            if (/^\[.*\]$/.test(m[2].trim()))
                listKeys.add(m[1]);
            if (m[1] === 'priority') {
                priorities++;
                if (/^P\d/i.test(m[2].trim()))
                    prefixed++;
            }
        }
        const sig = keys.join(',');
        const prev = tally.get(sig);
        if (prev)
            prev.count++;
        else
            tally.set(sig, { count: 1, keys });
    }
    const best = [...tally.values()].sort((a, b) => b.count - a.count)[0];
    return {
        keys: best.keys,
        priorityPrefixed: priorities > 0 && prefixed / priorities > 0.5,
        listKeys,
    };
}
/** Render a brand-new task in an existing backlog's own shape. */
export function frontmatterFor(c, values) {
    const known = {
        id: values.id,
        title: values.title,
        status: values.status,
        priority: values.priority === undefined
            ? undefined
            : c.priorityPrefixed ? `P${values.priority}` : String(values.priority),
        created: values.created,
    };
    const out = [];
    for (const key of c.keys) {
        const v = known[key];
        if (v !== undefined) {
            out.push(`${key}: ${v}`);
            continue;
        }
        // A field this backlog requires but launchpad knows nothing about. An empty
        // value of the right SHAPE keeps the project's validator happy; omitting it
        // is what breaks them.
        out.push(`${key}: ${c.listKeys.has(key) ? '[]' : ''}`);
    }
    // `id` and `title` are not optional even if the neighbours somehow lack them.
    for (const required of ['id', 'title', 'status']) {
        if (!c.keys.includes(required))
            out.push(`${required}: ${known[required]}`);
    }
    return out;
}
/**
 * Add a task directly, in the backlog's own convention.
 *
 * Distinct from `addIdea`: that captures a line for grooming to shape later,
 * this is someone who already knows what they want and is putting it straight
 * in the queue.
 */
export function createTask(repo, input, now = new Date(), override) {
    const existing = readBacklog(repo, override);
    const c = conventionOf(existing);
    const id = nextId(repo, override);
    const created = now.toISOString().slice(0, 10);
    const t = {
        id,
        title: input.title,
        status: input.status ?? 'ready',
        priority: input.priority,
        created,
        body: input.body?.trim() || input.title,
        frontmatter: frontmatterFor(c, { id, title: input.title, status: input.status ?? 'ready', priority: input.priority, created }),
    };
    writeTask(repo, t, override);
    return t;
}
/**
 * Change a task's priority, preserving the file's own notation.
 *
 * Priority is launchpad's to set — it decides what runs first — but `P1` vs `1`
 * is the project's, so the existing line's style is kept.
 */
export function setPriority(repo, id, priority, override) {
    const p = taskPath(repo, id, override);
    if (!existsSync(p))
        return null;
    const t = parseTask(id, readFileSync(p, 'utf8'));
    const fm = t.frontmatter ?? [];
    const line = fm.find(l => /^priority:/.test(l));
    const prefixed = line ? /^priority:\s*P\d/i.test(line) : conventionOf(readBacklog(repo, override)).priorityPrefixed;
    const rendered = `priority: ${prefixed ? 'P' : ''}${priority}${line ? trailingComment(line) : ''}`;
    t.priority = priority;
    if (t.frontmatter) {
        t.frontmatter = line
            ? t.frontmatter.map(l => (/^priority:/.test(l) ? rendered : l))
            // Insert after status, where every convention seen puts it.
            : t.frontmatter.flatMap(l => (/^status:/.test(l) ? [l, rendered] : [l]));
    }
    writeTask(repo, t, override);
    return t;
}
