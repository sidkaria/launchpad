import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import { join } from 'node:path';
import { providerById, providerForRecord, selectProvider } from './providers/index.js';
/**
 * Licensing — validate-only against whichever provider this build is pointed
 * at: the same pattern the paywall this product generates for its customers
 * already uses.
 *
 * **Who we ask lives behind `LicenseProvider`** (`src/providers/`), because
 * Lemon Squeezy is being absorbed into Stripe Managed Payments and is
 * simultaneously our licensing rail and a payment rail we recommend. Everything
 * in this file is about what we DO with the answer, and is the same whoever
 * gives it.
 *
 * **What this is honestly for.** launchpad runs `xcodebuild`, `git` and `gh` on
 * the buyer's own machine, and its source ships with it — this very file, as
 * `src/license.ts`, beside the `dist/license.js` that actually runs. Anyone who
 * opens either can delete the check in about a minute. That is not a flaw to be
 * engineered around; it is the shape of the product, and pretending otherwise
 * would mean spending real effort on obfuscation that buys nothing. So this
 * exists to make casual copying mildly inconvenient, to give honest people a
 * way to be honest, and to tell someone running a shared copy where it came
 * from. It is a receipt, not a lock.
 *
 * Three rules follow from that, and they all point the same way — **never
 * punish a paying customer for a problem that is ours**:
 *
 *   1. A stored key means it validated at least once, so entitlement is granted
 *      immediately at startup and re-checked in the background. Nobody waits on
 *      a network round trip to run a build.
 *   2. Any failure to REACH the provider changes nothing. An aeroplane, a
 *      firewall, a Cloudflare incident and an expired card must not look the
 *      same. Only a positive rejection revokes — and a build pointed at a rail
 *      that never issued this key counts as *unreachable*, not as a rejection,
 *      which is what makes changing provider safe for existing customers.
 *   3. There is no expiry. This is a one-time purchase, so entitlement does not
 *      decay with time — not after fourteen days, not after a year offline.
 *
 * Rule 3 was learned the hard way. Entitlement used to decay `licensed` →
 * `grace` → `lapsed` on a timer, and the only thing that ever reset it was a
 * command nobody had been told to run. Every buyer who kept the product a
 * fortnight was refused and shown the checkout URL again — a one-time purchase
 * behaving like a subscription in disguise, which is indistinguishable from a
 * scam and would have earned a refund from every honest customer.
 */
/**
 * After this long without a successful re-check, say so — and only say so.
 * It is a note in `license` output, never a loss of entitlement.
 */
export const STALE_AFTER_DAYS = 14;
/**
 * How long a successful check is trusted before a licensed verb quietly tries
 * again. Under a day, so a revocation is noticed within one, and never on two
 * commands in a row.
 */
export const RECHECK_AFTER_HOURS = 20;
/**
 * The longest a licensed verb will wait on the provider before getting on with
 * the job. Short: the answer is never needed to decide entitlement, only to
 * refresh it, so a slow network must cost a customer nothing but this.
 */
export const RECHECK_TIMEOUT_MS = 2_000;
/**
 * Verbs that need a licence: the ones that DO the work.
 *
 * Everything that only tells you the truth about your own repo stays free —
 * `score`, `doctor`, `status`, the dashboard. That is deliberate rather than
 * generous. The scorecard is the argument for buying; a shared copy that still
 * names the fifteen things converts far better than a hard wall, and locking
 * someone out of reading their own project would be a bad trade for a one-time
 * product whose support has to stay near zero. (The price itself is `PRICE` in
 * `product.ts`; it is not repeated here, because it changes.)
 */
export const LICENSED_VERBS = ['apply', 'secrets', 'release', 'domains'];
export const licensePath = (home = homedir()) => join(home, '.launchpad', 'license.json');
/**
 * Stored in plain JSON rather than the credential vault, deliberately.
 *
 * The vault refuses to operate on Windows and headless Linux without
 * `LAUNCHPAD_VAULT_PASSPHRASE`, and demanding a passphrase before someone can
 * run `launchpad apply` — to protect a key that is their own receipt and
 * protects nothing of theirs — would be a self-inflicted support burden.
 */
