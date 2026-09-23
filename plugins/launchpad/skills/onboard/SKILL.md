---
name: onboard
description: Take an app from "it runs on my machine" to shipped — interview the user, then wire the build, signing, distribution, paywall and landing page for every surface in the repo. Use when someone wants to launch, ship, deploy or productionize an app for the first time, or asks what it would take to release something they built.
---

# launchpad: onboard

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

The entry point. Run this in a repo the user wants to ship.

**The premise:** they do not know the list. Not "how do I notarize" — they do not know notarization is *on* the list. Your job is to name what's missing, decide the things they shouldn't have to, and stop only where stopping is genuinely required.

## The rule that governs every question

**Decide the stack yourself. The decisions are what they're buying.** Stop only for:

1. **Money** — anything with a price, always with the number and the free alternative stated.
2. **Secrets** — only they can produce these.
3. **Something that already works** — never migrate a working setup without asking.
4. **Irreversible or public** — DNS, a first release, a store submission, a post.

Everything else: pick the best option, do it, and say what you did in one line. If you find yourself asking which CI provider, which fastlane lane structure, or which notarization flow, stop — those are the product.

## Phase 0 — the ground (once per user, skip if already known)

Check the vault first: `launchpad doctor` outside a repo shows what they've already set up. If it's populated, most of this is answered.

- **[ASK]** What name ships on the software? (copyright, bundle-id prefix, signing identity)
- **[ASK]** What country are you selling from? → merchant-of-record vs Stripe, VAT, payout availability, which ad platforms exist.
- **[ASK]** Which do you already have — Apple Developer ($99/yr)? Google Play ($25 one-time, **plus a 14-day testing gate on new personal accounts** — see below)? GitHub? A domain? For each missing one: **name the cost**, then ask whether to set it up now or skip the surfaces that need it.
  - **Say the Play gate out loud, early.** A *personal* Play account created after 13 November 2023 cannot publish to production until it has run a closed test with **12 testers opted in continuously for 14 days**, plus identity verification. The $25 is not the barrier; two weeks of calendar time is, and it is invisible until they go looking. Organisational accounts and personal accounts older than that date are exempt. If they want Android users this month, that is Firebase App Distribution, not Play.
- **[DECIDE]** GitHub Actions, Cloudflare, Vercel, fastlane, Sparkle. Say it in one line; don't offer a menu.
- **[ASK]** *(only if a Mac surface exists and CI cost is material)* A spare Mac can host a CI runner. macOS runners bill ~10× Linux — on a busy repo that's ≈$100/mo, versus $0 self-hosted. Set one up, or use hosted runners for now?

