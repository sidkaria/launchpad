import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { defaultBranch } from '../git.js';

/**
 * Per-project Nightshift settings, in the project's own repo.
 *
 * Every default here is the SAFE one, not the one the author uses. An agent
 * that pushes to main unattended is a defensible choice for someone who built
 * the system and watches it; it is not a defensible default for someone who
 * installed it yesterday. So: disabled until asked, pull requests unless told
 * otherwise, and a budget that stops rather than runs.
 */

export type Mode = 'pr' | 'push';

/**
 * Something to run once, after the night's work has landed.
 *
 * The shape comes from a real config this replaced: "run `./hb deploy` after a
 * drain that touched `apps/mobile/`". Both halves matter. Without the command
 * the overnight work stops at a commit; without the path filter it redeploys
 * every morning whether or not anything relevant changed.
 *
 * It is gated on **committed** paths, not on what the agent touched, because a
 * change that failed the gate was reverted and deploying it would ship work
 * that was explicitly rejected.
 */
export interface PostDrainHook {
  /** Shell command, run from the repo root. */
  run: string;
  /** Repo-relative globs. Empty or absent means "whenever anything was committed". */
  whenPathsChanged?: string[];
  timeoutS?: number;
}

export interface NightshiftConfig {
  enabled: boolean;
  /** Local time, `HH:MM-HH:MM`, may wrap past midnight. */
  window: string;
  /** How work lands. `pr` opens a branch + PR; `push` commits to the base branch. */
  mode: Mode;
  /** Branch PRs target, and the branch `push` mode writes to. */
  baseBranch: string;
  /** Must exit 0 before anything is committed. Never edited by the agent. */
  gate: string;
  /** Adopt an existing backlog instead of creating a second one. Repo-relative. */
  backlogDir?: string;
  /** Repo-relative globs the agent must never modify. */
  protectedPaths: string[];
  /** Hard stop per task. */
  taskTimeoutS: number;
  /** Hard stop for the whole night. */
  maxTasksPerNight: number;
  /**
   * Turn inbox lines and un-scoped tasks into `ready` work before the drain.
   * Off by default: grooming spends the agent on a repo the user may only have
   * meant to queue ideas in.
   */
  groom: boolean;
  /** Ceiling on tasks groomed per night, so a 300-item backlog cannot eat the window. */
  maxGroomPerNight: number;
  /** Run after the night's work lands. See {@link PostDrainHook}. */
  postDrain: PostDrainHook[];
  model?: string;
}

export const CONFIG_PATH = join('.launchpad', 'nightshift', 'config.yml');

/**
 * Paths an autonomous agent must never touch, on any project.
 *
 * These are not a preference. The first three are how it would disable its own
 * safety rails; `.git` is how a bad night becomes an unrecoverable one; and CI
 * config is how an agent that cannot pass the gate learns to delete the gate.
 */
export const ALWAYS_PROTECTED = [
  '.launchpad/nightshift/config.yml',
  '.launchpad/state.yml',
  '.github/workflows/**',
  '.git/**',
];

/**
 * `repo` is optional only so existing callers and tests keep working; pass it
 * wherever there is a repo. Without it `baseBranch` falls back to `main`, which
 * is the assumption that used to be hardcoded — wrong for exactly this
 * product's buyer, whose eighteen-month-old repo is very often on `master`.
 */
export function defaultConfig(gate = '', repo?: string): NightshiftConfig {
  return {
    enabled: false,        // opting in to an agent that writes code should be deliberate
    window: '23:00-07:00',
    mode: 'pr',            // a bad night is a closed PR, not a revert on main
    baseBranch: repo ? defaultBranch(repo) : 'main',
    gate,
    protectedPaths: [],
    taskTimeoutS: 3600,
    maxTasksPerNight: 10,
    groom: false,
    maxGroomPerNight: 5,
    postDrain: [],
  };
}

export function readConfig(repo: string): NightshiftConfig | null {
  const p = join(repo, CONFIG_PATH);
  if (!existsSync(p)) return null;
  try {
    const raw = (parse(readFileSync(p, 'utf8')) ?? {}) as Partial<NightshiftConfig>;
    // Merge over defaults: a config written by an older version, or by hand
    // with half the keys, must still produce a usable — and safe — config.
    return {
      // Detected, so a config written before this existed — or one a human
      // wrote without a baseBranch — targets the branch this repo actually uses.
      ...defaultConfig('', repo), ...raw,
      enabled: raw.enabled === true,
      mode: raw.mode === 'push' ? 'push' : 'pr',
      groom: raw.groom === true,
      postDrain: coerceHooks(raw.postDrain),
    };
  } catch {
    return null;
  }
}

