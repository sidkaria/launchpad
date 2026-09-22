import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

/**
 * The answers only the user can give.
 *
 * Several checks are honestly unknowable from a repository. Whether the Android
 * upload keystore is backed up somewhere that is not this laptop is a fact about
 * a drawer. Whether the support address reaches a human is a fact about an
 * inbox. The scorecard was right to refuse to guess — and then it offered no way
 * to answer, so those rows said "only you can confirm this" forever, sat in the
 * denominator, and dragged the number down no matter what anyone did. Two of
 * them were marked critical, so every Android project permanently displayed a
 * critical warning that no action could clear.
 *
 * An unanswerable question that is asked every single time is not diligence, it
 * is nagging, and it teaches people to ignore the whole list — including the
 * rows that do matter.
 *
 * Two rules make this safe rather than a self-certification loophole:
 *
 *   1. **Only `unknown` can be confirmed.** A `gap` is evidence launchpad found
 *      of a real problem, and no amount of asserting otherwise may turn it
 *      green. That is what keeps this from becoming the false pass the whole
 *      scorecard exists to avoid.
 *   2. **A confirmation is attributed and dated**, and rendered as the user's
 *      claim rather than as launchpad's finding. "You confirmed this in March"
 *      is a different sentence from "this is verified", and only one of them is
 *      true.
 *
 * Stored in the repo, like everything else launchpad records: it travels with
 * the code, it is reviewable in a diff, and a teammate can see what was
 * asserted and by whom.
 */

export interface Confirmation {
  /** ISO date. Shown, so an answer from two years ago looks like one. */
  at: string;
  /** Optional: where the keystore actually is, so the answer is worth something later. */
  note?: string;
}

export type Confirmations = Record<string, Confirmation>;

const REL = join('.launchpad', 'confirmed.yml');

const HEADER = `# Answers to the questions launchpad cannot answer by reading this repo.
# Written by \`launchpad confirm <check>\`, and safe to edit or delete by hand.
# Only checks graded "?" can appear here — a real gap cannot be confirmed away.
`;

export function readConfirmations(repo: string): Confirmations {
  const p = join(repo, REL);
  if (!existsSync(p)) return {};
  try {
    const raw = parse(readFileSync(p, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Confirmations = {};
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      // Tolerant of a hand-edited file: `keystore-backup: true` is an obvious
      // thing for someone to write, and refusing it would be pedantry.
      if (v === true) { out[id] = { at: 'unknown' }; continue; }
      if (v && typeof v === 'object') {
        const o = v as { at?: unknown; note?: unknown };
        out[id] = {
          at: typeof o.at === 'string' ? o.at : 'unknown',
          ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
        };
      }
    }
    return out;
  } catch {
    // A corrupt file must not break the scorecard — it degrades to "unanswered".
    return {};
  }
}

export function writeConfirmations(repo: string, c: Confirmations): void {
  mkdirSync(join(repo, '.launchpad'), { recursive: true });
  writeFileSync(join(repo, REL), HEADER + (Object.keys(c).length ? stringify(c) : ''), 'utf8');
}

export function confirm(repo: string, id: string, note?: string, now = new Date()): Confirmations {
  const c = readConfirmations(repo);
  c[id] = { at: now.toISOString().slice(0, 10), ...(note ? { note } : {}) };
  writeConfirmations(repo, c);
  return c;
}

export function unconfirm(repo: string, id: string): Confirmations {
  const c = readConfirmations(repo);
  delete c[id];
  writeConfirmations(repo, c);
  return c;
}
