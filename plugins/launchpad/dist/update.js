/**
 * Telling a customer their copy is old.
 *
 * Without this, someone who buys today is on today's build forever — and every
 * bug fixed after their purchase is one they will hit and never escape. For a
 * one-time-purchase product with no subscription to remind anybody it exists,
 * the update path IS the support channel.
 *
 * Three deliberate limits, and they are all about not being creepy or
 * dangerous with somebody else's machine:
 *
 *   1. **It never checks unless asked.** No background phone-home, no
 *      telemetry on every command. `launchpad update` is a question the user
 *      asked; anything else is a question we asked about them.
 *   2. **It never installs.** Overwriting a running plugin in place, on a
 *      machine we cannot see, to fix a bug we have not reproduced there, is a
 *      good way to turn one broken install into a broken install with no way
 *      back. It tells you what changed and where to get it.
 *   3. **It fails quietly.** An unreachable update server is not the user's
 *      problem and must never look like one, so it degrades to "could not
 *      check" and the command they actually ran still works.
 */
/**
 * Where the release manifest lives: the public marketplace repository, served by
 * GitHub.
 *
 * The previous default was `https://launchpad.sh/releases/latest.json` — a domain
 * nobody owns. A dead update endpoint is worse than none at all, because the
 * licence skill correctly calls the update path "the support channel": for a
 * one-time purchase with nothing to remind anyone it exists, a customer who
 * bought on day one is otherwise on day one's build forever, and every bug fixed
 * afterwards is one they hit and never escape.
 *
 * The marketplace repo is the right home for it. It costs nothing, needs no DNS,
 * and puts the version in the same place Claude Code already reads the
 * marketplace from — so the two cannot disagree.
 *
 * Note what this is NOT. Claude Code updates the plugin itself, natively, via
 * `/plugin marketplace update` and its background refresh. This manifest answers
 * the question that flow cannot express: is the copy you have missing a fix that
 * matters to YOU — release notes, and a `criticalBelow` floor for a data-loss or
 * security fix. It never installs anything.
 *
 * Overridable so a test never touches the network, and so anyone self-hosting can
 * point it elsewhere.
 */
export const MANIFEST_URL = process.env.LAUNCHPAD_UPDATE_URL
    ?? 'https://raw.githubusercontent.com/sidkaria/launchpad/main/releases/latest.json';
/**
 * Compare two dotted versions numerically.
 *
 * String comparison gets `0.10.0` < `0.9.0` wrong, which would tell every
 * customer they are up to date for the entire 0.10 series.
 */
export function compareVersions(a, b) {
    const parse = (v) => v.replace(/^v/, '').split(/[.\-+]/).map(n => Number(n) || 0);
    const [x, y] = [parse(a), parse(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] ?? 0) - (y[i] ?? 0);
        if (d !== 0)
            return d < 0 ? -1 : 1;
    }
    return 0;
}
/** Coerce, never trust: this JSON comes off the network. */
function coerce(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.version !== 'string' || !/^\d/.test(r.version.replace(/^v/, '')))
        return null;
    return {
        version: r.version,
        url: typeof r.url === 'string' ? r.url : undefined,
        published: typeof r.published === 'string' ? r.published : undefined,
        notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string').slice(0, 20) : undefined,
        criticalBelow: typeof r.criticalBelow === 'string' ? r.criticalBelow : undefined,
    };
}
export async function checkForUpdate(current, fetcher, url = MANIFEST_URL) {
    let release;
    try {
        const res = await fetcher(url);
        if (!res.ok)
            return { state: 'unknown', why: `the update server answered ${res.status}` };
        release = coerce(await res.json());
    }
    catch (e) {
        // Offline, firewalled, DNS-blocked, or the host is simply down. None of
        // those are the user's fault and none should read as a failure of theirs.
        return { state: 'unknown', why: e.message };
    }
    if (!release)
        return { state: 'unknown', why: 'the update server sent something unreadable' };
    const cmp = compareVersions(current, release.version);
    if (cmp === 0)
        return { state: 'current', version: current };
    if (cmp > 0)
        return { state: 'ahead', version: current };
    return {
        state: 'behind',
        from: current,
        to: release,
        critical: Boolean(release.criticalBelow && compareVersions(current, release.criticalBelow) < 0),
    };
}
export function renderUpdate(c) {
    switch (c.state) {
        case 'current':
            return `launchpad ${c.version} — up to date.`;
        case 'ahead':
            return `launchpad ${c.version} — newer than the published release. This is a dev build.`;
        case 'unknown':
            return `launchpad: could not check for updates (${c.why}).\n`
                + '  Nothing is wrong with your install; the check simply did not reach anywhere.';
        case 'behind': {
            const out = [
                c.critical
                    ? `launchpad ${c.from} → ${c.to.version} — this one is important, not optional.`
                    : `launchpad ${c.from} → ${c.to.version} available.`,
            ];
            if (c.to.published)
                out.push(`  published ${c.to.published.slice(0, 10)}`);
            if (c.to.notes?.length) {
                out.push('');
                for (const n of c.to.notes.slice(0, 8))
                    out.push(`  · ${n}`);
            }
            out.push('');
            out.push(c.to.url ? `  Download: ${c.to.url}` : '  Check where you bought it for the new build.');
            // Nothing is installed for them, and the reason is stated rather than
            // left to look like a missing feature.
            out.push('  Replace the plugin directory with the new one — launchpad does not overwrite itself,');
            out.push('  because a half-applied update on a machine nobody can see is worse than an old one.');
            return out.join('\n');
        }
    }
}
export const realFetcher = async (url) => {
    const res = await fetch(url, { headers: { accept: 'application/json' } });
    return { ok: res.ok, status: res.status, json: () => res.json() };
};
