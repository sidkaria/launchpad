/**
 * Making a diagnostic bundle safe to paste into a public issue.
 *
 * The support economics of a low one-time price depend on one paste replacing
 * ten questions — but the same paste is the single most dangerous thing this
 * product asks a customer to produce. They are sitting on an App Store Connect
 * key, a keystore that cannot be replaced, and a Cloudflare token with DNS
 * edit, and they will paste whatever we print into a GitHub issue without
 * reading it. A report that leaks one of those is worse than no report at all,
 * because the leak is public, permanent and ours.
 *
 * So there are two layers, and the order matters:
 *
 *   1. **Collect almost nothing.** `report.ts` reads an allowlist of facts. It
 *      never opens `.env`, never reads a vault VALUE, never lists changed
 *      filenames. Most secrets are safe because nothing ever went looking for
 *      them.
 *   2. **Scrub what is left.** This file. Everything collected goes through it
 *      on the way out, including the JSON block, because layer 1 is a policy
 *      and policies are edited by people in a hurry.
 *
 * Layer 2 alone would be a sieve — a redactor that has to recognise every
 * possible secret loses to the first one it has not seen. Layer 1 alone would
 * be fine until someone adds a field. Together, a leak needs two mistakes.
 */

/** What replaces anything recognised. Distinctive, so a test can spot it. */
export const MASK = '[redacted]';

/**
 * Key names whose VALUE is never printed, whatever it looks like.
 *
 * Name-based, because a secret's value is often unremarkable — a keystore
 * password can be `hunter2`, which no pattern will ever catch. If the field is
 * called a password, the value goes, and it does not matter what it is.
 */
const SECRET_NAME = /(secret|token|password|passphrase|api[-_ ]?key|private[-_ ]?key|credential|auth|keystore|p12|p8|\bkey\b|cert|signing|sa_json|client[-_ ]?id)/i;

/**
 * Split an identifier into words before matching a name against it.
 *
 * Without this, `\bkey\b` misses `ascKeyId` — there is no word boundary inside
 * camelCase — and a field whose name says "key" sails straight through. That
 * was a real leak caught by the adversarial suite, not a hypothetical: every
 * config field in this codebase is camelCase.
 */
const words = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');

/**
 * `NAME=value` and `NAME: value`, where the name says the value is a secret.
 *
 * This is the shape a secret takes in **free text** — a log line, an env dump,
 * a version banner — where no value pattern can help, because a passphrase like
 * `correct-horse-battery-staple` is indistinguishable from prose. The name is
 * the only signal, and in free text it is right there next to the value.
 *
 * Applied only to free text, never to the finished document, so the JSON block
 * stays parseable.
 */
const ASSIGNMENT =
  /\b([A-Za-z_][A-Za-z0-9_.-]*(?:secret|token|password|passphrase|key|credential|auth)[A-Za-z0-9_.-]*)(\s*[=:]\s*)(\S+)/gi;

/**
 * Value shapes that are secret wherever they appear, under any name.
 *
 * Deliberately not exhaustive — that is unachievable, which is why layer 1
 * exists — but every one of these is a shape that has actually leaked out of
 * somebody's diagnostic paste.
 */
const SECRET_VALUE: Array<[RegExp, string]> = [
  // PEM/OpenSSH blocks, including the Apple `.p8`. Greedy to the end marker,
  // and also matched headerless below via the long-base64 rule.
  [/-----BEGIN[\s\S]*?-----END[^-]*-----/g, MASK],
  [/-----BEGIN [A-Z ]+-----/g, MASK],
  // Provider-prefixed tokens: GitHub, Slack, Stripe, OpenAI, Google, AWS,
  // Polar, npm. The prefix is the tell, so the length does not matter.
  [/\b(gh[pousr]_|github_pat_|xox[baprs]-|sk-|pk_(live|test)_|rk_(live|test)_|AIza|ya29\.|polar_oat_|npm_)[A-Za-z0-9_\-.]{6,}/g, MASK],
  [/\bAKIA[0-9A-Z]{8,}/g, MASK],
  // JWTs — three base64url segments. Often an access token in disguise.
  [/\beyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g, MASK],
  // Credentials inside a URL: `https://user:token@host/…`. The single most
  // common way a git remote leaks a PAT.
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+(?::[^/\s@]*)?@/g, `$1${MASK}@`],
  // A long unbroken base64/hex run. This is what catches a base64 keystore, a
  // headerless PEM body and an anonymous 64-char hex token. Long enough not to
  // eat ordinary words, a commit sha, or a uuid.
  [/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, MASK],
  [/\b[0-9a-fA-F]{48,}\b/g, MASK],
];

