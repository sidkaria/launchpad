import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';

export interface GeneratedFile { path: string; contents: string; }

/** What a guarded write actually did. */
export interface WriteResult {
  /** Files launchpad wrote (new, or regenerating its own previous output). */
  written: GeneratedFile[];
  /** Repo-relative paths left untouched because they are NOT launchpad-generated. */
  preserved: string[];
  /**
   * Files launchpad generated, that the USER has since edited, and that were
   * therefore left alone.
   *
   * This category exists because of a real loss. A shipped app's release-notes
   * step was broken — `actions/checkout` does not fetch tags, so notes silently
   * became commit messages — and the owner fixed it by hand in the generated
   * workflow. That fix was one `apply` away from being reverted without a word,
   * and the symptom (plausible-looking notes) is invisible until a customer
   * reads them.
   *
   * "Never overwrite a file you did not generate" was already the rule. This is
   * its other half: never silently discard an edit to a file you did.
   */
  edited: string[];
  /**
   * Files that carry launchpad's own name or marker but **no stamp**, and whose
   * bytes are not the ones this version renders. They were written by a
   * launchpad old enough to predate stamping — or by one whose template has
   * since changed — and nothing on disk distinguishes "an older template,
   * untouched" from "an older template, fixed by hand in the field".
   *
   * Guessing picks one of two losses: rewrite and a field fix disappears
   * silently (the loss `edited` exists to prevent), or freeze and the customer
   * never receives a template fix. So launchpad does neither silently — it
   * keeps the bytes and says exactly how to opt back in.
   */
  unverified: string[];
}

/**
 * A stamp identifying launchpad's own output, and the exact bytes it wrote.
 *
 * The hash is of the generated body alone, so the next run can tell its own
 * untouched output (rewrite freely) from output somebody has since changed
 * (leave it, and say so). Without it the two are indistinguishable and the
 * only safe behaviours are "always clobber" or "never update" — one loses the
 * user's work, the other freezes every customer on the template they installed.
 */
const STAMP = /launchpad:generated\s+([0-9a-f]{16})/;

const digest = (contents: string): string =>
  createHash('sha256').update(contents).digest('hex').slice(0, 16);

/**
 * Files with no extension whose comment leader we nonetheless know.
 *
 * The stamp was chosen purely by file EXTENSION, and `fastlane/Fastfile` has
 * none. So every Fastfile launchpad wrote went out unstamped, `userEdited()`
 * answered "cannot tell", and a lane somebody had fixed by hand was rewritten on
 * the next `apply` — reported as "wrote", never as "you edited this, I kept it".
 * Same class of loss as FINDINGS F-05, one layer down, in the generated file a
 * shipping app's owner is MOST likely to hand-tune.
 *
 * Found twice on 2026-09-21, independently: by auditing every write site in
 * `src/`, and by proving the apply → setup → apply fixed point. This list is the
 * union of both fixes. All of these are `#`-commented.
 */
const HASH_COMMENT_BASENAMES = new Set([
  'Fastfile', 'Appfile', 'Matchfile', 'Deliverfile', 'Snapfile', 'Scanfile', 'Gymfile',
  'Pluginfile', 'Gemfile', 'Podfile', 'Rakefile', 'Brewfile', 'Dockerfile', 'Makefile',
]);

/** The comment leader this file type uses, so the stamp does not break the syntax. */
function stampLine(relPath: string, hash: string): string | null {
  const text = `launchpad:generated ${hash} — edits here are preserved, but re-running \`apply\` will tell you they exist`;
  if (/\.(ya?ml|sh|bash|zsh|rb|toml|conf|properties|gradle)$/.test(relPath)) return `# ${text}`;
  if (HASH_COMMENT_BASENAMES.has(basename(relPath))) return `# ${text}`;
  if (/\.(swift|kt|kts|ts|js|mjs|cjs|dart|java|c|cc|cpp|h|m)$/.test(relPath)) return `// ${text}`;
  // Anything else (plist, xml, html, json) has no safe universal comment form,
  // and a stamp that corrupts the file would be far worse than none.
  return null;
}

