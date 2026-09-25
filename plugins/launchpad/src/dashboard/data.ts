import { existsSync, readFileSync } from 'node:fs';
import { launchpadHome } from '../home.js';
import { join } from 'node:path';
import { fleet, labelOf, type FleetEntry } from '../registry.js';
import { readState } from '../state.js';
import { requiredVaultKeys } from '../secrets.js';
import { makeVault, detectBackend, backendLabel, type VaultBackend } from '../vault.js';
import { cliInvocation } from '../invocation.js';
import { readBacklog, readInbox, nextTask, summarize, type Task } from '../nightshift/backlog.js';
import { readConfig, readiness, type NightshiftConfig } from '../nightshift/config.js';
import { readRunState, liveness, describePhase, type Liveness } from '../nightshift/runstate.js';
import { readGroomMemory, needsDecision } from '../nightshift/groomstate.js';
import type { TaskResult } from '../nightshift/report.js';
import { decisionsFor, type Decision } from './decisions.js';
import { fleetNeeds, projectNeeds, type CostLedger, type Need } from '../needs.js';
import { readConfirmations, recordedAnswers } from '../confirmations.js';
import { ledgerFor } from '../needs.js';
import { detectAssets, type StoreAssets } from '../assets.js';
import { latestTag, headCommit } from '../git.js';
import { hueOf } from './icon.js';
import type { Archetype } from '../types.js';

/**
 * Everything Mission Control renders, assembled in one pass.
 *
 * Nothing is cached and nothing is stored. Every field here is re-derived from
 * the repos on each request, for the same reason the registry holds only paths:
 * a dashboard that can be stale is a dashboard that lies, and this one is the
 * screen someone checks to decide whether their app is shippable.
 *
 * Which also means the whole thing must stay fast enough to rebuild per
 * request. It is — `fleet()` re-scores four real projects in well under a
 * second, because every check is a file existence test or a small read.
 */

/**
 * The grid's columns, in rubric order.
 *
 * Deliberately NOT derived from a project's own checks: `scorecard()` sorts by
 * severity so the worst problem is read first, which is right for one project
 * and wrong for a grid — the columns would reshuffle per row and the grid would
 * be unreadable. Ids missing from a project render as "not applicable", which
 * is a real answer (a web app has no keystore) and not a gap.
 */
export const GRID_COLUMNS: { id: string; short: string }[] = [
  { id: 'ci-build', short: 'CI build' },
  { id: 'versioning', short: 'Versioning' },
  { id: 'android-signing', short: 'Android signing' },
  { id: 'keystore-backup', short: 'Keystore backup' },
  { id: 'notarization', short: 'Notarized' },
  { id: 'distribution', short: 'Distribution' },
  { id: 'auto-update', short: 'Auto-update' },
  { id: 'test-gate', short: 'Test gate' },
  { id: 'secrets-hygiene', short: 'Secrets' },
  { id: 'crash-reporting', short: 'Crashes' },
  { id: 'analytics', short: 'Analytics' },
  { id: 'monetization', short: 'Monetization' },
  { id: 'legal', short: 'Legal' },
  { id: 'landing', short: 'Landing page' },
  { id: 'support', short: 'Support' },
  { id: 'app-icon', short: 'App icon' },
  { id: 'store-listing', short: 'Store listing' },
];

export interface QueueTask {
  id: string;
  title: string;
  status: Task['status'];
  priority?: number;
  reason?: string;
}

export interface NightshiftView {
  configured: boolean;
  enabled: boolean;
  /** Everything stopping it running tonight. Empty means it will run. */
  problems: string[];
  mode: NightshiftConfig['mode'];
  baseBranch: string;
  window: string;
  gate: string;
  groom: boolean;
  maxTasksPerNight: number;
  backlogDir?: string;
  counts: ReturnType<typeof summarize>;
  /** What tonight starts with, if anything. */
  next?: QueueTask;
  /** `ready` and `in_progress`, in the order the drain will take them. */
  queue: QueueTask[];
  /** The worklist, not a graveyard: each one carries why. */
  blocked: QueueTask[];
  /** Un-triaged lines waiting for grooming. */
  inbox: string[];
  /**
   * Tasks grooming tried twice and could not scope.
   *
   * Not failures — questions. Grooming stops re-attempting them so the queue
   * behind them can move, which only works if a person is actually told, so
   * they surface as a worklist rather than disappearing quietly.
   */
  needsDecision: { id: string; title: string; why: string; attempts: number }[];
  /**
   * What is happening right now — the one volatile fact everything else here
   * is too slow to express. `crashed` matters as much as `running`: it is the
   * only way to explain a task stuck at in_progress.
   */
  live: Liveness;
  /** Phrasing for `live`, so the CLI and the dashboard cannot word it differently. */
  liveLabel: string;
}

