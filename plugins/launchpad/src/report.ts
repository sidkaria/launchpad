import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { arch, platform, release, type as osType } from 'node:os';
import { launchpadHome } from './home.js';
import { basename, join } from 'node:path';
import { parse } from 'yaml';
import { detect } from './detect.js';
import { detectEcosystem } from './ecosystem.js';
import { currentBranch, defaultBranch, hasReleaseTag, isRepo } from './git.js';
import { entitlement, licenceWord, readLicense } from './license.js';
import { hostSupport } from './platform.js';
import { provenance, type Provenance } from './provenance.js';
import { scorecard } from './scorecard.js';
import { requiredVaultKeys } from './secrets.js';
import { mergeState, readState, statePath } from './state.js';
import { makeVault } from './vault.js';
import { keyTail, MASK, redact, redactFreeText, redactTree, remoteHost, shortenPath } from './redact.js';
import type { Archetype } from './types.js';

/**
 * One paste instead of ten questions.
 *
 * A one-time price at this level only works if support stays near zero, and
 * almost every support thread starts with the same four rounds: which build,
 * which OS, which surfaces, is the credential actually there. This answers all
 * of them before the first reply — and the answers are worth more than the
 * customer's own account of them, because "I installed it" and "it is
 * installed" are different claims.
 *
 * **What it must never do is leak.** The buyer is holding an App Store Connect
 * key, a keystore that cannot be replaced, and a DNS-edit token, and they will
 * paste this into a public issue without reading it. So the rule is that the
 * report says whether a credential is PRESENT, by name, and never anything
 * else about it: not its value, not its length, not a hash — a length is a hint
 * about the key space and buys a reader nothing.
 *
 * The collection policy is an allowlist for the same reason `publish.ts` is.
 * Nothing here opens `.env`, reads a vault value, or lists a changed filename.
 * See `redact.ts` for the second layer over the top of it.
 */

/** How a tool is asked its version. `null` back means "not installed". */
export type ToolProbe = (bin: string, args: string[]) => string | null;

export interface ToolVersion {
  name: string;
  /** First line of its version output, redacted. `null` when absent. */
  version: string | null;
}

export interface Report {
  generated: string;
  launchpad: { version: string; channel: string; root: string };
  host: { os: string; platform: string; release: string; arch: string; node: string; shell: string };
  capabilities: Array<{ surface: Archetype; buildableHere: boolean; note: string; macOnlySetup: string[] }>;
  tools: ToolVersion[];
  project: {
    name: string;
    setUp: boolean;
    ecosystem: string | null;
    surfaces: Array<{ id: string; archetype: string; confidence: string; status: string; evidence: string[] }>;
    pipelines: Array<{ kind: string; path: string; disposition: string }>;
  };
  state: unknown | null;
  credentials: Array<{ name: string; present: boolean }>;
  license: { state: string; key: string; provider: string; validatedAt: string | null };
  scorecard: { remaining: number; passed: number; applicable: number; unconfirmed: number; next: string | null } | null;
  git: {
    repo: boolean; defaultBranch: string; currentBranch: string | null;
    dirty: boolean | null; changedFiles: number | null; remoteHost: string; hasReleaseTag: boolean;
  };
  logs: Array<{ file: string; tail: string[] }>;
}

export interface ReportDeps {
  repo: string;
  home?: string;
  now?: Date;
  probe?: ToolProbe;
  /** Only ever asked whether a key EXISTS. There is no path here to a value. */
  vaultHas?: (key: string) => boolean;
  prov?: Provenance;
  /** How many trailing log lines to include. */
  logLines?: number;
}

/**
 * The tools whose version changes the answer to a support question.
 *
 * `java -version` writes to stderr and several of these are commonly absent, so
 * the probe reads both streams, never throws, and is bounded — a probe that can
 * hang turns the one command we ask a stuck customer to run into another thing
 * that does not work.
 */
const TOOLS: Array<{ name: string; bin: string; args: string[] }> = [
  { name: 'git', bin: 'git', args: ['--version'] },
  { name: 'gh', bin: 'gh', args: ['--version'] },
  { name: 'xcodebuild', bin: 'xcodebuild', args: ['-version'] },
  { name: 'flutter', bin: 'flutter', args: ['--version'] },
  { name: 'fastlane', bin: 'fastlane', args: ['--version'] },
  { name: 'ruby', bin: 'ruby', args: ['--version'] },
  { name: 'java', bin: 'java', args: ['-version'] },
  { name: 'vercel', bin: 'vercel', args: ['--version'] },
  { name: 'wrangler', bin: 'wrangler', args: ['--version'] },
];