/**
 * Can this file type carry a stamp at all?
 *
 * A plist or an HTML page never can, so it is permanently unjudgeable and the
 * pre-stamp rules below must not apply to it — freezing it would be forever,
 * not a migration.
 */
const stampable = (relPath: string): boolean => stampLine(relPath, '0'.repeat(16)) !== null;

/** Insert the stamp after a shebang, which must stay on line one. */
function withStamp(relPath: string, contents: string): string {
  const line = stampLine(relPath, digest(contents));
  if (!line) return contents;
  if (contents.startsWith('#!')) {
    const nl = contents.indexOf('\n');
    return nl === -1 ? `${contents}\n${line}\n` : `${contents.slice(0, nl + 1)}${line}\n${contents.slice(nl + 1)}`;
  }
  return `${line}\n${contents}`;
}

/** The file as launchpad wrote it, minus the stamp — what the hash covers. */
const withoutStamp = (contents: string): string =>
  contents.split('\n').filter(l => !STAMP.test(l)).join('\n');

/**
 * Has the user changed launchpad's own output since it was written?
 *
 * `null` means "cannot tell" — an older file with no stamp. Those are still
 * updated, because freezing every pre-stamp customer on their installed
 * template would be worse, but the update is reported rather than silent.
 */
export function userEdited(contents: string): boolean | null {
  const stamped = STAMP.exec(contents);
  if (!stamped) return null;
  return digest(withoutStamp(contents)) !== stamped[1];
}

/**
 * Does this file belong to launchpad? Generated templates carry a `launchpad`
 * marker in their header comment, and generated workflows are named
 * `launchpad-*.yml`. Anything else is the user's own file — an adopted
 * pipeline (e.g. a hand-written `fastlane/Fastfile` that a `./deploy` script
 * already depends on) — and must never be silently overwritten.
 */
export function isLaunchpadGenerated(relPath: string, contents: string): boolean {
  if (basename(relPath).startsWith('launchpad-')) return true;
  return contents.split('\n', 4).some((l) => l.toLowerCase().includes('launchpad'));
}

/**
 * Write generated files, skipping any that already exist and are not
 * launchpad's own output. launchpad never deletes or clobbers a user's files
 * (same principle as the consolidation warning for clashing workflows and the
 * themed-`index.html` guard) — a real pipeline being adopted must be migrated
 * explicitly, not destroyed by an `apply`.
 */
export function writeGuarded(repo: string, files: GeneratedFile[]): WriteResult {
  const written: GeneratedFile[] = [];
  const preserved: string[] = [];
  const edited: string[] = [];
  const unverified: string[] = [];
  for (const f of files) {
    const abs = join(repo, f.path);
    if (existsSync(abs)) {
      const current = readFileSync(abs, 'utf8');
      // Somebody else's file. Never ours to touch.
      if (!isLaunchpadGenerated(f.path, current)) {
        preserved.push(f.path);
        continue;
      }
      // Ours, but changed since we wrote it. Their change wins, and it gets said
      // out loud — a fix made in the field is worth more than this template.
      const judged = userEdited(current);
      if (judged === true) {
        edited.push(f.path);
        continue;
      }
      const same = withoutStamp(current) === f.contents;
      if (judged === null && stampable(f.path)) {
        // Ours by name or marker, but from before stamping — unjudgeable.
        //
        // Byte-identical to what this version renders: it is provably our own
        // untouched output, so ADOPT it by writing the same bytes plus a stamp.
        // From the next run on it can be judged, which is what lets a later
        // template fix reach this repo at all. (Falls through to the write.)
        //
        // Different: it could be an older template or a fix made in the field,
        // and nothing here can tell. Keep the bytes and report it.
        if (!same) {
          unverified.push(f.path);
          continue;
        }
      } else if (same) {
        // Ours and current: nothing to say unless the content actually moves.
        continue;
      }
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, withStamp(f.path, f.contents), 'utf8');
    written.push(f);
  }
  return { written, preserved, edited, unverified };
}
