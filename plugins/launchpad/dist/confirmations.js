import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
const REL = join('.launchpad', 'confirmed.yml');
const HEADER = `# Answers to the questions launchpad cannot answer by reading this repo.
# Written by \`launchpad confirm <check>\`, and safe to edit or delete by hand.
# Only checks graded "?" can appear here — a real gap cannot be confirmed away.
# Ids with a colon (money:, irreversible:, gate:, keep:) are answers to the
# "needs you" list rather than to a scorecard row; deleting one asks again.
`;
export function readConfirmations(repo) {
    const p = join(repo, REL);
    if (!existsSync(p))
        return {};
    try {
        const raw = parse(readFileSync(p, 'utf8'));
        if (!raw || typeof raw !== 'object')
            return {};
        const out = {};
        for (const [id, v] of Object.entries(raw)) {
            // Tolerant of a hand-edited file: `keystore-backup: true` is an obvious
            // thing for someone to write, and refusing it would be pedantry.
            if (v === true) {
                out[id] = { at: 'unknown' };
                continue;
            }
            if (v && typeof v === 'object') {
                const o = v;
                out[id] = {
                    at: typeof o.at === 'string' ? o.at : 'unknown',
                    ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
                    ...(typeof o.choice === 'string' && o.choice ? { choice: o.choice } : {}),
                };
            }
        }
        return out;
    }
    catch {
        // A corrupt file must not break the scorecard — it degrades to "unanswered".
        return {};
    }
}
export function writeConfirmations(repo, c) {
    mkdirSync(join(repo, '.launchpad'), { recursive: true });
    writeFileSync(join(repo, REL), HEADER + (Object.keys(c).length ? stringify(c) : ''), 'utf8');
}
export function confirm(repo, id, note, now = new Date()) {
    const c = readConfirmations(repo);
    c[id] = { at: now.toISOString().slice(0, 10), ...(note ? { note } : {}) };
    writeConfirmations(repo, c);
    return c;
}
export function unconfirm(repo, id) {
    const c = readConfirmations(repo);
    delete c[id];
    writeConfirmations(repo, c);
    return c;
}
/**
 * Record an answer that carries a direction — accept, decline, acknowledged.
 *
 * `confirm()` with one more field rather than a second writer, so there is
 * exactly one file format and exactly one place that knows how to date a
 * record. The id must be namespaced (`money:…`), which is what keeps these out
 * of the scorecard's way; passing a bare id here would put a row in the file
 * that `scorecard()` would then read as a confirmation, which is the one thing
 * the namespace exists to prevent.
 */
export function record(repo, id, choice, note, now = new Date()) {
    if (!id.includes(':')) {
        throw new Error(`a recorded answer needs a namespaced id (got "${id}") — bare ids belong to the scorecard`);
    }
    const c = readConfirmations(repo);
    c[id] = { at: now.toISOString().slice(0, 10), choice, ...(note ? { note } : {}) };
    writeConfirmations(repo, c);
    return c;
}
/**
 * Everything answered here that is NOT a scorecard row, newest first.
 *
 * The promise is that an acknowledgement is reachable afterwards: "you decided
 * this on <date>" has to be somewhere a person can go and look, or the button
 * that made an item disappear was a button that hid a decision.
 */
export function recordedAnswers(repo) {
    return Object.entries(readConfirmations(repo))
        .filter(([id]) => id.includes(':'))
        .map(([id, c]) => ({ id, at: c.at, ...(c.choice ? { choice: c.choice } : {}), ...(c.note ? { note: c.note } : {}) }))
        .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