/** One deployable surface, flattened for display. */
export interface SurfaceView {
  id: string;
  archetype: string;
  status: string;
  evidence: string[];
  /** The gathered config, shown as-is. It is the project's real contract. */
  config?: Record<string, unknown>;
}

/** A credential this project needs. Presence only — never a value. */
export interface SecretView {
  key: string;
  present: boolean;
}

/**
 * Where a surface ships, and the last thing this repository can prove went out.
 *
 * The fleet view used to carry three stat tiles that read `0 TASKS READY`,
 * `0 BLOCKED`, `0 RUN TONIGHT` in a row — three zeros that said nothing, on the
 * screen that is supposed to make someone want this. What was missing was the
 * fact a person with six apps actually wants at a glance: what is live, and
 * where.
 *
 * The honesty constraint is the whole design. launchpad does not call App Store
 * Connect, Firebase, Vercel or Cloudflare, and it is not going to start — no
 * account, no tokens leaving the machine, nothing to be breached. So this never
 * claims a build is *live*. It reports two things it can actually see, and says
 * which one it is looking at: the newest tag in `.git/refs/tags`, for surfaces
 * that ship on a tag, and the commit at the head of the trunk, for surfaces
 * that deploy on a push. `evidence` is rendered beside the value, always.
 */
export interface LiveTarget {
  /** The surface id this is about. */
  surface: string;
  archetype: Archetype;
  /** Where this surface goes: TestFlight, Firebase → testers, a domain. */
  channel: string;
  /**
   * What the repo can show: a tag name, or a short commit. Empty when neither.
   *
   * Called `ref` rather than `value` on purpose. `test/dashboard.test.ts`
   * asserts that no `"value":` ever appears in this payload — a blunt tripwire
   * against a vault value reaching the wire, and a good one. A benign field
   * that happens to be called `value` would have made it fire on nothing
   * forever after, and a tripwire nobody believes is not a tripwire.
   */
  ref: string;
  /** What that value IS. Never omitted — it is what keeps the row from being a claim. */
  evidence: string;
  /** ISO, when the ref was written. Absent when it cannot be dated. */
  at?: string;
}

export interface ProjectView extends Omit<FleetEntry, 'score'> {
  score?: FleetEntry['score'];
  surfaces_detail: SurfaceView[];
  pipelines: { kind: string; path: string; disposition?: string }[];
  /** What launchpad chose for this project, and why. The sellable screen. */
  decisions: Decision[];
  secrets: SecretView[];
  /**
   * The app's own icon, served by the dashboard. Purely a visual cue — but the
   * cue that makes a list of ten projects scannable instead of ten rows of
   * text, which is most of why anyone opens a fleet view.
   */
  iconUrl?: string;
  /**
   * A hue, 0-360, derived from the project's label.
   *
   * Identity for the projects that have no icon to take it from — and a fleet
   * where every row is identical text is a fleet nobody can scan, which is most
   * of the reason to open a fleet view at all. Deterministic, so a project is
   * the same colour on every machine and in a screenshot taken a month apart.
   *
   * The LABEL, not the bare name: two repos called `website` hashed to the same
   * hue, so the one cue that survives being read at thumbnail size said they
   * were the same project. Not the absolute path either, tempting as that is —
   * `--demo` writes its fleet under a temp root that carries the pid, so a hue
   * keyed on the full path would change on every run and break both the "same
   * colour in a screenshot taken a month apart" promise above and the committed
   * visual baselines. The label is exactly as unique as it needs to be.
   *
   * Used for the fallback tile and a hairline on the card. Never for a cell, a
   * ring or a chip: those colours mean something, and a decorative hue that
   * could be mistaken for a grade would be the dashboard lying in CSS.
   */
  accent: number;
  /** Where each surface ships, and the last thing the repo can prove went out. */
  live: LiveTarget[];
  /** Store presence, summarised. Never file contents — just what exists. */
  assets: {
    icon?: { path: string; width: number; height: number; hasAlpha: boolean };
    screenshots: number;
    featureGraphic: boolean;
    listingDir?: string;
  };
  nightshift: NightshiftView;
  /** This project's rows from the most recent night that produced any. */
  lastNight: TaskResult[];
  lastNightDate?: string;
  /**
   * What this project costs, from its own decisions and its own share of the
   * fleet-wide bills. The same shape as the fleet's, so one renderer draws both.
   */
  ledger: CostLedger;
  /**
   * Answers already given here that are not scorecard rows — a bill accepted, a
   * one-way act acknowledged.
   *
   * Rendered on the Decisions tab as "you decided this on <date>". An item that
   * vanishes from the strip and leaves no record anywhere is a button that hid a
   * decision rather than recording one.
   */
  answered: { id: string; at: string; choice?: string; note?: string }[];
  /**
   * The keys of the fleet's `needs` items that are about this project, in the
   * fleet list's order — `projectNeeds()`, computed here once.
   *
   * A project page shows these expanded and the rest of the fleet as one line.
   * Carried as keys rather than as a second copy of the items so there is one
   * list and one filter: the page picks rows out of `DashboardData.needs`, and
   * never decides for itself which item belongs to which project.
   */
  needs: string[];
}

