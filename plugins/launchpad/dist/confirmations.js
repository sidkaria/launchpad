import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
const REL = join('.launchpad', 'confirmed.yml');
const HEADER = `# Answers to the questions launchpad cannot answer by reading this repo.
# Written by \`launchpad confirm <check>\`, and safe to edit or delete by hand.
# Only checks graded "?" can appear here — a real gap cannot be confirmed away.
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