export function readLicense(home = homedir()) {
    const p = licensePath(home);
    if (!existsSync(p))
        return null;
    try {
        const raw = JSON.parse(readFileSync(p, 'utf8'));
        if (typeof raw.key !== 'string' || !raw.key.trim())
            return null;
        return {
            key: raw.key,
            instanceId: typeof raw.instanceId === 'string' ? raw.instanceId : undefined,
            provider: typeof raw.provider === 'string' ? raw.provider : undefined,
            validatedAt: typeof raw.validatedAt === 'string' ? raw.validatedAt : new Date(0).toISOString(),
            checkedAt: typeof raw.checkedAt === 'string' ? raw.checkedAt : undefined,
            lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
        };
    }
    catch {
        return null;
    }
}
export function writeLicense(rec, home = homedir()) {
    const p = licensePath(home);
    mkdirSync(join(home, '.launchpad'), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(rec, null, 2) + '\n', 'utf8');
    renameSync(tmp, p);
}
export function clearLicense(home = homedir()) {
    try {
        writeFileSync(licensePath(home), '{}\n', 'utf8');
    }
    catch { /* nothing to clear */ }
}
/**
 * Entitlement from what we already know. Pure — no network, no clock of its
 * own — so the decision that gates every command is trivially testable.
 *
 * **Time cannot take entitlement away.** A stored key means the API said yes at
 * least once, and nothing short of the API saying no reverses that. Age only
 * changes what the record is CALLED, so `license` can mention a long silence
 * without anything being withheld on the strength of it.
 *
 * Every degenerate clock therefore has to fail open, and does: a rolled-back
 * clock puts `validatedAt` in the future (negative age), a hand-edited file may
 * carry a date that does not parse (`NaN`), and neither can be distinguished
 * from an honest customer with a wrong clock. Both stay `licensed`.
 */
export function entitlement(rec, now, staleAfterDays = STALE_AFTER_DAYS) {
    if (!rec)
        return { state: 'unlicensed' };
    if (rec.lastError === 'revoked') {
        const who = rec.provider ? providerLabel(rec.provider) : 'The licence provider';
        return { state: 'lapsed', why: `${who} reports this key as no longer valid.` };
    }
    const days = (now.getTime() - new Date(rec.validatedAt).getTime()) / 86_400_000;
    // Negated rather than `days <= staleAfterDays`, so NaN lands here too.
    if (!(days > staleAfterDays))
        return { state: 'licensed', since: rec.validatedAt };
    return {
        state: 'stale',
        offlineDays: Math.floor(days),
        why: rec.lastError ?? 'not re-checked recently',
    };
}
/**
 * Entitlement as the one word a person reads — in `license`, in `report`,
 * wherever it is said.
 *
 * `stale` is an internal name for "validated once, not re-checked lately", and
 * it is fully licensed. It used to be printed as `stale` by `license` (which
 * reads like a fault) and as `grace` by `report` (which is the name of the
 * decaying state rule 3 above abolished — a word that promises an expiry this
 * product does not have). One key, two words, both wrong. It is `licensed`,
 * and the line under it says when it was last confirmed.
 */
export function licenceWord(state) {
    return state === 'stale' ? 'licensed' : state;
}
/**
 * Entitled to run the licensed verbs?
 *
 * `stale` counts, unconditionally and forever. The only false here is a key the
 * API rejected, or no key at all.
 */
export const isEntitled = (e) => e.state === 'licensed' || e.state === 'stale';
/** What to call a provider in a message, without pretending to know an unknown one. */
export function providerLabel(id) {
    return providerById(id)?.label ?? id;
}
/**
 * Bind this key to this machine.
 *
 * The activation limit on the product is what makes sharing inconvenient — one
 * key, N machines, and the N+1th is told so plainly. That message is the entire
 * anti-sharing mechanism, and it is enough for a product at this price.
 *
 * A rail with no notion of seats is handled rather than refused: validate the
 * key and store it, which is weaker anti-sharing and says so instead of
 * pretending a seat was taken.
 */
export async function activate(key, fetcher, now = new Date(), instanceName = hostname(), provider = selectProvider(key)) {
    const trimmed = key.trim();
    if (!trimmed)
        return { ok: false, message: 'A licence key is required.' };
    const stored = (instanceId) => ({
        key: trimmed,
        instanceId,
        provider: provider.id,
        validatedAt: now.toISOString(),
        checkedAt: now.toISOString(),
    });
    if (!provider.activate) {
        const v = await provider.validate(trimmed, undefined, fetcher);
        if (v.status === 'valid') {
            return { ok: true, message: `Stored. (${provider.label} does not bind keys to machines.)`, record: stored(v.instanceId) };
        }
        return v.status === 'invalid'
            ? { ok: false, message: v.why }
            // Cannot reach the provider. Refusing to store the key would strand
            // someone who just paid and happens to be offline, so this is reported
            // and retried rather than treated as a bad key.
            : { ok: false, message: unreachableMessage(provider.label, v.why) };
    }
    const r = await provider.activate(trimmed, instanceName, fetcher);
    if (r.status === 'unreachable')
        return { ok: false, message: unreachableMessage(provider.label, r.why) };
    if (r.status === 'refused')
        return { ok: false, message: r.why };
    return { ok: true, message: `Activated on ${instanceName}.`, record: stored(r.instanceId) };
}
/**
 * Why a licence server did not answer, in words rather than in Node.
 *
 * The raw reasons are a runtime's: `fetch failed`, `This operation was
 * aborted`, `Unexpected token '<', "<html><bod"... is not valid JSON`. A buyer
 * activating a key they just paid for read the last one verbatim during a
 * provider outage. What they need is which of three things happened — no
 * network, no answer in time, or an answer that was not the licence server's —
 * because each has a different next step.
 */
