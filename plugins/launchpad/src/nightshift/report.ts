import { type Outcome, describe, reachedRemote } from './outcome.js';

/**
 * The morning report.
 *
 * The old one led with "**15** shipped", computed as `commits.length`. A commit
 * is not a ship: it had not been released, and in the cases that mattered it
 * had not even been pushed. Combined with per-task rows that echoed the
 * agent's self-reported status, the mail confidently described work that did
 * not exist.
 *
 * The rules here:
 *   1. Never use a word stronger than the evidence. `pushed` means a push
 *      returned zero. Nothing in this file says "shipped".
 *   2. Infra failures are counted and named SEPARATELY from task failures.
 *      Fifteen tasks that never ran is a broken machine, not a bad backlog,
 *      and the report has to make that impossible to misread.
 *   3. A night where nothing ran says so first, loudly.
 */

export interface TaskResult {
  project: string;
  taskId: string;
  title: string;
  outcome: Outcome;
  commit?: string;
  durationS: number;
}

/** A post-drain hook that fired, or was due and deliberately skipped. */
export interface HookResult {
  command: string;
  ok: boolean;
  durationS: number;
  /** Set when it did not run at all, with the reason. */
  skipped?: string;
  /** Output, kept only on failure — it is the whole reason to read the report. */
  log?: string;
}

/** What grooming did, per project. */
export interface GroomSummary {
  project: string;
  captured: number;
  scoped: number;
  skipped: number;
}

export interface NightReport {
  date: string;
  results: TaskResult[];
  /** Set when the drain aborted or never started, with the reason. */
  halted?: string;
  hooks?: HookResult[];
  groom?: GroomSummary[];
}

export interface Tally {
  pushed: number;
  committed: number;
  blocked: number;
  noChange: number;
  infraFailed: number;
  timedOut: number;
  total: number;
}

export function tally(results: TaskResult[]): Tally {
  const count = (o: Outcome) => results.filter(r => r.outcome === o).length;
  return {
    pushed: count('pushed'),
    committed: count('committed'),
    blocked: count('blocked'),
    noChange: count('no-change'),
    infraFailed: count('infra-failed'),
    timedOut: count('timed-out'),
    total: results.length,
  };
}

/**
 * The one-line verdict. This is the subject line and the first thing read, so
 * it must never be more optimistic than the night was.
 */
/** Grooming totals across every project. */
export function groomTotals(r: NightReport): { captured: number; scoped: number; skipped: number } {
  const g = r.groom ?? [];
  return {
    captured: g.reduce((n, x) => n + x.captured, 0),
    scoped: g.reduce((n, x) => n + x.scoped, 0),
    skipped: g.reduce((n, x) => n + x.skipped, 0),
  };
}

export function headline(r: NightReport): string {
  const t = tally(r.results);
  const g = groomTotals(r);
  // Grooming is real work and a night that only groomed is not an idle night.
  // Reporting it as "nothing ran" is the same class of mistake as reporting a
  // commit as a ship — just in the other direction.
  const groomed = g.scoped ? `groomed ${g.scoped}` : g.captured ? `captured ${g.captured}` : '';

  if (r.halted) return `Nothing ran — ${r.halted}`;
  if (t.total === 0) {
    return groomed
      ? `Nothing built; ${groomed} task(s) for tomorrow.`
      : 'Nothing ran: the queue was empty.';
  }
  // An entirely failed night must never be summarised by its zero successes.
  if (t.infraFailed === t.total) {
    return `Nothing ran: the agent failed to start ${t.total} time(s). The backlog is untouched.`;
  }
  const parts = [`${t.pushed} pushed`];
  if (t.committed) parts.push(`${t.committed} committed but NOT pushed`);
  if (t.blocked) parts.push(`${t.blocked} blocked`);
  if (t.noChange) parts.push(`${t.noChange} no change`);
  if (t.timedOut) parts.push(`${t.timedOut} timed out`);
  if (t.infraFailed) parts.push(`${t.infraFailed} could not run`);
  // A failed deploy hook belongs in the subject line: the work landed and did
  // not go out, which reads as a success from every other angle.
  if ((r.hooks ?? []).some(h => !h.ok)) parts.push('post-drain FAILED');
  return parts.join(' · ');
}

