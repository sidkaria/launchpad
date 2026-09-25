import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { parse, stringify } from 'yaml';
import { requiredVaultKeys } from './secrets.js';
import { DEFAULT_DISPOSITION } from './disposition.js';
/** A newly detected foreign pipeline is left alone until somebody says otherwise. */
const withDefaultDisposition = (p) => (p.disposition ? p : { ...p, disposition: DEFAULT_DISPOSITION });
const STATE_REL = join('.launchpad', 'state.yml');
const HEADER = '# .launchpad/state.yml — auto-generated; do not hand-edit\n';
export function statePath(repo) {
    return join(repo, STATE_REL);
}
/**
 * Read the per-repo contract, coercing rather than trusting.
 *
 * This is a trust boundary and it was being crossed with a bare cast. The file
 * is YAML on someone else's disk: it can be hand-edited, half-written, or —
 * the case that actually matters for a shipped product — written by a DIFFERENT
 * VERSION of launchpad that had no `credentialsRequired` key. A cast turns any
 * of those into `undefined` deep inside a caller, and `scorecard()` reading
 * `.length` off it took down the entire fleet view for every project at once.
 *
 * So: every field is coerced to its declared shape, and anything that is not an
 * object at all reads as "not set up" rather than as a broken state.
 */
export function readState(repo) {
    return readStateOrError(repo).state;
}
/** The first line of a parse failure, fit to put on a screen. */
function firstLine(e) {
    const msg = e instanceof Error ? e.message : String(e);
    const line = msg.split('\n').map(l => l.trim()).find(Boolean) ?? 'could not be parsed';
    return line.length > 160 ? `${line.slice(0, 157)}…` : line;
}
/**
 * The same read, able to tell "this file is broken" from "this file is absent".
 *
 * `readState` collapsed both into `null`, and the caller could not tell them
 * apart — so a half-pasted `state.yml` made the fleet row read **"not set up —
 * run /launchpad:onboard here"** about a project that was set up. Following
 * that instruction re-runs onboarding over an already-onboarded repo, and the
 * one piece of information the user needed (which file, and why it will not
 * parse) was the one thing nothing said.
 *
 * Absence still reads as absence. That is the common case and it is not an
 * error: a registered repo that has never been onboarded is exactly what the
 * dashboard's "add any git repo" button creates on purpose.
 */
export function readStateOrError(repo) {
    const p = statePath(repo);
    if (!existsSync(p))
        return { state: null };
    let text;
    try {
        text = readFileSync(p, 'utf8');
    }
    catch (e) {
        return { state: null, error: firstLine(e) };
    }
    let raw;
    try {
        raw = parse(text);
    }
    catch (e) {
        return { state: null, error: firstLine(e) };
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        // An empty file is indistinguishable from a repo nobody has onboarded, and
        // reading it as damage would put a scary row on a harmless state. Anything
        // with content in it that is not a mapping is genuinely the wrong file.
        if (!text.trim())
            return { state: null };
        return {
            state: null,
            error: 'the file parsed but is not a launchpad state (expected a mapping with project and surfaces)',
        };
    }
    const s = raw;
    const list = (v) => (Array.isArray(v) ? v.filter(x => x != null) : []);
    return {
        state: {
            project: typeof s.project === 'string' ? s.project : '',
            surfaces: list(s.surfaces).map(f => ({ ...f, evidence: list(f.evidence) })),
            pipelines: list(s.pipelines),
            credentialsRequired: list(s.credentialsRequired),
            ...(s.notes !== undefined ? { notes: s.notes } : {}),
        },
    };
}
export function writeState(repo, state) {
    const p = statePath(repo);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, HEADER + stringify(state), 'utf8');
}
function mergeSurface(prev, det) {
    // Archetype changed for the same id → detection wins; any stale config is dropped.
    if (prev.archetype !== det.archetype)
        return det;
    return {
        ...det, // refresh archetype + evidence + confidence from detection
        status: prev.status, // preserve the wired / needs-* state
        config: prev.config, // preserve gathered per-surface config (the worst-bug fix)
        bundleId: prev.bundleId ?? det.bundleId,
        target: det.target ?? prev.target,
    };
}
/**
 * Merge a prior state with a fresh detection. Detection refreshes WHAT each
 * surface is; the prior state's gathered config/status/dispositions are
 * preserved. Prior-only SURFACES are retained (can be hand-configured); pipelines
 * reflect current detection (a removed workflow drops out). This is what makes
 * `setup` safe + idempotent to re-run on a wired project.
 */