const PROBE_TIMEOUT_MS = 3_000;

export const realProbe: ToolProbe = (bin, args) => {
  try {
    const r = spawnSync(bin, args, {
      timeout: PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
      // Never inherit a stdin: a tool that decides to prompt would hang the
      // report forever on somebody else's machine.
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error) return null;
    // `java -version` exits 0 and prints to stderr, so both streams are read.
    // Colour codes stripped, and the first line that carries a version wins:
    // fastlane opens with "fastlane installation at path:" and a locale
    // warning, and its version is five lines down.
    const text = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\u001b\[[0-9;]*m/g, '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    const line = lines.find(l => /\d+\.\d+/.test(l) && !/^\//.test(l) && !/WARNING/i.test(l)) ?? lines[0];
    return line ?? null;
  } catch {
    return null;
  }
};

/** Absent tools are reported as absent. Missing is a diagnosis, not an error. */
function probeTools(probe: ToolProbe, home: string): ToolVersion[] {
  return TOOLS.map(({ name, bin, args }) => {
    let version: string | null = null;
    try {
      const raw = probe(bin, args);
      // Version banners quote install paths; a path carries the user's name.
      version = raw ? redactFreeText(raw, home).slice(0, 120) : null;
    } catch {
      version = null;
    }
    return { name, version };
  });
}

/** The origin URL from `.git/config`, read rather than asked of `git`. */
function originUrl(repo: string): string {
  try {
    const cfg = readFileSync(join(repo, '.git', 'config'), 'utf8');
    const section = /\[remote "origin"\]([\s\S]*?)(?=\n\[|$)/.exec(cfg);
    return /^\s*url\s*=\s*(.+)$/m.exec(section?.[1] ?? '')?.[1]?.trim() ?? '';
  } catch {
    return '';
  }
}

/**
 * Clean or dirty, as a count and never as a list.
 *
 * Filenames are content: a path under `secrets/` or a branch-shaped feature
 * name can say more about an unreleased product than the diff would. The number
 * answers the only question support actually has — "is there uncommitted work
 * that explains this?" — and carries nothing.
 */
function worktreeDirty(repo: string): { dirty: boolean | null; changed: number | null } {
  try {
    const r = spawnSync('git', ['status', '--porcelain'], {
      cwd: repo, timeout: PROBE_TIMEOUT_MS, encoding: 'utf8', windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (r.error || r.status !== 0) return { dirty: null, changed: null };
    const lines = (r.stdout ?? '').split('\n').filter(l => l.trim());
    return { dirty: lines.length > 0, changed: lines.length };
  } catch {
    return { dirty: null, changed: null };
  }
}

/** launchpad's own logs — the overnight worker's, the only ones it writes. */
function tailLogs(repo: string, home: string, lines: number): Array<{ file: string; tail: string[] }> {
  const dir = join(repo, '.launchpad', 'nightshift');
  const out: Array<{ file: string; tail: string[] }> = [];
  for (const name of ['nightshift.out.log', 'nightshift.err.log']) {
    const p = join(dir, name);
    if (!existsSync(p)) continue;
    try {
      const body = readFileSync(p, 'utf8');
      const tail = body.split('\n').filter(Boolean).slice(-lines).map(l => redactFreeText(l, home).slice(0, 300));
      if (tail.length) out.push({ file: join('.launchpad', 'nightshift', name), tail });
    } catch {
      // An unreadable log is not worth failing a diagnostic over.
    }
  }
  return out;
}

/**
 * Entitlement as one word — `licenceWord` in license.ts, so `report` and
 * `license` can never call one key two things. `lapsed` is kept as its own
 * word rather than folded into `unlicensed`: a bundle that cannot say "the
 * provider is actively rejecting this key" hides the one licence fact support
 * needs, and the two call for opposite replies.
 */

export function buildReport(deps: ReportDeps): Report {
  const home = deps.home ?? launchpadHome();
  const now = deps.now ?? new Date();
  const repo = deps.repo;
  const probe = deps.probe ?? realProbe;
  const prov = deps.prov ?? provenance();

  const stored = readState(repo);
  const live = mergeState(stored, detect(repo), basename(repo));
  const state = stored ?? live;
  const eco = detectEcosystem(repo);

  const vaultHas = deps.vaultHas ?? ((key: string) => {
    try { return makeVault().has(key); } catch { return false; }
  });

  let card: Report['scorecard'] = null;
  try {
    const s = scorecard(repo, state);
    card = {
      remaining: s.remaining, passed: s.passed, applicable: s.applicable,
      unconfirmed: s.unconfirmed, next: s.next?.title ?? null,
    };
  } catch {
    // The scorecard reads the repo; a half-readable one must not lose the rest
    // of the bundle, which is exactly when somebody is asking for help.
    card = null;
  }

  const rec = readLicense(home);
  const ent = entitlement(rec, now);

  // Raw YAML rather than the coerced state: a hand-edited file may carry keys
  // the type does not know about, and those are precisely the ones worth seeing
  // — so they are shown, scrubbed, rather than silently dropped.
  let rawState: unknown = null;
  try {
    if (existsSync(statePath(repo))) rawState = parse(readFileSync(statePath(repo), 'utf8'));
  } catch {
    rawState = null;
  }

  const { dirty, changed } = worktreeDirty(repo);
  const surfaceKinds = [...new Set(live.surfaces.map(s => s.archetype))];

  return {
    generated: now.toISOString(),
    launchpad: {
      version: prov.version,
      channel: prov.origin,
      root: shortenPath(prov.root, home),
    },
    host: {
      os: osType(),
      platform: platform(),
      release: release(),
      arch: arch(),
      node: process.version,
      // The shell's PATH is not printed anywhere: it is a list of the user's
      // directories, and several of them carry their name.
      shell: basename(process.env.SHELL ?? process.env.ComSpec ?? 'unknown'),
    },
    capabilities: surfaceKinds.map(a => {
      const h = hostSupport(a);
      return { surface: a, buildableHere: h.local, note: h.note, macOnlySetup: h.macOnlySetup };
    }),
    tools: probeTools(probe, home),
    project: {
      // The directory's own basename, not its path.
      name: state.project || basename(repo),
      setUp: Boolean(stored),
      ecosystem: eco ? `${eco.name} (${eco.evidence})` : null,
      surfaces: live.surfaces.map(s => ({
        id: s.id, archetype: s.archetype, confidence: s.confidence, status: s.status,
        evidence: s.evidence.map(e => redact(e, home)),
      })),
      pipelines: live.pipelines.map(p => ({
        kind: p.kind, path: redact(p.path, home), disposition: p.disposition ?? 'undecided',
      })),
    },
    state: rawState === null ? null : redactTree(rawState, home),
    /**
     * By NAME only, and only the names this project actually needs. The vault
     * is asked `has`, which returns a boolean; there is no code path from here
     * to a stored value.
     */
    credentials: requiredVaultKeys(state).map(name => ({ name, present: vaultHas(name) })),
    license: {
      state: licenceWord(ent.state),
      key: keyTail(rec?.key),
      provider: rec?.provider ?? (rec ? 'lemonsqueezy' : 'none'),
      validatedAt: rec?.validatedAt ?? null,
    },
    scorecard: card,
    git: {
      repo: isRepo(repo),
      defaultBranch: defaultBranch(repo),
      currentBranch: currentBranch(repo),
      dirty,
      changedFiles: changed,
      remoteHost: remoteHost(originUrl(repo)),
      hasReleaseTag: hasReleaseTag(repo),
    },
    logs: tailLogs(repo, home, deps.logLines ?? 20),
  };
}

const yesNo = (b: boolean) => (b ? 'yes' : 'no');

/**
 * Markdown for a human, then the same facts as JSON for us.
 *
 * Both, because the two readers are different: the customer should be able to
 * see what they are about to paste — a bundle nobody can read is a bundle
 * nobody sends — and the JSON is what makes a pile of these greppable when the
 * same bug arrives four times.
 */
export function renderReport(r: Report, home = ''): string {
  const out: string[] = [];
  const p = (s = '') => out.push(s);

  p('# launchpad report');
  p();
  p(`Generated ${r.generated}. **Paste this whole thing into a support thread.**`);
  p();
  p('Credentials appear by name only — present or missing, never a value, a length or a hash.');
  p('Paths are shortened to `~`, and git remotes are reduced to a host.');
  p();

  p('## launchpad');
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| version | ${r.launchpad.version} |`);
  p(`| channel | ${r.launchpad.channel} |`);
  p(`| root | \`${r.launchpad.root}\` |`);
  p(`| licence | **${r.license.state}** (key ${r.license.key}, provider ${r.license.provider}) |`);
  p();

  p('## Host');
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| os | ${r.host.os} ${r.host.release} (${r.host.platform}) |`);
  p(`| arch | ${r.host.arch} |`);
  p(`| node | ${r.host.node} |`);
  p(`| shell | ${r.host.shell} |`);
  p();

  if (r.capabilities.length) {
    p('### What this machine can build');
    p();
    for (const c of r.capabilities) {
      p(`- **${c.surface}** — buildable here: ${yesNo(c.buildableHere)}${c.note ? ` — ${c.note}` : ''}`);
      for (const s of c.macOnlySetup) p(`  - needs a Mac once: ${s}`);
    }
    p();
  }

  p('## Tools');
  p();
  for (const t of r.tools) p(`- ${t.name}: ${t.version ?? '_not installed_'}`);
  p();

  p('## Project');
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| name | ${r.project.name} |`);
  p(`| set up | ${yesNo(r.project.setUp)} |`);
  p(`| ecosystem | ${r.project.ecosystem ?? '_none detected_'} |`);
  p();
  if (r.project.surfaces.length) {
    p('### Surfaces');
    p();
    for (const s of r.project.surfaces) {
      p(`- **${s.id}** (${s.archetype}) — ${s.confidence} confidence, ${s.status}`);
      for (const e of s.evidence) p(`  - ${e}`);
    }
    p();
  } else {
    p('_No deployable surface detected._');
    p();
  }
  if (r.project.pipelines.length) {
    p('### Existing pipelines');
    p();
    for (const pl of r.project.pipelines) p(`- ${pl.kind} at \`${pl.path}\` — disposition: ${pl.disposition}`);
    p();
  }

  p('## Credentials');
  p();
  if (!r.credentials.length) {
    p('_This project requires none._');
  } else {
    for (const c of r.credentials) p(`- ${c.present ? '✓ present' : '✗ MISSING'} — \`${c.name}\``);
  }
  p();

  if (r.scorecard) {
    p('## Scorecard');
    p();
    p(`${r.scorecard.remaining} thing(s) left · ${r.scorecard.passed}/${r.scorecard.applicable} passing · `
      + `${r.scorecard.unconfirmed} only you can answer`);
    if (r.scorecard.next) p(`\nStart with: ${r.scorecard.next}`);
    p();
  }

  p('## Git');
  p();
  p(`| | |`);
  p(`|---|---|`);
  p(`| repository | ${yesNo(r.git.repo)} |`);
  p(`| default branch | ${r.git.defaultBranch} |`);
  p(`| current branch | ${r.git.currentBranch ?? '_detached_'} |`);
  p(`| working tree | ${r.git.dirty === null ? 'unknown' : r.git.dirty ? `dirty (${r.git.changedFiles} file(s))` : 'clean'} |`);
  p(`| remote host | ${r.git.remoteHost} |`);
  p(`| has a release tag | ${yesNo(r.git.hasReleaseTag)} |`);
  p();

  if (r.logs.length) {
    p('## Recent launchpad logs');
    p();
    for (const l of r.logs) {
      p(`### \`${l.file}\``);
      p();
      p('```');
      for (const line of l.tail) p(line);
      p('```');
      p();
    }
  }

  p('## Machine-readable');
  p();
  p('```json');
  p(JSON.stringify(r, null, 2));
  p('```');

  /**
   * The last line of defence, over the finished document.
   *
   * Everything above is already scrubbed at the point it was collected. This
   * runs again over the whole rendering because the collection policy is a
   * policy — one field added in a hurry, by someone who did not read this file,
   * is all it takes — and the cost of a second pass is nothing next to the cost
   * of the leak it is there to catch.
   */
  return redact(out.join('\n'), home) + '\n';
}

/** Everything the verb does, so the CLI stays a one-liner and this stays tested. */
export function report(deps: ReportDeps): string {
  return renderReport(buildReport(deps), deps.home ?? launchpadHome());
}

export { MASK };