/**
 * The contract between the shipped UI and this data layer.
 *
 * Mission Control is ONE pre-built page, byte-identical for every customer,
 * and a project "integrates" by appearing in `~/.launchpad/projects.json` —
 * nothing is generated, templated or cloned per project. That only holds if
 * the page and the payload agree, and they are versioned independently:
 * customers update the package at different times, and a repo written by a
 * newer launchpad can be read by an older dashboard.
 *
 * So the payload states its version and which sections it knows how to fill.
 * The page renders the sections it recognises, labels a declared-but-empty one
 * "coming", and ignores what it does not understand rather than breaking. A new
 * capability — marketing, revenue — becomes a new entry here plus a renderer,
 * with no change to any customer's repo and no per-project code anywhere.
 */
export const CONTRACT = 1;

/** Sections the payload can carry. Absent means "this build cannot fill it". */
export type Capability = 'readiness' | 'nightshift' | 'marketing' | 'revenue';

export interface DashboardData {
  contract: number;
  /** What this build populates. `marketing` and `revenue` are deliberately absent. */
  capabilities: Capability[];
  generated: string;
  columns: typeof GRID_COLUMNS;
  projects: ProjectView[];
  /**
   * Everything waiting on a person, fleet-wide, already sorted and deduped.
   *
   * Top-level rather than per-project because that is what it is: a credential
   * six projects need is one thing to do, and the strip that renders this sits
   * above the fleet and above every project page. `src/needs.ts` holds the
   * model and the argument for each kind.
   */
  needs: Need[];
  /** What the whole fleet costs, split by whose cost it is. */
  ledger: CostLedger;
  /**
   * How a person runs a launchpad command in a terminal on THIS machine.
   *
   * The credential cards are the one place the page asks someone to type a
   * command, and `launchpad …` is on nobody's PATH. The server knows where its
   * own CLI is, so the page does not have to guess.
   */
  invocation: string;
  /**
   * Where credentials live on this machine, said the way `doctor` says it.
   * The Keys tab told everyone "your OS keychain" — including every Windows
   * machine and every file vault, where there is no keychain involved.
   */
  vault: { backend: VaultBackend; label: string; keychain: boolean };
  /** Fleet-wide roll-up for the number strip. */
  totals: {
    projects: number;
    onboarded: number;
    /** Progress ratio for the ring only. The headline numbers are the next three. */
    averageScore: number;
    remaining: number;
    done: number;
    unconfirmed: number;
    criticalGaps: number;
    /** Surfaces that have a channel to ship down. */
    channels: number;
    /** Projects with at least one surface whose last release is a real tag. */
    released: number;
    readyTonight: number;
    tasksReady: number;
    tasksBlocked: number;
    inbox: number;
    /** How many things need a human. The sidebar's count, and the strip's. */
    needsYou: number;
  };
  /** The machine-level morning report, when there is one. */
  lastNight?: { date: string; headline: string; text: string };
}

const toQueueTask = (t: Task): QueueTask => ({
  id: t.id, title: t.title, status: t.status, priority: t.priority, reason: t.reason,
});