export function humanReason(why) {
    if (/aborted|abort|timed? ?out|timeout/i.test(why))
        return 'no answer in time';
    if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|socket|network/i.test(why)) {
        return 'no connection';
    }
    if (/JSON|Unexpected token|unrecognised response/i.test(why)) {
        return 'what answered was not the licence server (usually a captive portal or a proxy)';
    }
    const http = /HTTP (\d{3})/.exec(why);
    if (http) {
        const code = Number(http[1]);
        if (code === 429)
            return 'it is rate-limiting requests right now';
        if (code >= 500)
            return `it is having an outage (HTTP ${code})`;
        return `HTTP ${code}`;
    }
    return why;
}
/** The one sentence for "we could not ask", so activate and deactivate say it the same way. */
export function unreachableMessage(label, why) {
    return `Could not reach ${label} — ${humanReason(why)}. Nothing was used up and nothing changed; `
        + 'try again in a minute.';
}
/**
 * Re-check a stored key.
 *
 * Returns the record to persist. A failure to reach anyone updates `checkedAt`
 * and leaves `validatedAt` alone — the record is unchanged in every way that
 * affects entitlement. Only a positive rejection sets `lastError: 'revoked'`,
 * and only that revokes.
 *
 * The rail asked is the one recorded on the key, **not** whichever this build
 * defaults to. Without that, shipping a build with a different default would
 * hand every existing customer's key to a provider that has never seen it and
 * collect a confident rejection — a mass cancellation caused entirely by a
 * constant changing.
 */
export async function revalidate(rec, fetcher, now = new Date(), signal, provider = providerForRecord(rec)) {
    /** Reached nobody who can answer the question. Nothing about the key changes. */
    const unreachable = (why) => ({
        record: { ...rec, checkedAt: now.toISOString(), lastError: `offline: ${why}` },
        reachable: false,
    });
    if (!provider) {
        return unreachable(`this build cannot talk to ${rec.provider ?? 'that provider'}`);
    }
    const v = await provider.validate(rec.key, rec.instanceId, fetcher, signal);
    if (v.status === 'unreachable')
        return unreachable(v.why);
    if (v.status === 'valid') {
        return {
            record: {
                ...rec,
                provider: rec.provider ?? provider.id,
                validatedAt: now.toISOString(),
                checkedAt: now.toISOString(),
                lastError: undefined,
            },
            reachable: true,
        };
    }
    return {
        record: { ...rec, checkedAt: now.toISOString(), lastError: 'revoked' },
        reachable: true,
    };
}
/**
 * Keep a stored key fresh, on the way past.
 *
 * Called by the gate before every licensed verb, and this is the piece that was
 * missing: `revalidate` had exactly one caller — the `license` command — so a
 * key was only ever re-checked by someone who already suspected a problem and
 * knew the command to run. Nobody does both.
 *
 * Three properties make it safe to put on the hot path of a build command:
 *
 *   - **Throttled.** A successful check is trusted for `RECHECK_AFTER_HOURS`,
 *     so this is a no-op on all but the first command of the day. `checkedAt`
 *     moves on every attempt, reachable or not, so an offline machine tries
 *     once a day rather than once a command.
 *   - **Bounded.** `RECHECK_TIMEOUT_MS`, enforced by aborting the request
 *     rather than abandoning it — an abandoned socket keeps the process alive
 *     after the command has finished, which looks exactly like a hang.
 *   - **Silent, and non-fatal in every direction.** No output, no throw, no
 *     exit code. A read-only home, a corrupt file, a hostile proxy: all of it
 *     ends with the caller's entitlement exactly as it found it.
 *
 * A revoked key is re-checked too. That can only ever restore entitlement —
 * somebody whose card failed and who fixed it should not have to know that a
 * command exists.
 */