## Phase 1 — read the repo before asking anything

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" setup
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" score
```

`setup` detects the surfaces. `score` tells you — and them — what's actually missing. **Lead with the scorecard.** It is the most valuable thing in the first sixty seconds: most people have never seen this list, and it reframes the conversation from "deploy my app" to "here are the nine things between this and a product."

**Before you describe what will be built for any surface, read its `framework`.**
`setup`'s one-line surface summary does print it, and `launchpad detect` prints
it as JSON (writing nothing); `.launchpad/state.yml` carries it on the surface.

All four frameworks ship today — `flutter`, `native`, `react-native`, `expo` —
but they get **different pipelines**, and describing the wrong one is how a
buyer ends up waiting for a Fastfile that was never going to be written. The
per-framework table is in **"Read the `framework` before you describe what gets
built"** in `/launchpad:setup`. The short version: Android is `flutter build
apk` for Flutter and `./gradlew` for everything else; iOS is fastlane
throughout, with a JS install and `pod install` added for React Native and Expo,
and `expo prebuild` ahead of both halves for Expo.

If `apply` ever **does** refuse a surface — nothing is refused by framework
today, but the mechanism is live for whatever detection learns next — relay
launchpad's own refusal rather than paraphrasing it, and go no further into
Phase 2 for that surface. The refusal text and the three failure modes to avoid
are in the **"Refused surfaces"** section of `/launchpad:setup`. Do not plan
around a refusal, and do not hand-write the pipeline launchpad declined to
write.

**Two things to say plainly when they come up, because the buyer will not ask:**

- **Expo builds on their own GitHub Actions, not EAS.** No Expo account, no
  access token, no monthly build quota. EAS is a good service and stays
  available to them; launchpad does not set it up, and nothing here requires
  signing up for anything. What they own by taking this route is the signing
  credentials (as for any iOS app) and the iOS build number.
- **An Expo app with no committed `android/` gets an UNSIGNED release build,**
  because prebuild regenerates the native project and would overwrite anything
  launchpad wrote there. Firebase testers cannot install an unsigned APK. They
  either commit `android/` (and launchpad wires signing directly) or add an Expo
  config plugin. Say this in Phase 2, not after the first build.
- **The iOS lanes for React Native and Expo have never been executed.** They are
  generated, lint-clean and reviewed, and proving them needs a macOS runner and
  an Apple Developer account. The Android halves have been run end to end
  against real apps. Use the weakest true word (PLAYBOOK §6).

Then:

- **[CONFIRM]** The detected surfaces. Only surfaces marked `[low]` need an explicit question.
- **[ASK]** One sentence: what is this and who is it for? *(feeds the landing page, the store listing, and the marketing brief — ask once, reuse everywhere)*
- **[ASK]** What stage: builds locally / has testers / live with users / making money? This changes everything downstream — a live app needs migration care, an idea does not.
- **[ASK — never skip]** If existing pipelines were found: **adopt, migrate, or leave alone**, per pipeline. This is the most important question in the flow. A repo that already ships has something that works, and breaking it is the one unrecoverable mistake available here.
- **[ASK]** Does anything else write to this repo automatically — another agent, a bot? Which paths are off-limits?

## Phase 2 — distribution

**A refused surface does not reach this phase.** Every question below presumes a
pipeline exists for that surface. Nothing is refused by framework today, so in
practice every mobile surface reaches Phase 2 — but check the `framework` first
anyway (end of Phase 1), because it decides what you are about to describe.

- **[ASK]** iOS: TestFlight only, or App Store submission?
- **[ASK]** Android: Firebase App Distribution (no-cost on Firebase's Spark plan, no Play account) or Play Store ($25 one-time **plus the 14-day/12-tester gate on a new personal account**)? → default Firebase, and state both numbers. If they want Android users this month, Firebase is not a compromise — it is the only option that fits.
- **[ASK]** macOS: direct download or Mac App Store? → recommend direct (they keep 100%, they control updates), state the trade-off in one line.
- **[CONFIRM]** Web: already hosted somewhere? **Vercel → adopt. Netlify, Fly, Railway, Render, self-hosted → leave it alone** and wire around it. Only propose moving if their setup genuinely cannot be observed, and say why.
- **[CONFIRM]** If the answer is Vercel and this app will ever take money: **Vercel's Hobby tier is licensed for non-commercial use only.** The moment there is a paywall, a checkout or an ad on it, the correct plan is Pro at **$20/seat/month** — comparable to what launchpad costs once, except every month, for as long as the site is up. Say that before wiring it, not after. It is fine to stay on Hobby while there is nothing to buy; it is not fine to let someone find out from Vercel.
- **[ASK]** A domain? Run `launchpad domains` to match against their Cloudflare zones (read-only preview). On an explicit yes, `launchpad domains --wire <domain>` does the whole thing: attaches the domain to the Vercel project and creates the DNS-only records in Cloudflare — no dashboard clicking, no token in `.env`. **Never change DNS without that yes.**
- **[DECIDE]** Trigger policy: validate on every push (Linux, cheap), distribute on tag and dispatch, nightly batch if the repo is busy. Report the shape and the expected monthly cost.

## Phase 3 — secrets (the designed stopping point)

`launchpad doctor` inside the repo lists exactly what this project needs. For each missing one, follow `/launchpad:doctor`: what it is, where to click, what role it needs, whether it's once-per-account or per-app.

Then `launchpad secrets` to inject them. **Never print a secret value.**

**The vault is the only home for a credential — say this, because a session working in the target repo won't know it.** Every deploy/DNS/signing secret lives in the launchpad vault, shared across projects; it is stored by the user, in their own terminal, with `launchpad secret set <key>` (prompts without echoing; a file is piped in — the value never passes through this conversation), read on demand with `launchpad secret <key>` (or `security find-generic-password -a <key> -s launchpad -w` on macOS), and reaches CI via `launchpad secrets`. It never goes in `.env` — a `.env` there is for app *runtime* config only, and a DNS or deploy token placed in it syncs into CI and every deploy. `setup` writes this contract into the repo's own CLAUDE.md (the managed block), so future sessions inherit it; if a tool ever "can't find a token," the fix is to read it from the vault, never to paste it into `.env`.

Two things to say out loud, because nobody knows them until it's too late:

- **The Android upload keystore must be backed up somewhere other than this machine.** Losing it means that app can never be updated on Play again.
- **A credential that's already a GitHub secret is not in the vault.** If a repo ships fine but doctor says a key is missing, it was set by hand once. Store it anyway or the next project can't be provisioned.

## Phase 4 — money

- **[ASK]** Free, paid one-time, subscription, or free-trial-then-paid?
- **[ASK]** Price? If they don't know, give comparables in their category and recommend one.
- **[DECIDE → CONFIRM]** The platform, routed by surface and region, with the numbers:
  - iOS/Android: **StoreKit / Play Billing is required** for digital goods consumed in the app. 15–30%. Linking out to your own checkout is permitted on the **US App Store storefront only** — since 1 May 2025, following *Epic v. Apple*, with no entitlement and no Apple commission on those purchases. **Everywhere else it is still a rejection**, so a single worldwide build cannot depend on it: either gate the link by storefront or ship StoreKit anyway.
  - macOS direct or web: **Lemon Squeezy** (5% + 50¢, merchant of record — handles VAT) **vs Stripe** (2.9% + 30¢, they handle VAT). Outside the US/EU, check payout support first.
  - Both mobile and web: **RevenueCat** so entitlements are one system. Free under **$2.5k monthly tracked revenue**, then **1%** — and say which revenue: MTR is measured on **gross** store revenue, *before* Apple or Google take their 15–30%, so the effective rate against what actually lands in your bank is higher than 1%. At this buyer's scale it is free either way; the number matters when they are deciding whether to build it themselves later.
- **[ASK]** Free trial? How many days?

## Phase 5 — the product page

Generate it from the app's own identity, never a generic template — read the palette, fonts, icon and voice out of the repo. See the static-site section of `/launchpad:setup`.

- **[ASK]** *(only if there's no app to theme from)* what should this look like?

## Phase 6 — close the loop

**Do not compose your own list of what is left. Read it:**

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" needs          # grouped by what it blocks, with the ledger
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" needs --json   # the same list, as data
```