export function nightshiftView(repo: string): NightshiftView {
  const config = readConfig(repo);
  const tasks = config ? readBacklog(repo, config.backlogDir) : [];
  const c = config
    ?? ({ mode: 'pr', baseBranch: 'main', window: '—', gate: '', groom: false, maxTasksPerNight: 0 } as NightshiftConfig);
  const r = readiness(config);
  const next = nextTask(tasks);
  const live = liveness(readRunState(repo), new Date());
  const byId = new Map(tasks.map(t => [t.id, t]));
  const stuck = needsDecision(readGroomMemory(repo))
    // A remembered id whose task is gone is bookkeeping, not a worklist item.
    .filter(d => byId.has(d.id))
    .map(d => ({ id: d.id, title: byId.get(d.id)!.title, why: d.why, attempts: d.attempts }));

  // The order the drain will actually take them, so what the screen shows and
  // what runs tonight cannot disagree.
  const queue = tasks
    .filter(t => t.status === 'ready' || t.status === 'in_progress')
    .sort((a, b) =>
      (a.status === 'in_progress' ? -1 : 0) - (b.status === 'in_progress' ? -1 : 0)
      || (a.priority ?? Number.MAX_SAFE_INTEGER) - (b.priority ?? Number.MAX_SAFE_INTEGER)
      || a.id.localeCompare(b.id))
    .map(toQueueTask);

  return {
    configured: Boolean(config),
    enabled: Boolean(config?.enabled),
    problems: r.problems,
    mode: c.mode,
    baseBranch: c.baseBranch,
    window: c.window,
    gate: c.gate,
    groom: c.groom,
    maxTasksPerNight: c.maxTasksPerNight,
    backlogDir: config?.backlogDir,
    counts: summarize(tasks),
    needsDecision: stuck,
    live,
    liveLabel: describeLive(live),
    next: next ? toQueueTask(next) : undefined,
    queue,
    blocked: tasks.filter(t => t.status === 'blocked').map(toQueueTask),
    inbox: readInbox(repo),
  };
}

/**
 * The most recent night that actually produced rows.
 *
 * Reads `events.jsonl` rather than the rendered report: the report is one file
 * that gets overwritten, while the events are append-only, so "last night" stays
 * answerable after a quiet night that wrote a new report over a busy one.
 */
export function lastNightOf(repo: string): { date?: string; results: TaskResult[] } {
  const p = join(repo, '.launchpad', 'nightshift', 'events.jsonl');
  if (!existsSync(p)) return { results: [] };
  try {
    const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as TaskResult & { ts: string });
    if (!rows.length) return { results: [] };
    const latest = rows[rows.length - 1].ts.slice(0, 10);
    return { date: latest, results: rows.filter(r => r.ts.slice(0, 10) === latest) };
  } catch {
    // A hand-edited or half-written events file must not blank the dashboard.
    return { results: [] };
  }
}

