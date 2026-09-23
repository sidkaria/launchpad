---
name: license
description: Licensing and provenance — activate a launchpad licence, check it, release a machine, and report which build is running. Use when someone asks about buying, activating, "needs a licence", an activation limit, or which version of launchpad this is.
---

# launchpad: license

<!-- launchpad:standing-rules -->
## Standing rules — identical in every launchpad skill

1. **Never print a secret value.** Finding a credential — in a `.env`, a key
   file, a keystore, a token in a log or a CI variable — you name the **file**
   and the **key name** and stop. Never the value, never part of one, never a
   prefix, a suffix, a length or a hash, and not "just to show the problem".
   Do not open a `.env` at all: the key names are in `.env.example`, and the
   strongest guarantee is not looking. `launchpad report` is built so a paste is
   safe in public, and a transcript quoting the value throws that away. An
   exposed key is fixed by rotating it, never by displaying it.
2. **"It's broken" / "it's not working" / "help" → `report` first.** Run
   `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" report`, or ask the user to
   run it and paste the output, before any diagnostic question. One paste
   replaces ten questions; it is free, needs no network, and is redacted, so it
   is safe to share. One clarifying question alongside it is fine; a list of
   questions instead of it is not.
3. **We decide; they are not asked to choose.** The CI provider, the signing
   model, the bundler, the runner and the trigger shape are launchpad's calls —
   not having to make them is what was bought. Stop only for money, a secret,
   something that already works, or an act that is irreversible or public.
4. **Read the detected state before promising anything.** A surface's
   `archetype` and `framework` decide whether a pipeline exists at all
   (`launchpad detect` prints both as JSON and writes nothing;
   `.launchpad/state.yml` holds them after `setup`). Where launchpad refuses a
   surface, relay that refusal — what was found, why there is no pipeline, and
   what the user still gets — rather than paraphrasing it, planning around it,
   or hand-writing the pipeline launchpad declined to write.