/**
 * Every entry that is not unambiguously a command is dropped, not guessed at.
 * This is the one config field that becomes a shell command running unattended
 * at 3am, so a typo must produce "no hook" rather than "some other hook".
 */
function coerceHooks(raw: unknown): PostDrainHook[] {
  if (!Array.isArray(raw)) return [];
  const out: PostDrainHook[] = [];
  for (const h of raw) {
    if (typeof h === 'string' && h.trim()) { out.push({ run: h.trim() }); continue; }
    if (h && typeof h === 'object' && typeof (h as PostDrainHook).run === 'string' && (h as PostDrainHook).run.trim()) {
      const e = h as PostDrainHook;
      const globs = Array.isArray(e.whenPathsChanged)
        ? e.whenPathsChanged.filter((g): g is string => typeof g === 'string' && g.trim().length > 0)
        : undefined;
      out.push({
        run: e.run.trim(),
        ...(globs?.length ? { whenPathsChanged: globs } : {}),
        ...(Number.isFinite(e.timeoutS) ? { timeoutS: Number(e.timeoutS) } : {}),
      });
    }
  }
  return out;
}

export function writeConfig(repo: string, c: NightshiftConfig): void {
  mkdirSync(join(repo, '.launchpad', 'nightshift'), { recursive: true });
  writeFileSync(join(repo, CONFIG_PATH),
    '# Nightshift — overnight autonomous work. Every default here is the safe one.\n' + stringify(c), 'utf8');
}

/** Every protected path, project settings plus the non-negotiable ones. */
export function protectedPaths(c: NightshiftConfig): string[] {
  return [...new Set([...ALWAYS_PROTECTED, ...c.protectedPaths])];
}

/** Minimal glob support: `**` spans separators, `*` does not. */
function globToRe(glob: string): RegExp {
  const src = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\/?/g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '.*');
  return new RegExp(`^${src}$`);
}

/**
 * Does any of these paths match any of these globs?
 *
 * A bare directory (`apps/mobile/`) is treated as a prefix, because that is
 * what someone writing a path filter means — requiring `apps/mobile/**` makes
 * the hook silently never fire, which looks exactly like "nothing changed".
 */
export function matchesAny(paths: string[], globs: string[]): boolean {
  const res = globs.map(globToRe);
  const prefixes = globs.filter(g => !g.includes('*')).map(g => g.replace(/\/*$/, '/'));
  return paths.some(p => res.some(r => r.test(p)) || prefixes.some(pre => p.startsWith(pre)));
}

/** The hooks that should fire, given what the night actually committed. */
export function hooksToRun(c: NightshiftConfig, committedPaths: string[]): PostDrainHook[] {
  // Nothing was committed: there is nothing to deploy, and firing anyway would
  // redeploy the same build every morning for as long as the queue is empty.
  if (!committedPaths.length) return [];
  return c.postDrain.filter(h => !h.whenPathsChanged?.length || matchesAny(committedPaths, h.whenPathsChanged));
}

/**
 * Which of these changed files the agent was not allowed to touch.
 *
 * Checked AFTER the agent runs and BEFORE anything is committed: an agent
 * cannot be trusted to respect a rule it can read, so the rule is enforced
 * where it cannot be argued with.
 */
export function violations(changedFiles: string[], c: NightshiftConfig): string[] {
  const res = protectedPaths(c).map(globToRe);
  // A directory rule should also catch the directory's own contents.
  const dirRes = protectedPaths(c)
    .filter(p => !p.includes('*'))
    .map(p => new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, '\\$&')}/`));
  return changedFiles.filter(f => res.some(r => r.test(f)) || dirRes.some(r => r.test(f)));
}

/** Is `now` inside the configured window? Handles the overnight wrap. */
export function inWindow(c: NightshiftConfig, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/.exec(c.window);
  if (!m) return true;                       // an unparseable window must not silently disable the night
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  return start <= end ? mins >= start && mins < end : mins >= start || mins < end;
}

/** Everything that must be true before a project may run tonight. */
export function readiness(c: NightshiftConfig | null): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (!c) return { ok: false, problems: ['no config — run /launchpad:nightshift to set it up'] };
  if (!c.enabled) problems.push('disabled (this is a setting, not a failure)');
  if (!c.gate.trim()) {
    problems.push(
      'no gate command. Nothing would verify the agent\'s work before it commits, so this is ' +
      'refused rather than run — a gate is the only thing standing between an overnight agent ' +
      'and pushing code nobody checked.',
    );
  }
  return { ok: problems.length === 0, problems };
}