/**
 * Things the user should act on. Anything here is a claim that something is
 * wrong with the setup rather than with the work.
 */
export function warnings(r: NightReport): string[] {
  const t = tally(r.results);
  const out: string[] = [];
  if (r.halted) out.push(r.halted);
  if (t.committed > 0) {
    out.push(
      `${t.committed} task(s) committed but never reached the remote — nothing else can see that ` +
      `work, and the next run may rebase over it. Check the push credentials.`,
    );
  }
  if (t.infraFailed > 0 && t.infraFailed < t.total) {
    out.push(
      `${t.infraFailed} task(s) never ran (auth, usage limit or network). They were NOT blocked and ` +
      `are still queued.`,
    );
  }
  if (t.timedOut > 0) {
    out.push(`${t.timedOut} task(s) hit the time limit — likely too large as scoped.`);
  }
  for (const h of r.hooks ?? []) {
    if (h.skipped) { out.push(`post-drain \`${h.command}\` did not run: ${h.skipped}`); continue; }
    if (!h.ok) {
      out.push(
        `post-drain \`${h.command}\` FAILED after ${h.durationS}s. The commits landed; whatever this ` +
        `command delivers did not.`,
      );
    }
  }
  const g = groomTotals(r);
  if (g.skipped > 0) {
    out.push(
      `${g.skipped} task(s) could not be groomed — they need a decision a human has to make, and are ` +
      `still sitting at idea/scoped.`,
    );
  }
  return out;
}

export function renderText(r: NightReport): string {
  const out = [`Nightshift — ${r.date}`, '', headline(r), ''];
  for (const w of warnings(r)) out.push(`  ! ${w}`);
  if (warnings(r).length) out.push('');

  const byProject = new Map<string, TaskResult[]>();
  for (const t of r.results) {
    if (!byProject.has(t.project)) byProject.set(t.project, []);
    byProject.get(t.project)!.push(t);
  }
  for (const [project, tasks] of byProject) {
    out.push(`${project}`);
    for (const t of tasks) {
      const mark = reachedRemote(t.outcome) ? '✓' : t.outcome === 'blocked' ? '−' : '✗';
      const commit = t.commit ? ` (${t.commit})` : '';
      out.push(`  ${mark} ${t.taskId} — ${t.title}`);
      out.push(`      ${describe(t.outcome)}${commit}, ${Math.round(t.durationS / 60)}m`);
    }
    out.push('');
  }
  return out.join('\n').trimEnd() + '\n';
}

const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function renderHtml(r: NightReport): string {
  const rows = r.results.map(t => {
    const colour = reachedRemote(t.outcome) ? '#5E8C42' : t.outcome === 'blocked' ? '#9B9588' : '#C2553B';
    return `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee">` +
      `<strong>${esc(t.project)}</strong> ${esc(t.taskId)}<br>` +
      `<span style="font-size:13px">${esc(t.title)}</span></td>` +
      `<td style="padding:6px 10px;border-bottom:1px solid #eee;color:${colour};font-size:13px;white-space:nowrap">` +
      `${esc(describe(t.outcome))}</td></tr>`;
  }).join('');
  const warn = warnings(r).map(w =>
    `<p style="margin:6px 0;padding:8px 10px;background:#FDF3E7;border-left:3px solid #D9A23B;font-size:14px">${esc(w)}</p>`,
  ).join('');
  return [
    `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:640px">`,
    `<h2 style="margin:0 0 4px">Nightshift — ${esc(r.date)}</h2>`,
    `<p style="margin:0 0 14px;font-size:15px;color:#4A453C">${esc(headline(r))}</p>`,
    warn,
    r.results.length ? `<table style="border-collapse:collapse;width:100%">${rows}</table>` : '',
    `</div>`,
  ].join('');
}

export function subject(r: NightReport): string {
  return `Nightshift ${r.date} — ${headline(r)}`;
}