`needs` is free, fleet-wide and derived — and it includes this project, because `setup` added it to the fleet in Phase 1: every item comes from something
observable — a vault key that is absent, a scorecard row launchpad refuses to
guess at, a framework `apply` will not wire, a pipeline with no disposition, a
cost chip on the Decisions tab. It is the same list Mission Control renders in
the strip across the top, so what you tell the user and what they see when they
open the dashboard cannot disagree.

It is grouped in the order the work happens in, and that is the order to walk it:

| Group | What it means for the conversation |
|---|---|
| **Blocks a release** | Nothing ships until these are done. Credentials, a refused surface, a pipeline of theirs nobody has decided about. |
| **Costs money** | Say the number, say the default, and let them answer. Never decide one of these for them. |
| **Cannot be undone** | A first release on a channel, an upload keystore, DNS. Say it before it happens, not after. |
| **Only you can answer** | A drawer, a password manager, an inbox. Ask once, record the answer, stop asking. |

Then read the ledger at the end out loud — "$X a month, $Y once, all of it
unavoidable" — because *"what will this actually cost me"* is the question
behind most of Phase 0 and it is the one nothing else in the product answered.

Everything in the list carries **what it blocks** and **one action**. Relay both.
A credential card is one *act* — one trip to one portal, or one command — and it
lists the vault keys that come out of it with "2 of 4 stored" beside them. Walk
the act, not the keys; reading four keystore key names aloud is the thing this
grouping exists to stop.
Do not add items of your own, do not reorder it into something that reads better,
and do not ask about anything that is not in it — if it is not there, launchpad
has already decided it, which is what the user paid for.

Re-run `score` as well for the readiness detail. Walk the remaining gaps and
either fix them or tell the user plainly which are theirs to close (the `?` rows
always are: keystore backup and support contact, which `needs` also lists under
"only you can answer").

Then ship one thing end to end. **A pipeline that has never run is a hypothesis.** Cut a real release, watch it, and confirm the artifact arrived where it was supposed to — TestFlight, Firebase, the DMG URL, the live page. Read `PLAYBOOK.md` §1 first: a "Ready" deployment and a green build are both routinely wrong.

## Standing rules — ask once, honour forever

Never spend money without a tap. Never post publicly without a tap. Never change DNS without a tap. Never force-push or rewrite history. Never auto-submit to App Store review. The first release on any new channel always asks, whatever the settings say.

## Tone

They built something and got stuck on the part nobody teaches. Do not lecture, do not list everything at once, and do not make them feel behind for not knowing that release builds sign with debug keys by default. Name the gap, say what it costs, fix it.
