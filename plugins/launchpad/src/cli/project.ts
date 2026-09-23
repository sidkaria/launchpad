import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { launchpadHome } from '../home.js';

/**
 * Which directory a command is about.
 *
 * Every verb used to take `process.cwd()` at face value, and three things a
 * buyer does in their first ten minutes broke on it:
 *
 *   1. **Run from a subdirectory.** `cd apps/web && /launchpad:onboard` wrote
 *      `apps/web/.launchpad/` and `apps/web/.github/workflows/…` — a workflow
 *      GitHub never runs, because GitHub only reads `.github/` at the
 *      repository root. The pipeline looked written and could never fire.
 *   2. **Run from somewhere that is not a project at all** — a home directory,
 *      `~/Downloads`, a fresh terminal. `setup` wrote `.launchpad/` and a
 *      `CLAUDE.md` into it, `score` graded an empty folder as "8 things
 *      between this and a product", and `add` put it on the dashboard.
 *   3. **Run inside a project with no git yet.** That one is a real project
 *      and must keep working — it is simply told what it is missing.
 *
 * So: walk up from where the command was run to the nearest directory that is
 * already a launchpad project (`.launchpad/state.yml`) or a git repository
 * (`.git`, a directory or a submodule's file). The nearer one wins, which is
 * what keeps a project deliberately set up in a subdirectory working exactly as
 * it did. The walk never climbs INTO the home directory from below it: a
 * dotfiles repository at `~` would otherwise make every un-versioned project
 * under it "the home directory", and score the whole disk.
 */
export interface ProjectRoot {
  /** The directory the command should act on. */
  root: string;
  /** Where the command was run. */
  cwd: string;
  /** What decided `root`: an existing launchpad project, a git repo, or nothing (cwd as-is). */
  via: 'state' | 'git' | 'cwd';
  /** The enclosing git work tree's top, when there is one. */
  gitRoot: string | null;
}

const MAX_DEPTH = 64;

export function findProjectRoot(cwd = process.cwd(), home = launchpadHome()): ProjectRoot {
  const start = resolve(cwd);
  const homeAbs = resolve(home);
  let root: string | null = null;
  let via: ProjectRoot['via'] = 'cwd';
  let gitRoot: string | null = null;
  let dir = start;
  for (let i = 0; i < MAX_DEPTH; i++) {
    // Never adopt the home directory as a project unless that is where the
    // command was actually run.
    const atHomeFromBelow = dir === homeAbs && dir !== start;
    if (!atHomeFromBelow) {
      if (!root && existsSync(join(dir, '.launchpad', 'state.yml'))) { root = dir; via = 'state'; }
      if (existsSync(join(dir, '.git'))) {
        if (!gitRoot) gitRoot = dir;
        if (!root) { root = dir; via = 'git'; }
      }
    }
    if (root && gitRoot) break;
    if (atHomeFromBelow) break;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { root: root ?? start, cwd: start, via, gitRoot };
}

/**
 * Top-level names that mean "somebody's software lives here". Deliberately
 * broad: the cost of a false positive is that a folder gets scored, and the
 * cost of a false negative is refusing a real project that simply has no git
 * yet — which is the case this list exists to let through.
 */
const MARKERS = [
  'package.json', 'pubspec.yaml', 'Cargo.toml', 'go.mod', 'Gemfile', 'pyproject.toml',
  'requirements.txt', 'setup.py', 'Pipfile', 'build.gradle', 'build.gradle.kts', 'settings.gradle',
  'settings.gradle.kts', 'Package.swift', 'project.yml', 'Podfile', 'composer.json', 'mix.exs',
  'pom.xml', 'CMakeLists.txt', 'Makefile', 'index.html', 'deno.json', 'app.json', 'src', 'lib', 'app',
  'ios', 'android', 'macos', 'web', 'site', 'public', '.launchpad',
];

export function looksLikeProject(dir: string): boolean {
  let names: string[];
  try { names = readdirSync(dir); } catch { return false; }
  return names.some(n => MARKERS.includes(n) || n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
}

/** `~/…` for display. A path in a terminal message should not have to carry a username. */
export function tildify(p: string, home = launchpadHome()): string {
  const h = resolve(home);
  const abs = resolve(p);
  if (abs === h) return '~';
  return abs.startsWith(h + sep) ? `~${sep}${relative(h, abs)}` : abs;
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

/**
 * The hosts every remote points at, reduced to a host. Never the path — a
 * private repo's name can be the unreleased product.
 */
export function remoteHosts(root: string): string[] {
  const out = git(root, ['remote', '-v']);
  if (!out) return [];
  const hosts = new Set<string>();
  for (const line of out.split('\n')) {
    const url = line.split(/\s+/)[1] ?? '';
    const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) ?? /^(?:[^@]+@)?([^:/]+):/.exec(url);
    if (m) hosts.add(m[1].toLowerCase());
  }
  return [...hosts];
}

/** Local and remote-tracking branch names, without the `origin/` prefix. */
export function branchNames(root: string): string[] {
  const out = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
  if (!out) return [];
  return [...new Set(out.split('\n').filter(Boolean).map(r =>
    r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')).filter(b => b !== 'HEAD'))];
}