<!-- /launchpad:standing-rules -->

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" license                     # status, and re-check with the provider
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" license <key>               # bind this machine (same as `license activate <key>`)
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" license deactivate          # release this machine's seat
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" version                     # which build is running, and from where
```

When someone hands you a key ("here's my launchpad key: …"), run `license <key>` and relay what it prints. Things it handles so you do not have to:

- **Running it twice spends nothing.** If this machine already holds that key, it re-checks instead of activating — Lemon Squeezy counts every activation as a new machine, and a buyer unsure it worked used to burn a seat each time.
- **A different key replaces the old one** and releases the old key's seat on this machine.
- **It never hangs.** Activation waits at most 15 seconds, a status check 8; a licence server that accepts the connection and never answers is reported as "no answer in time".
- **Failures say which of three things happened** — no connection, no answer in time, or an answer that was not the licence server's (a captive portal) — and that nothing was used up. A rate limit or an outage is never reported as the key being refused.

## What is free, and what is not

**Free, always:** `detect`, `setup`, `status`, `score`, `doctor`, `needs`, `confirm`, `projects`, `dashboard`, `report`, `secret`. Everything that tells someone the truth about their own projects.

**Licensed:** `apply`, `secrets`, `release`, `domains`. The verbs that do the work.

That line is deliberate, not stingy. The scorecard *is* the argument for buying — someone running a shared copy who can still see the fifteen things between their app and a product is far more likely to pay than someone who hits a wall. And locking a person out of reading their own repo would be a terrible trade for a one-time product that has to survive on near-zero support.

## What it costs, and what the purchase includes

The current price and the refund window are constants in `src/product.ts` (`PRICE`, `REFUND_DAYS`), not numbers to recall. **Read them from there rather than quoting a figure from memory** — the price steps up as the product sells, so a remembered number is wrong the day after a step.

- **One payment.** No subscription, no renewal, no seat count that grows. Entitlement never expires.
- **All 1.x updates are included; 2.0 is a paid upgrade, discounted for owners.** Say both halves. "One payment, updates forever" is a promise nobody made, and a buyer who believes it is a refund waiting to happen.
- **Refunds: 14 days, no questions.** No justification, no form. The way to ask is to reply to the receipt email, or to open an issue on the support tracker if the receipt is lost. **Never ask anyone to paste a licence key into a public issue** — the last four characters identify the purchase, and `launchpad report` already prints exactly that much.

## Be honest about what the check is

launchpad runs on the buyer's machine, and **the TypeScript source ships in the package** — `plugins/launchpad/src/`, alongside the `dist/` that actually runs. Anyone who opens `license.ts` or `license.js` can remove the check in a minute. **Say so if asked.** This exists to make casual copying mildly inconvenient, to give honest people a way to be honest, and to tell someone running a shared copy where it came from. It is a receipt, not a lock. Do not describe it as protection, and never spend effort on obfuscation — that would cost real work and buy nothing.

Be precise about the two copies when someone asks: **`dist/` is what runs, `src/` is what it was built from.** Editing a `.ts` file in an installed package changes nothing until it is compiled, and an update overwrites the whole directory — so "edit your copy if you like" is true, and "your edit survives an update" is not.

The activation limit on the product is the actual anti-sharing mechanism: one key, N machines, and the N+1th is told plainly that the seats are used up and how to free one.

## Who answers "is this key good?"

The rail lives behind a `LicenseProvider` interface in `src/providers/`, chosen by `LICENSE_PROVIDER` in `src/product.ts` and overridable with `LAUNCHPAD_LICENSE_PROVIDER`.

- **`lemonsqueezy`** — what we launch on.
- **`polar`** — the tested fallback, validate-only against Polar's customer-portal endpoint, which Polar documents as safe for a public client. It needs `LAUNCHPAD_POLAR_ORGANIZATION_ID`; that value is a public namespace discriminator, **not** a secret. A Polar *Organization Access Token* (`polar_oat_…`) is a secret and must never appear in shipped code — it carries `license_keys:write`.

Every record stores which rail issued the key, and re-checks go back to **that** rail rather than to whatever this build defaults to. That is what makes changing the constant safe: without it, a new default would hand every existing key to a provider that has never seen it, collect a confident rejection, and cancel the entire customer base because a constant changed.

An unconfigured rail reports *unreachable*, never *invalid*.

## The rule that matters: never punish a paying customer for our problem

1. **A stored key entitles immediately.** It validated once, so nobody waits on a network round trip to run a build; re-checks happen after.
2. **Unreachable ≠ invalid.** An aeroplane, a firewall, a Cloudflare incident and an expired card must not look the same. A failure to *reach* the provider changes nothing at all. Only a positive rejection revokes. A 5xx, a 429 and a malformed-request 422 are all unreachable, on either rail — one bad afternoon at a payment provider must not read as a mass cancellation.
3. **There is no expiry.** This is a one-time purchase, so entitlement does not decay — not after a fortnight, not after a year offline. A key that has validated once keeps working until the provider positively rejects it.

On Polar every negative outcome collapses into a single 404 — no such key, revoked, disabled, expired — so the message says "not valid for this product" and does **not** guess at a reason. Telling someone their key "expired" when they were actually refunded is the kind of small lie that costs more than the silence.

Past `STALE_AFTER_DAYS` (14) without a successful re-check, `license` *mentions* the silence. That is a note, not a state change: the verbs all still run.

Every licensed verb quietly refreshes the key on its way past — throttled to once every 20 hours, bounded to two seconds, aborted rather than abandoned, and silent whatever happens. This is the only thing keeping a stored key current, and its absence was a real bug: entitlement used to decay on a timer and the only thing that reset it was a command nobody had been told to run, so a one-time purchase stopped working on day fifteen and re-displayed the checkout URL. If you are ever tempted to make entitlement depend on the clock again, that is the outcome.

**When someone reports "it stopped working":** ask for `launchpad report` — one paste carries the licence state, the build, the host and the detected surfaces, with nothing secret in it — then run `license`. If the state is `lapsed`, the provider is actively rejecting the key: a refund, a chargeback, or our mistake. Do not send them to the checkout; they have already paid once. Anything else that looks like an expiry is a bug on our side, not a payment problem to chase.

## Exercising licensed verbs in CI

The harness has to run `apply` without anybody's real key. The seam for that is **injecting a provider**: `revalidate`, `refreshIfStale` and `activate` all take one, so a caller that already holds the code can hand them a fake rail.

There is deliberately **no environment variable that grants entitlement**, and adding one would be a mistake even though the check is admittedly a receipt rather than a lock. A documented `LAUNCHPAD_FAKE_LICENSE=1` is not the same thing as source anyone can edit: it is a bypass every reader of the README is handed, which is how a receipt stops meaning anything. `test/providers.test.ts` asserts both halves — that no such switch exists in the licence path, and that the licence path reads only a fixed, listed set of environment variables.

## Provenance — which launchpad is this?

`version` reports whether this process is running from a **published package** or a **source checkout**, and every command warns on stderr when it is not the package.

This is a discipline, not a nicety. A checkout has the test suite, the release scripts, a full `node_modules` and whatever is half-finished on the branch; the package has `dist/`, `src/`, the skills, and one vendored dependency. They are different programs and only one is the product — so "it still works on my own repo" is only true if that repo was run against the package.

The signal is `test/`, not `src/`: `src/` ships, so its presence says nothing about which copy this is.

`LAUNCHPAD_DEV=1` is the override for working *on* launchpad rather than *with* it. It is named and announced precisely so nobody can be in dev mode by accident and believe they proved something about the product.

Build and inspect a package with:

```bash
npm run publish
```

## Updates

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" update
```

For a one-time purchase with no subscription to remind anyone it exists, the update path **is** the support channel: without it, a customer who bought on day one is on day one's build forever, and every bug fixed afterwards is one they hit and never escape.

Three limits, all deliberate, and all about not being creepy or dangerous with someone else's machine:

- **It never checks unless asked.** No background phone-home, no telemetry on other commands. `update` is a question the user asked; anything automatic is a question we asked about them.
- **It never installs.** Overwriting a running plugin in place, on a machine nobody can see, to fix a bug nobody reproduced there, turns one broken install into a broken install with no way back. It says what changed and where to get it. The message states that reasoning, so it does not read as a missing feature.
- **It fails quietly.** An unreachable update server is not the user's problem and must never look like one — it degrades to "could not check", and says plainly that nothing is wrong with their install.

A release may set `criticalBelow`, which makes the message louder for anyone below that version. It still does not install anything.