export function dashboardData(home = launchpadHome(), now = new Date()): DashboardData {
  const states = new Map<string, ReturnType<typeof readState>>();
  const projects: ProjectView[] = fleet(home).map(entry => {
    // A directory that is gone cannot be read for anything else, and probing it
    // would turn one bad row into a broken page.
    if (entry.problem) {
      return {
        ...entry, nightshift: emptyNightshift(), lastNight: [],
        surfaces_detail: [], pipelines: [], decisions: [], secrets: [],
        accent: hueOf(labelOf(entry)), live: [],
        assets: { screenshots: 0, featureGraphic: false },
        ledger: ledgerFor([], []), answered: [], needs: [],
      };
    }
    const night = lastNightOf(entry.path);
    const st = readState(entry.path);
    states.set(entry.path, st);
    return {
      ...entry,
      accent: hueOf(labelOf(entry)),
      live: st ? liveTargets(entry.path, st) : [],
      surfaces_detail: (st?.surfaces ?? []).map(s => ({
        id: s.id, archetype: s.archetype, status: s.status, evidence: s.evidence,
        config: s.config as Record<string, unknown> | undefined,
      })),
      pipelines: (st?.pipelines ?? []).map(p => ({ kind: p.kind, path: p.path, disposition: p.disposition })),
      decisions: st ? decisionsFor(st) : [],
      secrets: st ? secretsFor(st) : [],
      ...assetsView(entry.path, st),
      nightshift: nightshiftView(entry.path),
      lastNight: night.results,
      lastNightDate: night.date,
      ledger: ledgerFor([], []),
      answered: safeAnswers(entry.path),
      needs: [],
    };
  });

  /**
   * The needs list is computed over the ASSEMBLED fleet, not per project.
   *
   * It has to be: the merge that turns six projects wanting one App Store
   * Connect key into a single item is a fact about the fleet, and it cannot be
   * made by a function that has only ever seen one project.
   */
  const needsInput = projects
    .filter(p => !p.problem)
    .map(p => ({
      path: p.path,
      label: labelOf(p),
      state: states.get(p.path) ?? null,
      score: p.score,
      secrets: p.secrets,
      live: p.live,
      decisions: p.decisions,
      answered: safeConfirmations(p.path),
    }));
  const { items: needs, ledger } = fleetNeeds(needsInput);
  for (const p of projects) {
    const mine = needsInput.find(n => n.path === p.path);
    if (!mine) continue;
    const own = projectNeeds(needs, p.path);
    p.ledger = ledgerFor([mine], own);
    p.needs = own.map(n => n.key);
  }

  const scored = projects.filter(p => p.score);
  let backend: VaultBackend = 'file';
  try { backend = detectBackend(process.platform); } catch { /* reported by the CLI; the page shows the file vault */ }
  return {
    needs,
    ledger,
    invocation: cliInvocation(),
    vault: { backend, label: backendLabel(backend), keychain: backend === 'keychain' || backend === 'secret-service' },
    contract: CONTRACT,
    // Named rather than inferred from whether the arrays are empty: "no
    // marketing data" and "this build has no marketing" are different answers,
    // and only one of them should render as a roadmap slot.
    capabilities: ['readiness', 'nightshift'],
    generated: now.toISOString(),
    columns: GRID_COLUMNS,
    projects,
    totals: {
      projects: projects.length,
      onboarded: scored.length,
      averageScore: scored.length
        ? Math.round(scored.reduce((n, p) => n + p.score!.score, 0) / scored.length)
        : 0,
      /** The headline: work outstanding, and work already done. Not a grade. */
      remaining: scored.reduce((n, p) => n + p.score!.remaining, 0),
      done: scored.reduce((n, p) => n + p.score!.passed, 0),
      unconfirmed: scored.reduce((n, p) => n + p.score!.unconfirmed, 0),
      // `grade === 'gap'` rather than `!== 'ok'`: an unanswered question is not
      // a critical failure, and counting it as one is how the fleet view ended
      // up looking like an emergency on every project at once.
      criticalGaps: scored.reduce(
        (n, p) => n + p.score!.checks.filter(c => c.critical && c.grade === 'gap').length, 0),
        /** Surfaces with somewhere to go. The "after" number, and a real one. */
      channels: projects.reduce((n, p) => n + p.live.length, 0),
      released: projects.filter(p => p.live.some(l => l.evidence === 'last tag')).length,
      readyTonight: projects.filter(p => p.nightshift.problems.length === 0).length,
      tasksReady: projects.reduce((n, p) => n + p.nightshift.counts.ready, 0),
      tasksBlocked: projects.reduce((n, p) => n + p.nightshift.counts.blocked, 0),
      inbox: projects.reduce((n, p) => n + p.nightshift.inbox.length, 0),
      needsYou: needs.length,
    },
    lastNight: machineReport(home),
  };
}

/**
 * Which credentials this project needs, and whether the vault has them.
 *
 * Presence only. A dashboard must never be able to display a secret, so the
 * value is not read, not cached and not sent — `has()` is the entire query.
 */
export function secretsFor(st: Parameters<typeof requiredVaultKeys>[0]): SecretView[] {
  try {
    const v = makeVault(undefined, { backend: detectBackend(process.platform) });
    return requiredVaultKeys(st).map(key => ({ key, present: v.has(key) }));
  } catch {
    // A locked or unavailable vault must not blank the whole project view.
    return requiredVaultKeys(st).map(key => ({ key, present: false }));
  }
}

/** One phrasing, shared, so nothing can describe the same state two ways. */
export function describeLive(l: Liveness): string {
  const mins = (s: number) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
  switch (l.state) {
    case 'running':
      return `${describePhase(l.phase)}${l.taskId ? ` — ${l.taskId}` : ''} · ${mins(l.sinceS)}`;
    case 'crashed':
      return `stopped without finishing while ${describePhase(l.phase)}`
        + `${l.taskId ? ` on ${l.taskId}` : ''} — that task is probably still marked in progress`;
    case 'idle': return `last run ended ${l.endedAt.slice(0, 16).replace('T', ' ')}`;
    default: return '';
  }
}

/**
 * The icon is referenced by URL rather than inlined. A 1024px PNG is around a
 * megabyte of base64, and this payload is re-sent on every file change — so
 * inlining it would make a live stream cost a megabyte per keystroke in the
 * idea box. A URL lets the browser cache it.
 */
