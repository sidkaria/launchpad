import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { launchpadHome } from './home.js';
import { join, resolve } from 'node:path';
import { readStateOrError } from './state.js';
import { scorecard } from './scorecard.js';
export function registryPath(home = launchpadHome()) {
    return join(home, '.launchpad', 'projects.json');
}
export function readRegistry(home = launchpadHome()) {
    const p = registryPath(home);
    if (!existsSync(p))
        return { projects: [] };
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        return { projects: Array.isArray(raw.projects) ? raw.projects.filter(e => e && typeof e.path === 'string') : [] };
    }
    catch {
        // A corrupt registry must not take down every command that reads it. The
        // file holds no unique information — re-adding a project is one command.
        return { projects: [] };
    }
}
export function writeRegistry(reg, home = launchpadHome()) {
    const p = registryPath(home);
    mkdirSync(join(home, '.launchpad'), { recursive: true });
    writeFileSync(p, JSON.stringify(reg, null, 2) + '\n', 'utf8');
}
/** Idempotent: re-adding a known project is a no-op, not a duplicate. */
export function addProject(repo, home = launchpadHome(), now = new Date()) {
    const path = resolve(repo);
    const reg = readRegistry(home);
    if (!reg.projects.some(e => e.path === path)) {
        reg.projects.push({ path, added: now.toISOString() });
        reg.projects.sort((a, b) => a.path.localeCompare(b.path));
        writeRegistry(reg, home);
    }
    return reg;
}
export function removeProject(repo, home = launchpadHome()) {
    const path = resolve(repo);
    const reg = readRegistry(home);
    reg.projects = reg.projects.filter(e => e.path !== path);
    writeRegistry(reg, home);
    return reg;
}
/** How a fleet row identifies itself: the name, qualified only if it must be. */
export const labelOf = (e) => (e.dir ? `${e.dir}/${e.name}` : e.name);
/**
 * Parent-path qualifiers for rows whose names collide — exactly as deep as it
 * takes to tell them apart.
 *
 * One directory up answers `alpha/website` vs `beta/website`. Two are needed
 * for `x/app/web` vs `y/app/web`, and a repo can be nested arbitrarily, so the
 * depth grows until the labels are distinct rather than being fixed at one.
 * When even the full paths cannot separate them — the same path registered
 * twice, which `addProject` makes impossible but a hand-edited registry does
 * not — the longest available qualifier is used and the rows stay equal, which
 * is the truth about them.
 */
export function disambiguate(entries) {
    const out = entries.map(() => undefined);
    const groups = new Map();
    entries.forEach((e, i) => {
        const g = groups.get(e.name);
        if (g)
            g.push(i);
        else
            groups.set(e.name, [i]);
    });
    for (const idx of groups.values()) {
        if (idx.length < 2)
            continue;
        // The path minus its own last segment: what is above this repo on disk.
        const parents = idx.map(i => entries[i].path.split(/[\\/]/).filter(Boolean).slice(0, -1));
        const deepest = Math.max(1, ...parents.map(p => p.length));
        for (let depth = 1; depth <= deepest; depth++) {
            const labels = parents.map(p => p.slice(Math.max(0, p.length - depth)).join('/'));
            if (new Set(labels).size === labels.length || depth === deepest) {
                idx.forEach((i, j) => { out[i] = labels[j] || undefined; });
                break;
            }
        }
    }
    return out;
}
/**
 * Read every registered project fresh. Nothing is cached: a project the user
 * changed five minutes ago must read correctly now, and the whole fleet scores
 * in well under a second.
 */
export function fleet(home = launchpadHome()) {
    const rows = readRegistry(home).projects.map(({ path }) => {
        const name = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
        if (!existsSync(path)) {
            return { path, name, problem: 'directory no longer exists', problemKind: 'missing-directory' };
        }
        const read = readStateOrError(path);
        /**
         * A present-but-broken state file is NOT "not set up".
         *
         * The row used to read "not set up — run /launchpad:onboard here" for a
         * half-pasted `state.yml`, which is false twice over: the project is set
         * up, and the instruction re-runs onboarding over it. The parse error's
         * own first line is what tells the user which line to go and fix.
         */
        if (read.error) {
            return {
                path,
                name,
                problem: `.launchpad/state.yml cannot be read — ${read.error}`,
                problemKind: 'unreadable-state',
            };
        }
        if (!read.state) {
            return { path, name, problem: 'not set up — run /launchpad:onboard here', problemKind: 'not-onboarded' };
        }
        const st = read.state;
        return {
            path,
            name: st.project || name,
            archetypes: [...new Set(st.surfaces.map(s => s.archetype))],
            wired: st.surfaces.filter(s => s.status === 'wired').length,
            surfaces: st.surfaces.length,
            score: scorecard(path, st),
        };
    });
    // Applied to the whole fleet at once, because "is this name ambiguous?" is a
    // question about the fleet and not about one project.
    const dirs = disambiguate(rows);
    return rows.map((row, i) => (dirs[i] ? { ...row, dir: dirs[i] } : row));
}
/** The fleet as one terminal screen. The dashboard renders the same data as a grid. */
export function renderFleet(entries) {
    if (!entries.length) {
        return 'No projects registered yet.\n  Add one by running /launchpad:onboard inside the repo you want to ship.';
    }
    // The same qualifier the dashboard shows. A terminal column of two identical
    // names is no more readable than two identical cards.
    const label = new Map(entries.map(e => [e, labelOf(e)]));
    const width = Math.max(...entries.map(e => label.get(e).length), 7);
    const scored = entries.filter(e => e.score);
    const totalLeft = scored.reduce((n, e) => n + e.score.remaining, 0);
    const totalDone = scored.reduce((n, e) => n + e.score.passed, 0);
    // Progress first, deliberately. A column of percentages sorted by how bad
    // each project is reads as a wall of failure, and every one of these is
    // something the reader built. The same data, led by what is already standing
    // up, is the difference between a to-do list and an indictment.
    const out = [
        `${entries.length} project(s) — ${totalDone} thing${totalDone === 1 ? '' : 's'} done, `
            + `${totalLeft} left across all of them`,
        '',
    ];
    for (const e of entries) {
        if (e.problem) {
            out.push(`  ${label.get(e).padEnd(width)}  —      ${e.problem}`);
            continue;
        }
        const critical = e.score.checks.filter(c => c.critical && c.grade === 'gap').length;
        const left = e.score.remaining;
        out.push(`  ${label.get(e).padEnd(width)}  ${left === 0 ? 'ready ' : `${String(left).padStart(2)} left`}   `
            + `${e.wired}/${e.surfaces} wired   ${e.archetypes.join(', ')}`
            + (critical ? `   ⚠ ${critical} critical` : ''));
    }
    // Point at the one worth an hour, rather than ranking the reader's own work
    // from best to worst.
    const nextUp = scored.filter(e => e.score.remaining > 0).sort((a, b) => b.score.checks.filter(c => c.critical && c.grade === 'gap').length
        - a.score.checks.filter(c => c.critical && c.grade === 'gap').length
        || b.score.remaining - a.score.remaining)[0];
    if (nextUp) {
        out.push('', `  Worth an hour next: ${labelOf(nextUp)} — ${nextUp.score.next?.title ?? 'see the list'}`);
    }
    else if (scored.length) {
        out.push('', '  Nothing left that launchpad can see. Everything it knows to check is done.');
    }
    return out.join('\n');
}
