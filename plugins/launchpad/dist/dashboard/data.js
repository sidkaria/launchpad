import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fleet, labelOf } from '../registry.js';
import { readState } from '../state.js';
import { requiredVaultKeys } from '../secrets.js';
import { makeVault, detectBackend, backendLabel } from '../vault.js';
import { cliInvocation } from '../invocation.js';
import { readBacklog, readInbox, nextTask, summarize } from '../nightshift/backlog.js';
import { readConfig, readiness } from '../nightshift/config.js';
import { readRunState, liveness, describePhase } from '../nightshift/runstate.js';
import { readGroomMemory, needsDecision } from '../nightshift/groomstate.js';
import { decisionsFor } from './decisions.js';
import { fleetNeeds, projectNeeds } from '../needs.js';
import { readConfirmations, recordedAnswers } from '../confirmations.js';
import { ledgerFor } from '../needs.js';
import { detectAssets } from '../assets.js';
import { latestTag, headCommit } from '../git.js';
import { hueOf } from './icon.js';
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
export const GRID_COLUMNS = [
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
const toQueueTask = (t) => ({
    id: t.id, title: t.title, status: t.status, priority: t.priority, reason: t.reason,
});
export function nightshiftView(repo) {
    const config = readConfig(repo);
    const tasks = config ? readBacklog(repo, config.backlogDir) : [];
    const c = config
        ?? { mode: 'pr', baseBranch: 'main', window: '—', gate: '', groom: false, maxTasksPerNight: 0 };
    const r = readiness(config);
    const next = nextTask(tasks);
    const live = liveness(readRunState(repo), new Date());
    const byId = new Map(tasks.map(t => [t.id, t]));
    const stuck = needsDecision(readGroomMemory(repo))
        // A remembered id whose task is gone is bookkeeping, not a worklist item.
        .filter(d => byId.has(d.id))
        .map(d => ({ id: d.id, title: byId.get(d.id).title, why: d.why, attempts: d.attempts }));
    // The order the drain will actually take them, so what the screen shows and
    // what runs tonight cannot disagree.
    const queue = tasks
        .filter(t => t.status === 'ready' || t.status === 'in_progress')
        .sort((a, b) => (a.status === 'in_progress' ? -1 : 0) - (b.status === 'in_progress' ? -1 : 0)
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
export function lastNightOf(repo) {
    const p = join(repo, '.launchpad', 'nightshift', 'events.jsonl');
    if (!existsSync(p))
        return { results: [] };
    try {
        const rows = readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
        if (!rows.length)
            return { results: [] };
        const latest = rows[rows.length - 1].ts.slice(0, 10);
        return { date: latest, results: rows.filter(r => r.ts.slice(0, 10) === latest) };
    }
    catch {
        // A hand-edited or half-written events file must not blank the dashboard.
        return { results: [] };
    }
}
export function dashboardData(home = homedir(), now = new Date()) {
    const states = new Map();
    const projects = fleet(home).map(entry => {
        // A directory that is gone cannot be read for anything else, and probing it
        // would turn one bad row into a broken page.
        if (entry.problem) {
            return {
                ...entry, nightshift: emptyNightshift(), lastNight: [],
                surfaces_detail: [], pipelines: [], decisions: [], secrets: [],
                accent: hueOf(labelOf(entry)), live: [],
                assets: { screenshots: 0, featureGraphic: false },
                ledger: ledgerFor([], []), answered: [],
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
                config: s.config,
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
        if (!mine)
            continue;
        p.ledger = ledgerFor([mine], projectNeeds(needs, p.path));
    }
    const scored = projects.filter(p => p.score);
    let backend = 'file';
    try {
        backend = detectBackend(process.platform);
    }
    catch { /* reported by the CLI; the page shows the file vault */ }
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
                ? Math.round(scored.reduce((n, p) => n + p.score.score, 0) / scored.length)
                : 0,
            /** The headline: work outstanding, and work already done. Not a grade. */
            remaining: scored.reduce((n, p) => n + p.score.remaining, 0),
            done: scored.reduce((n, p) => n + p.score.passed, 0),
            unconfirmed: scored.reduce((n, p) => n + p.score.unconfirmed, 0),
            // `grade === 'gap'` rather than `!== 'ok'`: an unanswered question is not
            // a critical failure, and counting it as one is how the fleet view ended
            // up looking like an emergency on every project at once.
            criticalGaps: scored.reduce((n, p) => n + p.score.checks.filter(c => c.critical && c.grade === 'gap').length, 0),
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
export function secretsFor(st) {
    try {
        const v = makeVault(undefined, { backend: detectBackend(process.platform) });
        return requiredVaultKeys(st).map(key => ({ key, present: v.has(key) }));
    }
    catch {
        // A locked or unavailable vault must not blank the whole project view.
        return requiredVaultKeys(st).map(key => ({ key, present: false }));
    }
}
/** One phrasing, shared, so nothing can describe the same state two ways. */
export function describeLive(l) {
    const mins = (s) => (s < 90 ? `${s}s` : `${Math.round(s / 60)}m`);
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
function assetsView(repo, st) {
    if (!st)
        return { assets: { screenshots: 0, featureGraphic: false } };
    let a;
    try {
        a = detectAssets(repo, st);
    }
    catch {
        return { assets: { screenshots: 0, featureGraphic: false } };
    }
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
export function liveTargets(repo, st) {
    if (!st)
        return [];
    const tag = latestTag(repo);
    const head = headCommit(repo);
    const out = [];
    for (const s of st.surfaces) {
        const c = (s.config ?? {});
        const onTag = (channel) => {
            out.push({
                surface: s.id, archetype: s.archetype, channel,
                ref: tag?.name ?? '', evidence: tag ? 'last tag' : 'never released',
                ...(tag?.at ? { at: tag.at } : {}),
            });
        };
        const onPush = (channel) => {
            out.push({
                surface: s.id, archetype: s.archetype, channel,
                ref: head ?? '', evidence: head ? 'trunk commit' : 'no commits',
            });
        };
        switch (s.archetype) {
            case 'ios':
                onTag('TestFlight');
                break;
            case 'android':
                // Every Android pipeline launchpad writes distributes through Firebase
                // App Distribution; none of them uploads to Play. The fallback used to
                // read "Play internal track" — a channel no generated file can reach,
                // quoted back in the "needs you" strip as "nothing has gone out on Play
                // internal track yet" beside the card explaining why launchpad starts
                // with Firebase instead.
                onTag(`Firebase → ${c.testerGroup || 'testers'}`);
                break;
            case 'macos-dmg':
                onTag(c.appcastDomain ? `DMG · ${c.appcastDomain}` : 'DMG · direct download');
                break;
            case 'web-app':
                onPush(`Vercel · ${c.prodDomain || c.rootDir || 'preview'}`);
                break;
            case 'static-site':
                onPush(`Pages · ${c.prodDomain || c.pagesProject || 'preview'}`);
                break;
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
function safeConfirmations(repo) {
    try {
        return readConfirmations(repo);
    }
    catch {
        return {};
    }
}
function safeAnswers(repo) {
    try {
        return recordedAnswers(repo);
    }
    catch {
        return [];
    }
}
function emptyNightshift() {
    return {
        configured: false, enabled: false, problems: ['not set up'],
        needsDecision: [], live: { state: 'never' }, liveLabel: '',
        mode: 'pr', baseBranch: 'main', window: '—', gate: '', groom: false, maxTasksPerNight: 0,
        counts: { idea: 0, scoped: 0, ready: 0, in_progress: 0, done: 0, blocked: 0, total: 0 },
        queue: [], blocked: [], inbox: [],
    };
}
function machineReport(home) {
    const p = join(home, '.launchpad', 'nightshift', 'last-night.md');
    if (!existsSync(p))
        return undefined;
    try {
        const text = readFileSync(p, 'utf8');
        const date = /Nightshift — (\d{4}-\d{2}-\d{2})/.exec(text)?.[1] ?? '';
        // The headline is the first non-empty line after the title.
        const headline = text.split('\n').slice(1).map(l => l.trim()).find(Boolean) ?? '';
        return { date, headline, text };
    }
    catch {
        return undefined;
    }
}