function assetsView(repo: string, st: ReturnType<typeof readState>): Pick<ProjectView, 'iconUrl' | 'assets'> {
  if (!st) return { assets: { screenshots: 0, featureGraphic: false } };
  let a: StoreAssets;
  try { a = detectAssets(repo, st); } catch { return { assets: { screenshots: 0, featureGraphic: false } }; }
  return {
    iconUrl: a.icon ? `/api/icon?project=${encodeURIComponent(repo)}` : undefined,
    assets: {
      icon: a.icon ? { path: a.icon.path, width: a.icon.width, height: a.icon.height, hasAlpha: a.icon.hasAlpha } : undefined,
      screenshots: a.screenshots.length,
      featureGraphic: Boolean(a.featureGraphic),
      listingDir: a.listingDir,
    },
  };
}

/**
 * Where each surface ships, named the way its own platform names it.
 *
 * Two evidence classes, and the difference is the archetype's trigger policy,
 * not a guess. A store surface reaches people when a tag is cut, so the newest
 * tag is what there is to show. A web surface deploys on a push to the trunk,
 * so the head commit is. Anything else — whether Apple let the build through
 * review, whether the deploy succeeded — is not in this repository and is not
 * claimed.
 */
export function liveTargets(repo: string, st: ReturnType<typeof readState>): LiveTarget[] {
  if (!st) return [];
  const tag = latestTag(repo);
  const head = headCommit(repo);
  const out: LiveTarget[] = [];
  for (const s of st.surfaces) {
    const c = (s.config ?? {}) as Record<string, string | undefined>;
    const onTag = (channel: string): void => {
      out.push({
        surface: s.id, archetype: s.archetype, channel,
        ref: tag?.name ?? '', evidence: tag ? 'last tag' : 'never released',
        ...(tag?.at ? { at: tag.at } : {}),
      });
    };
    const onPush = (channel: string): void => {
      out.push({
        surface: s.id, archetype: s.archetype, channel,
        ref: head ?? '', evidence: head ? 'trunk commit' : 'no commits',
      });
    };
    switch (s.archetype) {
      case 'ios': onTag('TestFlight'); break;
      case 'android':
        // Every Android pipeline launchpad writes distributes through Firebase
        // App Distribution; none of them uploads to Play. The fallback used to
        // read "Play internal track" — a channel no generated file can reach,
        // quoted back in the "needs you" strip as "nothing has gone out on Play
        // internal track yet" beside the card explaining why launchpad starts
        // with Firebase instead.
        onTag(`Firebase → ${c.testerGroup || 'testers'}`); break;
      case 'macos-dmg':
        onTag(c.appcastDomain ? `DMG · ${c.appcastDomain}` : 'DMG · direct download'); break;
      case 'web-app': onPush(`Vercel · ${c.prodDomain || c.rootDir || 'preview'}`); break;
      case 'static-site':
        onPush(`Pages · ${c.prodDomain || c.pagesProject || 'preview'}`); break;
    }
  }
  return out;
}

/**
 * Both readers of `.launchpad/confirmed.yml`, wrapped so a hand-edited or
 * unreadable file costs one row's worth of answers rather than the whole page.
 * `readConfirmations` already degrades to `{}` on a parse error; this covers the
 * cases it cannot, such as a directory that became unreadable mid-request.
 */
function safeConfirmations(repo: string): ReturnType<typeof readConfirmations> {
  try { return readConfirmations(repo); } catch { return {}; }
}
function safeAnswers(repo: string): ProjectView['answered'] {
  try { return recordedAnswers(repo); } catch { return []; }
}

function emptyNightshift(): NightshiftView {
  return {
    configured: false, enabled: false, problems: ['not set up'],
    needsDecision: [], live: { state: 'never' }, liveLabel: '',
    mode: 'pr', baseBranch: 'main', window: '—', gate: '', groom: false, maxTasksPerNight: 0,
    counts: { idea: 0, scoped: 0, ready: 0, in_progress: 0, done: 0, blocked: 0, total: 0 },
    queue: [], blocked: [], inbox: [],
  };
}

function machineReport(home: string): DashboardData['lastNight'] {
  const p = join(home, '.launchpad', 'nightshift', 'last-night.md');
  if (!existsSync(p)) return undefined;
  try {
    const text = readFileSync(p, 'utf8');
    const date = /Nightshift — (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? '';
    // The headline is the first non-empty line after the title.
    const headline = text.split('\n').slice(1).map(l => l.trim()).find(Boolean) ?? '';
    return { date, headline, text };
  } catch {
    return undefined;
  }
}