/**
 * Replace the user's home directory with `~`, in every spelling.
 *
 * A home path carries their name, which is personal data in its own right and
 * is also how a "generic" bug report turns out to identify a person. Handles
 * the plain path, the URL-ish forward-slash form a Windows path acquires when
 * it passes through JSON, and the doubled backslashes JSON gives it.
 */
export function tildeHome(text: string, home: string): string {
  if (!home) return text;
  const forms = [home, home.replace(/\\/g, '/'), home.replace(/\\/g, '\\\\'), home.replace(/\/+$/, '')];
  let out = text;
  for (const form of [...new Set(forms)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    out = out.split(form).join('~');
  }
  return out;
}

/**
 * Scrub text: the home directory FIRST, then every value shape.
 *
 * The order is load-bearing and was got wrong once. A temporary or container
 * home directory can contain a long random run that the base64 rule eats — and
 * once part of the path has become `[redacted]`, the home substitution no
 * longer matches, so the REST of the path survives with the username in it.
 * Replacing the known-safe prefix first cannot lose anything, because `~` is
 * shorter than what it replaces and matches nothing afterwards.
 */
export function redact(text: string, home = ''): string {
  let out = tildeHome(text, home);
  for (const [pattern, replacement] of SECRET_VALUE) out = out.replace(pattern, replacement);
  return out;
}

/**
 * Scrub free text — a log line, a version banner, anything unstructured.
 *
 * Adds the `NAME=value` rule on top of `redact`, because free text is where a
 * secret appears next to its own name and where no value pattern can save us.
 */
export function redactFreeText(text: string, home = ''): string {
  return redact(text, home).replace(ASSIGNMENT, `$1$2${MASK}`);
}

/** Is this key name one whose value must never be printed? */
export const isSecretName = (name: string): boolean => SECRET_NAME.test(words(name));

/**
 * Scrub a parsed structure — `state.yml`, most importantly.
 *
 * Both halves are needed. A field called `keystorePassword` is dropped on its
 * NAME, because its value may be an ordinary word no pattern can catch; every
 * surviving string is then scrubbed on its VALUE, because the file is on
 * somebody else's disk and may have been hand-edited to hold anything at all.
 *
 * Keys are redacted too, not just values: a map keyed by app slug or by secret
 * name can carry as much as the values do.
 */
export function redactTree(value: unknown, home = '', depth = 0): unknown {
  // A hand-edited or hostile state file must not be able to hang the report.
  if (depth > 12) return MASK;
  if (value == null) return value;
  if (typeof value === 'string') return redactFreeText(value, home);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(v => redactTree(v, home, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[redact(k, home)] = isSecretName(k) ? MASK : redactTree(v, home, depth + 1);
    }
    return out;
  }
  // A function, a symbol, a bigint — nothing we put in, so nothing we print.
  return MASK;
}

/**
 * A path, shortened to something that cannot identify anybody.
 *
 * `~` handles everything under the user's home, which is where a customer's
 * install and projects actually live. What is left is the case this was added
 * for: a path OUTSIDE the home directory still carries whatever names are in
 * it — `/Users/someone/...` under a redirected `HOME`, a shared build agent, a
 * checkout under `/opt`. Those keep only their last two segments, which is all
 * the diagnostic value the field ever had ("it is running from
 * `plugins/launchpad`"); *which* copy is already answered by version and
 * channel.
 */
export function shortenPath(path: string, home = ''): string {
  const t = tildeHome(path, home);
  if (t.startsWith('~') || !/^(\/|[A-Za-z]:[\\/])/.test(t)) return t;
  const parts = t.split(/[\\/]/).filter(Boolean);
  return parts.length <= 2 ? `…/${parts.join('/')}` : `…/${parts.slice(-2).join('/')}`;
}

/**
 * A git remote, reduced to the host.
 *
 * Only the host is diagnostic — "are you on GitHub or somewhere else" — and
 * everything after it is the customer's org, their repo name, and sometimes a
 * token. A private repository's name can itself be the unreleased product, so
 * this keeps none of it.
 */
export function remoteHost(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) return 'none';
  // scp-style: `git@github.com:owner/repo.git`
  const scp = /^[^/@\s]+@([^:/\s]+):/.exec(trimmed);
  if (scp) return scp[1];
  try {
    return new URL(trimmed).hostname || 'unknown';
  } catch {
    // A path, a relative remote, something unparseable. Naming it would risk
    // printing a directory; saying so costs nothing.
    return /^[./]/.test(trimmed) ? 'local path' : 'unknown';
  }
}

/**
 * The last four characters of a licence key, and never more.
 *
 * Enough for a human to match against the one in the purchase email; useless to
 * anyone who finds it in an issue. The key itself is never printed, and neither
 * is its length — a length is a hint about the key space and buys the reader
 * nothing at all.
 */
export const keyTail = (key: string | undefined): string =>
  key && key.length ? `…${key.slice(-4)}` : 'none';
