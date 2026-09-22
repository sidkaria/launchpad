import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { launchpadHome } from './home.js';
import { join } from 'node:path';
/**
 * One file per project, named by a hash of its path.
 *
 * A hash rather than a slug because two checkouts of the same repo in different
 * directories are different working states, and because a path can contain
 * anything — spaces, unicode, a colon — while a filename cannot.
 */
const fileFor = (home, repo) => join(home, '.launchpad', 'progress', `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.jsonl`);
/** Keep the file small; nobody needs the hundredth-most-recent observation. */
const KEEP = 200;
export function readProgress(repo, home = launchpadHome()) {
    const p = fileFor(home, repo);
    if (!existsSync(p))
        return [];
    try {
        return readFileSync(p, 'utf8').split('\n').filter(Boolean).flatMap(line => {
            try {
                const o = JSON.parse(line);
                return typeof o.at === 'string' && typeof o.remaining === 'number'
                    ? [{ at: o.at, remaining: o.remaining, passed: o.passed ?? 0, unconfirmed: o.unconfirmed ?? 0 }]
                    : [];
            }
            catch {
                return []; // one bad line must not lose the rest of the history
            }
        }).slice(-KEEP);
    }
    catch {
        return [];
    }
}
/**
 * Record where the project is now, if it has moved.
 *
 * Only on a change: `score` may be run five times in a minute while someone
 * works, and five identical lines would bury the one that matters. Silent and
 * non-fatal — a read-only home must not break the command someone actually ran.
 */
export function recordProgress(repo, obs, home = launchpadHome(), now = new Date()) {
    try {
        const history = readProgress(repo, home);
        const last = history[history.length - 1];
        if (last && last.remaining === obs.remaining && last.passed === obs.passed
            && last.unconfirmed === obs.unconfirmed)
            return;
        const p = fileFor(home, repo);
        mkdirSync(join(home, '.launchpad', 'progress'), { recursive: true });
        // Append-only, and rewritten only when it grows past KEEP — so the common
        // case is one short write and never a read-modify-write race with a
        // dashboard reading the same file.
        appendFileSync(p, JSON.stringify({ at: now.toISOString(), ...obs }) + '\n', 'utf8');
    }
    catch {
        // Losing a history line is not worth a word of the user's attention.
    }
}
/** How long ago, in the words a person would use. */
export function ago(then, now) {
    const days = Math.floor((now.getTime() - then.getTime()) / 86_400_000);
    if (days <= 0)
        return 'earlier today';
    if (days === 1)
        return 'yesterday';
    if (days < 14)
        return `${days} days ago`;
    if (days < 60)
        return `${Math.round(days / 7)} weeks ago`;
    return `${Math.round(days / 30)} months ago`;
}
/**
 * The one line worth saying about the past.
 *
 * Compares against the most recent observation that DIFFERS from now, not
 * simply the previous one: after a fix, the next three runs would otherwise all
 * report "no change since earlier today" and the accomplishment would vanish
 * within minutes of happening.
 *
 * Returns null when there is nothing worth saying. Silence is better than
 * "0 things changed", which is a sentence that makes a person feel worse for
 * having looked.
 */
export function progressLine(history, nowObs, now = new Date()) {
    const prior = [...history].reverse().find(o => o.remaining !== nowObs.remaining || o.passed !== nowObs.passed);
    if (!prior)
        return null;
    const closed = prior.remaining - nowObs.remaining;
    const done = nowObs.passed - prior.passed;
    const when = ago(new Date(prior.at), now);
    if (closed > 0) {
        return `${closed} fewer than when you last looked, ${when}. `
            + `${nowObs.remaining === 0 ? 'That was the last one.' : 'Keep going.'}`;
    }
    // Something new appeared — a store surface was added, a dependency changed.
    // Said plainly rather than hidden, and framed as new information rather than
    // as backsliding, because usually that is exactly what it is.
    if (closed < 0) {
        return `${-closed} more than when you last looked, ${when} — new surfaces or new checks apply now.`;
    }
    return done > 0 ? `${done} more confirmed since ${when}.` : null;
}