export function mergeState(prev, detected, project) {
    if (!prev) {
        return withCredentials({
            project, surfaces: detected.surfaces,
            pipelines: detected.pipelines.map(withDefaultDisposition),
            credentialsRequired: [],
            ...(detected.ecosystem ? { ecosystem: detected.ecosystem } : {}),
        });
    }
    const prevById = new Map(prev.surfaces.map(s => [s.id, s]));
    const seen = new Set();
    const surfaces = [];
    for (const d of detected.surfaces) {
        seen.add(d.id);
        const p = prevById.get(d.id);
        surfaces.push(p ? mergeSurface(p, d) : d);
    }
    for (const p of prev.surfaces)
        if (!seen.has(p.id))
            surfaces.push(p); // prior-only surfaces
    const key = (x) => `${x.kind}:${x.path}`;
    const prevPipes = new Map(prev.pipelines.map(p => [key(p), p]));
    const seenPipes = new Set();
    const pipelines = [];
    for (const d of detected.pipelines) {
        seenPipes.add(key(d));
        const p = prevPipes.get(key(d));
        // Three cases, and the middle one is the migration. A decision already
        // recorded is kept; a pipeline already in the state file with NO decision
        // stays undecided, because a repo somebody has already wired must not have
        // `apply` stop working underneath them on an upgrade; and a pipeline seen
        // for the first time gets the safe default.
        if (p?.disposition)
            pipelines.push({ ...d, disposition: p.disposition });
        else if (p)
            pipelines.push(d);
        else
            pipelines.push(withDefaultDisposition(d));
    }
    // Pipelines are filesystem-detected: a prior pipeline detection no longer sees
    // is a removed/migrated file, so it drops out (keeps re-runs idempotent and the
    // consolidation conflict-check honest). Dispositions for surviving pipelines are
    // carried forward above; prior-only SURFACES are still retained (they can be
    // hand-configured / detection-missed).
    // Detection wins: a repo can gain a Dockerfile or lose its Gemfile, and a
    // stale label is exactly the kind of small lie that costs trust in the rest.
    return withCredentials({
        project, surfaces, pipelines, credentialsRequired: [], notes: prev.notes,
        ...(detected.ecosystem ? { ecosystem: detected.ecosystem } : {}),
    });
}
/**
 * `credentialsRequired` is DERIVED from the surfaces, never passed in. It used
 * to be a hardcoded six-key list, so every repo's state claimed the same creds
 * regardless of what it actually shipped — a Mac-only app said it needed three
 * while its wired surfaces needed R2, a Cloudflare account id and the ASC key.
 * Deriving it here makes that class of drift impossible.
 */
function withCredentials(state) {
    return { ...state, credentialsRequired: requiredVaultKeys(state) };
}
/**
 * The branch field each archetype deploys from. Web apps have none — Vercel's
 * git integration reads the project's own production branch.
 */
export const BRANCH_FIELD = {
    'static-site': 'productionBranch',
    ios: 'testBranch',
    android: 'testBranch',
};
/**
 * Fill every configured surface's missing branch with the repository's own
 * default branch. Returns `<surface>.<field>` for each one filled.
 *
 * The setup skill used to write `main` into every surface, and a repository
 * whose trunk is `master` or `develop` then deployed every push as a preview —
 * production never changed — or never shipped a build at all, silently
 * (harness/journey/JOURNEY.md, harvest item 2). The default branch is a fact
 * `git.ts` already reads for Nightshift; guessing it is the bug.
 *
 * Only an ABSENT value is filled: a branch somebody chose — including a static
 * site's pre-rename `testBranch` — is theirs, and a surface with no settings
 * yet is left for the skill to gather.
 */
export function fillDefaultBranch(surfaces, branch) {
    const filled = [];
    const present = (v) => typeof v === 'string' && v.trim() !== '';
    for (const s of surfaces) {
        const field = BRANCH_FIELD[s.archetype];
        if (!field || !s.config)
            continue;
        const c = s.config;
        if (present(c[field]))
            continue;
        if (s.archetype === 'static-site' && present(c.testBranch))
            continue; // pre-rename spelling
        c[field] = branch;
        filled.push(`${s.id}.${field}`);
    }
    return filled;
}
