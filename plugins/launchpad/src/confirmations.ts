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
 *
 * ## The second use: answers to things that are not scorecard rows
 *
 * `src/needs.ts` asks a handful of questions the scorecard does not own — a
 * monthly bill to accept or decline, an irreversible act to acknowledge before
 * it happens, a store's fee and its calendar gate. They are the same *kind* of
 * fact as a keystore backup: launchpad cannot read the answer off disk, and
 * once a person has answered it must stop asking. So they live here, under
 * their own namespaced ids (`money:…`, `irreversible:…`, `gate:…`), rather than
 * in a second store with a second format and a second way to go stale.
 *
 * Two things had to be added for that, and only two:
 *
 *   - **`choice`**, because "I will pay for that" and "no, keep it free" are
 *     both answers and only one of them is a yes. A scorecard confirmation has
 *     no such axis — the only answer to "is the keystore backed up" is yes.
 *   - **the id namespace**, which is nothing but a naming convention: a
 *     scorecard id is a bare word (`keystore-backup`), so a colon cannot
 *     collide with one, and `scorecard()` looks up only ids it already knows.
 *
 * The safety rules above are unchanged and still apply to the scorecard rows.
 * Nothing recorded here can turn a `gap` green, because the scorecard never
 * reads these ids at all.
 */

export interface Confirmation {
  /** ISO date. Shown, so an answer from two years ago looks like one. */
  at: string;
  /** Optional: where the keystore actually is, so the answer is worth something later. */
  note?: string;
  /**
   * Which way it was answered, for the questions that have more than one yes.
   *
   * Absent on a scorecard confirmation, where the only possible answer is "yes,
   * this is handled". Present on a money decision (`accept` / `decline`) and on
   * an acknowledgement (`acknowledged`), so the Decisions tab can say what was
   * decided rather than only that something was.
   */
  choice?: string;
}

export type Confirmations = Record<string, Confirmation>;

const REL = join('.launchpad', 'confirmed.yml');

const HEADER = `# Answers to the questions launchpad cannot answer by reading this repo.
# Written by \`launchpad confirm <check>\`, and safe to edit or delete by hand.
# Only checks graded "?" can appear here — a real gap cannot be confirmed away.
# Ids with a colon (money:, irreversible:, gate:, keep:) are answers to the
# "needs you" list rather than to a scorecard row; deleting one asks again.
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
        const o = v as { at?: unknown; note?: unknown; choice?: unknown };
        out[id] = {
          at: typeof o.at === 'string' ? o.at : 'unknown',
          ...(typeof o.note === 'string' && o.note ? { note: o.note } : {}),
          ...(typeof o.choice === 'string' && o.choice ? { choice: o.choice } : {}),
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
export function record(
  repo: string, id: string, choice: string, note?: string, now = new Date(),
): Confirmations {
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
export function recordedAnswers(repo: string): { id: string; at: string; choice?: string; note?: string }[] {
  return Object.entries(readConfirmations(repo))
    .filter(([id]) => id.includes(':'))
    .map(([id, c]) => ({ id, at: c.at, ...(c.choice ? { choice: c.choice } : {}), ...(c.note ? { note: c.note } : {}) }))
    .sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id));
}
