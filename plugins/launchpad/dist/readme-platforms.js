import { PLATFORMS, SURFACE_LABELS } from './platforms.js';
/**
 * The README's "what it works on" section, rendered from the registry.
 *
 * The README carried two hand-written tables — five surfaces, four ways to
 * build mobile — and the buyer journey found them saying "Play" for Android,
 * where no pipeline launchpad writes uploads to Play. A hand-written list goes
 * stale silently and the stale copy is the one the buyer reads (ARCHITECTURE
 * §4, DECISIONS 2026-09-21: "the landing page keeps no list of its own"). The
 * README now keeps none either: this block is generated, and
 * `test/readme.test.ts` fails when README.md drifts from it.
 *
 * Regenerate with `npm run readme` (from plugins/launchpad).
 */
export const README_START = '<!-- launchpad:platforms:start — generated from plugins/launchpad/src/platforms.ts; `npm run readme` rewrites it -->';
export const README_END = '<!-- launchpad:platforms:end -->';
const surfaces = (p) => (p.archetypes ?? []).map(a => SURFACE_LABELS[a]).join(' + ');
export function renderPlatformsBlock(platforms = PLATFORMS) {
    const deploys = platforms.filter(p => p.status === 'deploys');
    // Platforms that ship the same way are one row: a dozen web frameworks all
    // go to Vercel in the same sentence, and a row each would bury the ones that
    // differ.
    const groups = new Map();
    for (const p of deploys) {
        // A platform with a caveat keeps its own row: the caveat is about IT, and
        // two caveats run together read as one repetitive paragraph.
        const k = p.caveat ? `solo:${p.id}` : `${surfaces(p)}|${p.shipsTo}`;
        groups.set(k, [...(groups.get(k) ?? []), p]);
    }
    const rows = [...groups.values()].map(g => {
        const names = g.map(p => p.name).join(', ');
        const shipsTo = g.length > 1 ? g[0].shipsTo.split(' — ')[0] : g[0].shipsTo;
        const caveats = g.filter(p => p.caveat).map(p => p.caveat.replace(/\s+/g, ' ').trim());
        return `| ${names} | ${surfaces(g[0])} | ${shipsTo}${caveats.length ? `<br>*${caveats.join(' ')}*` : ''} |`;
    });
    const recognised = platforms.filter(p => p.status === 'recognised').map(p => p.name);
    const planned = platforms.filter(p => p.status === 'planned').map(p => p.name);
    const count = Object.keys(SURFACE_LABELS).length;
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven'];
    return [
        README_START,
        `launchpad ships real pipelines for ${words[count]} kinds of surface — ${Object.values(SURFACE_LABELS).join(', ')} — built`,
        'with any of these:',
        '',
        '| Built with | Surface | Where it ships |',
        '|---|---|---|',
        ...rows,
        '',
        `**Recognised, with no pipeline** — named, scored in its own terms, on the dashboard, and told plainly that`,
        `there is nothing for \`apply\` to write: ${recognised.join(', ')}.`,
        ...(planned.length ? ['', `**Detected and deliberately refused, for now:** ${planned.join(', ')}.`] : []),
        README_END,
    ].join('\n');
}
