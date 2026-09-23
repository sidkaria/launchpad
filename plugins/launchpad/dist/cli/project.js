import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { launchpadHome } from '../home.js';
const MAX_DEPTH = 64;
export function findProjectRoot(cwd = process.cwd(), home = launchpadHome()) {
    const start = resolve(cwd);
    const homeAbs = resolve(home);
    let root = null;
    let via = 'cwd';
    let gitRoot = null;
    let dir = start;
    for (let i = 0; i < MAX_DEPTH; i++) {
        // Never adopt the home directory as a project unless that is where the
        // command was actually run.
        const atHomeFromBelow = dir === homeAbs && dir !== start;
        if (!atHomeFromBelow) {
            if (!root && existsSync(join(dir, '.launchpad', 'state.yml'))) {
                root = dir;
                via = 'state';
            }
            if (existsSync(join(dir, '.git'))) {
                if (!gitRoot)
                    gitRoot = dir;
                if (!root) {
                    root = dir;
                    via = 'git';
                }
            }
        }
        if (root && gitRoot)
            break;
        if (atHomeFromBelow)
            break;
        const up = dirname(dir);
        if (up === dir)
            break;
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
export function looksLikeProject(dir) {
    let names;
    try {
        names = readdirSync(dir);
    }
    catch {
        return false;
    }
    return names.some(n => MARKERS.includes(n) || n.endsWith('.xcodeproj') || n.endsWith('.xcworkspace'));
}
/** `~/…` for display. A path in a terminal message should not have to carry a username. */
export function tildify(p, home = launchpadHome()) {
    const h = resolve(home);
    const abs = resolve(p);
    if (abs === h)
        return '~';
    return abs.startsWith(h + sep) ? `~${sep}${relative(h, abs)}` : abs;
}
function git(root, args) {
    try {
        return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    }
    catch {
        return null;
    }
}
/**
 * The hosts every remote points at, reduced to a host. Never the path — a
 * private repo's name can be the unreleased product.
 */
export function remoteHosts(root) {
    const out = git(root, ['remote', '-v']);
    if (!out)
        return [];
    const hosts = new Set();
    for (const line of out.split('\n')) {
        const url = line.split(/\s+/)[1] ?? '';
        const m = /^[a-z+]+:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) ?? /^(?:[^@]+@)?([^:/]+):/.exec(url);
        if (m)
            hosts.add(m[1].toLowerCase());
    }
    return [...hosts];
}
/** Local and remote-tracking branch names, without the `origin/` prefix. */
export function branchNames(root) {
    const out = git(root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/remotes']);
    if (!out)
        return [];
    return [...new Set(out.split('\n').filter(Boolean).map(r => r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/[^/]+\//, '')).filter(b => b !== 'HEAD'))];
}