export async function refreshIfStale(home = homedir(), fetcher = realFetcher, now = new Date(), opts = {}) {
    const rec = readLicense(home);
    if (!rec)
        return null;
    try {
        const since = rec.checkedAt ? now.getTime() - new Date(rec.checkedAt).getTime() : Infinity;
        const wait = (opts.afterHours ?? RECHECK_AFTER_HOURS) * 3_600_000;
        // `since < 0` is a clock that moved backwards. Treated as fresh: the cost is
        // one skipped check, and the alternative is hammering the API every command.
        if (!Number.isNaN(since) && since < wait)
            return rec;
        const ac = new AbortController();
        /**
         * Deliberately NOT `unref`'d, and this is load-bearing.
         *
         * An unref'd timer does not hold the event loop open, so if the request
         * hangs with nothing else pending — exactly what a black-holed connection
         * looks like — the loop empties, the abort never fires, and node exits 13
         * on an unsettled top-level await *before the command runs at all*. A
         * silent no-op `apply` is far worse than a two-second wait. `clearTimeout`
         * in the `finally` is what stops it outliving the refresh.
         */
        const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? RECHECK_TIMEOUT_MS);
        try {
            const provider = opts.provider !== undefined ? opts.provider : providerForRecord(rec);
            const { record } = await revalidate(rec, fetcher, now, ac.signal, provider);
            writeLicense(record, home);
            return record;
        }
        finally {
            clearTimeout(timer);
        }
    }
    catch {
        // Whatever went wrong, it is not the customer's problem and not worth a
        // line of output on a command that was about to do something else.
        return rec;
    }
}
export async function deactivate(rec, fetcher, provider = providerForRecord(rec)) {
    if (!rec.instanceId)
        return { ok: false, message: 'No activation on this machine to release.' };
    if (!provider?.deactivate) {
        return { ok: false, message: `${provider?.label ?? 'This provider'} does not bind keys to machines, so there is no seat to release.` };
    }
    const r = await provider.deactivate(rec.key, rec.instanceId, fetcher);
    if (r.status === 'released')
        return { ok: true, message: 'Released this machine. The seat is free for another.' };
    return r.status === 'refused'
        ? { ok: false, message: r.why }
        : { ok: false, message: unreachableMessage(provider.label, r.why) };
}
/** Node's global fetch, adapted. Kept separate so every test injects its own. */
export const realFetcher = async (url, init) => {
    const res = await fetch(url, init);
    return { ok: res.ok, status: res.status, json: () => res.json() };
};
/**
 * What to print when a run without entitlement hits a licensed verb.
 *
 * Two audiences, and they need opposite things. Someone who never bought should
 * see the free tier and the checkout. Someone whose key was *rejected* has
 * already paid, and showing them a buy link is the single most insulting thing
 * this program can do — that path goes to a human instead.
 *
 * Written in slash commands rather than `launchpad …` on purpose: there is no
 * `launchpad` on anybody's PATH. It is a Claude Code plugin, and an instruction
 * a customer cannot type is worse than no instruction.
 */
export function refusal(verb, e, checkoutUrl, supportUrl, providerName = 'The licence provider', price) {
    if (e.state === 'lapsed') {
        /**
         * No checkout link here, deliberately (and a test holds it): someone whose
         * key is rejected has usually paid.
         *
         * The blank lines are kept on purpose: this used to `filter` every empty
         * string out to drop an absent support URL, and took the paragraph breaks
         * with it, so the most stressful message in the product was one wall.
         */
        return [
            `launchpad: ${providerName} is rejecting this licence key, so \`${verb}\` cannot run.`,
            `  ${e.why}`,
            '',
            '  If you bought this, that is a mistake on our side or a payment that needs',
            '  attention — not something you should have to debug.',
            ...(supportUrl ? [`  Tell us and it gets fixed: ${supportUrl}`] : []),
            '',
            '  Everything that reads your own projects keeps working regardless:',
            '    /launchpad:status      the readiness scorecard',
            '    /launchpad:doctor      which credentials are missing',
            '    /launchpad:dashboard   all of it, on one screen',
        ].join('\n');
    }
    return [
        `launchpad: \`${verb}\` needs a licence.`,
        '',
        '  Everything that tells you the truth about your projects stays free:',
        '    /launchpad:status      what is between this app and a product',
        '    /launchpad:doctor      which credentials are missing',
        '    /launchpad:dashboard   all of it, on one screen',
        '',
        // The price is passed in rather than imported, for the same reason the URL
        // is: this stays a pure function a test can pin. It is omitted rather than
        // guessed when the caller does not supply one — a wrong price in a refusal
        // is worse than no price, because it is read at the moment of deciding.
        price
            ? `  To wire the pipelines: ${checkoutUrl}  (${price}, once — all 1.x updates included)`
            : `  To wire the pipelines: ${checkoutUrl}`,
        '  Then: /launchpad:license, and paste the key from your receipt email.',
    ].join('\n');
}
