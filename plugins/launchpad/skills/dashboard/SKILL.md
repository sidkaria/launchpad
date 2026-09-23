---
name: dashboard
description: Mission Control — every app the user owns on one screen, with readiness, tonight's queue and last night's result. Use when someone asks to see all their projects, wants an overview, asks "what's left before I can ship this", or asks to open the dashboard.
---

# launchpad: dashboard

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
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" needs                  # the same "needs you" list, in a terminal
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" needs --json           # …as data
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" dashboard              # start it and open a browser
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" dashboard --no-open    # start it, print the URL only
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" dashboard --port=5000  # a different port
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" dashboard --demo        # a fictional fleet, for screenshots
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" dashboard --demo --replay   # …arriving one check at a time
```

It serves on `127.0.0.1:4747` and runs until Ctrl-C. Start it in a background shell so the session stays usable.

## What it is

A **"needs you" strip across the top of every view**, a **side navigation panel listing every onboarded project**, and — when you pick one — everything about that project in one place. The fleet is the overview; the project is the unit of work.

### Needs you — the strip above everything

Fleet-wide, persistent, and the first thing on the screen on every view. One line when there is nothing — *"Nothing needs you"* — and grouped cards when there is. `launchpad needs` prints exactly the same list in a terminal, and `--json` gives it as data; the model is `src/needs.ts` and both renderers read it rather than composing their own.

Every fact in it already existed somewhere in this product: a missing vault key on the Credentials tab, a `?` row on the scorecard, a cost chip on Decisions, a pipeline with no disposition in `state.yml`, a surface `apply` refuses. **Seven places to look is the same as none** — the thing blocking somebody's first Android build sat three clicks inside a project page, indistinguishable from twelve things that were fine.

Two rules govern what may appear, and they are not negotiable:

- **Never an item the code cannot justify.** Each one is derived from something observable. Nothing is there because it is generally good advice — a list with one speculative row is a list people learn to skim, and skimming takes the row that mattered down with it.
- **Never a question the code can answer itself.** A fully wired, fully credentialed project produces an empty strip; a unit test asserts exactly that. We decide the stack, so a finished project is a quiet one.

Four groups, in the order a first-time shipper actually needs them — **blocks a release**, then **costs money**, then **cannot be undone**, then **only you can answer**. That split is the 2026-08-02 resolution ("split on reversibility, not on stage") plus the question bank's standing confirmations, rendered.

| Kind | Raised by | The one action |
|---|---|---|
| `paste-credential` | a **credential set** with at least one key missing — one card per trip to a portal or per command, not per vault key | **Add it**: the keys the set produces with their presence, where to click once, and a `launchpad secret set <key>` per missing one, spelled with the CLI's real path so it pastes into a terminal |
| `confirm` | a scorecard row marked `answerable` | the existing confirm flow, in place |
| `decide-money` | a config field with a bill attached (hosted macOS runners) | accept or decline, with the default and the number |
| `acknowledge-irreversible` | a channel nothing has gone out on, a keystore about to be generated, a domain about to be pointed | acknowledged, and dated |
| `keep-or-migrate` | a detected pipeline with no disposition | keep it — which writes `leave-alone` into `state.yml`, because `apply` branches on that and on nothing else |
| `store-gate` | Play's $25 and its 14-day/12-tester gate, Apple's $99/yr, Vercel Hobby → Pro once there is a paywall in the repo | noted, once, for the whole account |
| `refused-surface` | the archetype's own refusal logic — never a list kept here, so it disappears by itself the day the pipeline exists | what you still get |

**A card is an act, not a vault key.** The Android upload keystore is four vault keys and one `keytool` invocation launchpad performs itself; the App Store Connect key is three values off one screen; Cloudflare is a token and an account id from one dashboard. Grouped by key it read as twenty jobs to somebody who had eight things to do, and a count that is not a count of decisions makes a list look hopeless. So each card lists the keys it covers, states how far along it is (*"2 of 4 stored"*), and says whether launchpad generates it or the user fetches it — the keystore card has to say launchpad makes it, because the next thing it has to say is the backup warning. `needs --json` carries both the set and its keys. The grouping is `CREDENTIAL_SETS` in `src/needs.ts`, keyed by secret name; it belongs beside `SECRET_CATALOGUE` in `src/secrets.ts` and should move there. A key no set claims still gets a card of its own, and a test fails if a catalogue secret is unplaced.

**Every button is an action in two words or fewer** — Add it · It's handled · Accept · Understood · Keep it · Noted · See why. Never "Get the key": that is the landing page's purchase wording, and on a card about a credential the user already owns it reads as an upsell.

**Account-wide items are asked once.** Six projects wanting one App Store Connect key is one thing to do; printing it six times is the fastest way to teach somebody that the strip is noise. An account-wide answer is only spent once every project it applies to has it.

**There is no field for a credential value anywhere on this page, and there is not going to be one.** A value typed into a browser is in the DOM, in the browser's memory and one autofill away from a password manager that thinks it is a login form. The card shows the command — `secret set`, which prompts without echoing or reads a piped file, with the CLI's real path because nobody has `launchpad` on their PATH — and the value goes from a terminal straight into the vault. (`launchpad secret <key>` without `set` READS a credential; the cards used to offer that one, which only answers "not in the vault".)

**Every answer is recorded, dated, and reachable.** Acknowledgements go into the repo's own `.launchpad/confirmed.yml` under namespaced ids (`money:`, `gate:`, `irreversible:`, `keep:`) and render on the Decisions tab as *"you decided this on <date>"*. A button that makes an item vanish and leaves no record has hidden a decision rather than recorded one. The namespace is what keeps them out of the scorecard's way: nothing written there can turn a `gap` green, because the scorecard never reads those ids.

### Cost — what this will actually cost them

A **ledger**, on the fleet view as a card and on every project page as a chip that opens the breakdown. Totals per month, per year and one-off, split three ways: **unavoidable** (the platform charges it), **launchpad's choice** (a consequence of a decision on the Decisions tab, and therefore reversible by reversing that decision), and **optional**.

Every number in it is a decision's own cost chip, structured. Two things are deliberately *not* totalled and are listed instead: a **metered** cost, which has no number anybody can stand behind — inventing a monthly figure for a runner bill would put a guess on the one line a buyer quotes — and a **conditional** one, such as Vercel Pro on a site with nothing to buy on it yet. When a condition comes true the matching `store-gate` item charges it, once, so one $20 per seat per month subscription is never counted twice.

**All projects** — a fleet readiness ring, per-project cards with a readiness meter and the last thing each shipped, a **what's live where** panel, then the full rubric grid.

The grid runs **checks down the side and apps across the top**. That way round because the checks are the long list: seventeen of them across the top left 36px per label and forced every label onto its side, rotated, in a band taller than the data. Nobody reads a rotated label, and it is the first thing that has to survive being shrunk to a thumbnail.

The cards carry a **meter**, not a row of per-check dots. The dots said which check was which — what the grid is for — and at card size they were a grey smear. Proportion plus "13 done · 2 left · of 15 that apply" reads at any size. `n/a` is left out of the bar: a web app has no upload keystore, and counting that as unfinished work would be inventing a denominator.

**Per project**, six tabs:

| Tab | What it holds |
|---|---|
| Readiness | this app's checks, criticals first, each with what it costs |
| Build & Release | every detected surface, why it was detected, its full gathered config |
| **Decisions** | every choice launchpad made **and the reason** |
| Roadmap | capture → backlog → who runs it → what happened |
| Credentials | which credentials this project needs and which are present — never values |
| Marketing | a visibly empty "coming" slot |

### Roadmap: the backlog is the roadmap, Nightshift is one executor

This is the structural call and it matters. An earlier version had a "Tonight" tab, which put a *scheduling window* in front of the work — wrong, because someone with an idea wants to capture and shape it, not think about 23:00.

So the backlog is presented as **the project's roadmap**, and the two ways to execute it sit side by side as peers:

- **Overnight** — Nightshift drains it unattended, with the on/off switch, window, mode and gate stated.
- **Right now** — a fresh Claude session does the same work attended. Every ready task has **Work on it**, which copies a prompt naming the task file and the gate.

Same backlog, same gate, two executors. Never describe the backlog as belonging to Nightshift.

### Decisions is the one that sells it

The pipelines are commodity. What a buyer pays for is that someone already decided the validate lane runs on ubuntu because macOS runners bill ~10×, that a stock Flutter release build is signed with the debug keystore, and that losing an upload keystore ends that app forever. That screen is the receipt, the teaching, and the argument for the price, all at once.

It distinguishes **"launchpad chose"** from **"yours, kept"**. Those are different promises — blurring them claims credit for the user's own work, or implies launchpad maintains something it never touched.

### What's live where

Every wired surface, the channel it ships down, and the last thing this repository can prove went out.

**It is never a claim about a store.** launchpad has no account with Apple, Google, Vercel or Cloudflare and is not going to get one, so it cannot know a build passed review. It reports two facts it reads off `.git` — the newest tag, for surfaces that ship when you tag, and the head commit, for surfaces that deploy when you push — and **every row prints which of the two it is looking at**. Say that plainly if asked; a dashboard that inferred "live" from a tag would be wrong the first time a submission was rejected, and being wrong about that is how a tool that also holds signing keys loses the argument.

### The demo fleet — `--demo`

A fictional fleet of seven invented apps across every surface launchpad ships, for screenshots and video. **Never the default.**

It is not a rendering mode. It writes real repositories into a temporary directory and points the server's HOME at them, so every number on screen comes out of the same `scorecard()`, `decisionsFor()` and `dashboardData()` as a customer's own projects. There is no demo renderer and no branch in the data layer. That is what keeps it honest: a hand-written payload would drift from the checks the moment either changed, and the first green cell the scorecard would have graded red makes the screenshot a lie.

It reads and writes nothing under `~/.launchpad`, and the page says "demo data" in the band across the top, in the sidebar wordmark and in the browser tab — three places, all of which survive a crop. The band also names the temporary folder, as `parent/basename` and never as a path: the terminal prints the whole path, and an absolute path on this screen is the one thing the August audit's Blocker 3 was about. It is dropped below 560px, where the band is the warning and nothing else.

`--demo --replay` plays the arrival sequence: the fleet starts as one freshly added, not-yet-onboarded project and resolves on a timer. `--replay-ms=` sets the pace. It works by **moving files back into the repo**, so the checks re-grade for real and the update travels the same `fs.watch` → SSE channel a customer's repos use. Nothing animates to a value; only arrival moves.

### App icons and store presence

Every project's real icon is detected from its own repo — Xcode asset catalogues, Android mipmaps, Flutter's, `public/favicon`, `.icns` — and shown in the sidebar, the fleet cards, the rubric grid and the project header. It is only a visual cue, but it is the cue that makes ten projects scannable instead of ten rows of text.

The icon is served from `/api/icon?project=…` rather than inlined. The request names a **project**, never a file: the path is re-derived server-side from that project's state, so the endpoint cannot be turned into "read any file on this machine". Inlining was rejected separately — a 1024px PNG is about a megabyte of base64, and this payload is re-sent on every file change.

**Store presence is a readiness check, because a store will refuse to publish without it.** This is the thesis in miniature — nobody fails to ship because they could not write the code:

- **`app-icon`** — present, large enough, and **no alpha channel for iOS**. Apple rejects a 1024 marketing icon with transparency *after* a successful upload, which is why it is easy to hit twice.
- **`store-listing`** — screenshots, Play's **1024×500 feature graphic** (a hard block on publishing, not a nag), and a `fastlane/metadata` tree.

Both are non-pipeline gaps, so the readiness drawer offers **"Add to the roadmap"** — launchpad cannot draw an icon for someone, and pretending otherwise would be the dishonest version of this feature.

**Two accuracy rules, both learned by running it on real repos:**

- **The no-alpha rule is iOS only.** A macOS icon is *supposed* to have transparency — the rounded shape and its margins are the artwork — and a Developer ID app has no review to be rejected by. Flagging it would send someone to break a correct asset.
- **Never mention Play to a project with no Android surface**, or the App Store to one with no iOS surface. The copy is built from the archetypes present.

### Live status — the one volatile fact

Everything else on screen is derived from files that are true whether or not anything is running. "What is happening right now" is not, so it is persisted to `.launchpad/nightshift/run.json` — phase, task, pid, timestamps — and the dashboard reads it.

**Liveness is a pid check, not a heartbeat.** The drain blocks inside `spawnSync` for the whole agent run, so there is no thread to write a heartbeat from, and a heartbeat that only ticks between phases would declare a healthy hour-long build dead. Asking the OS whether the process exists is exact and free.

The state that matters most is `crashed`: a live run and a process that died three days ago **both leave a task at `in_progress`**, identical in the backlog and opposite in meaning. `finishedAt` is what separates them.

Updates arrive over **server-sent events**, and what is watched is **each project's whole repository**, not just its `.launchpad/`. That distinction was a bug for a while and it is worth stating: everything the scorecard reads — a privacy policy, a `.gitignore`, a workflow under `.github/`, an app icon, a dependency in `package.json` — lives in the repo, so watching `.launchpad/` alone meant a real change reached the screen only on the floor tick, twelve seconds later on average instead of under one.

The arming is two-level, because a recursive watch on a repository with a 300MB `node_modules` is expensive on Linux: the repo root non-recursively (which is what notices a new `PRIVACY.md`), then every top-level directory that is not generated output. `node_modules`, `build`, `dist`, `.dart_tool`, `Pods`, `.next`, `target`, `vendor` and friends are never subscribed to at all — safe because that is the same set the scorecard refuses to walk, so nothing in them can change an answer. `.git` is the exception in both directions: it churns on every command, so only `.git/refs`, `HEAD` and `packed-refs` are watched, which is exactly what "what's live where" reads. Events are coalesced to one push per burst.

There is still a **15s floor tick**, because `fs.watch` is refused outright on some network and container filesystems. When watching is degraded — refused, or a fleet past the per-connection watcher ceiling — the stream says so in a named `watch` event and the sidebar footer prints a line saying the numbers refresh on a timer. It never claims to be live when it is not, and there is deliberately **no green "live" badge**: a badge that is always green is a badge nobody reads. Polling remains the fallback if the stream cannot connect at all.

### There is no database, deliberately

The repos are the state. A database would be a second copy of the truth, plus a migration story, to answer questions the filesystem already answers — and it would break the property that deleting `~/.launchpad` loses nothing.

The cost of that choice is one failure mode, and it is handled in the next section.

### Look and feel

Dark-first, deep blue-black with an electric mint accent, mono micro-labels, a hairline grid ground. Icons are **authored inline** in an SVG sprite — never a CDN, never a font, because the page must work with no network. Platform badges are authored glyphs plus a mono label rather than vendor logos: a mangled brand mark looks worse than no mark at all.

Type is a grotesk chain resolved **locally** — Inter/Inter Tight, then Neue Haas Grotesk or Helvetica Neue, Segoe UI Variable, Roboto, Arial as the floor — with a mono that leads with the ones developers install on purpose. No `@font-face` and no font CDN: the page must render with no network, and nothing is bundled because redistributing a typeface inside a product that is sold needs a licence for exactly that.

**Motion is tied to arrival, never to a value.** A cell that has just changed from not-done to done flashes once; the fleet's outstanding count marks when it moves. Score rings are drawn at their true value immediately and never sweep. This is a correctness property, not a style choice: a gauge animating to its number displays a number that is not the data for as long as the animation lasts, and on a throttled tab that can be seconds. Do not re-introduce it to make a recording prettier. Everything here respects `prefers-reduced-motion`.

Projects carry **their own identity**: the extracted app icon where the repo has one, and a tile in a hue derived deterministically from the project's label where it does not. The derived hue is decoration — it appears on the tile and a rail down the side of the card, and never on a cell, a ring or a chip, because those colours mean something.

**Two projects with the same directory name are qualified with their parent, the way an editor qualifies two tabs called `index.ts`.** `website`, `app`, `site`, `docs` and `api` are ordinary directory names in a monorepo or a `~/Code` tree, and two rows reading `website` with the same meter, the same pill, the same ref and the same hue cannot be told apart on a screen whose job is to be scanned. The qualifier appears in the sidebar, the card footer and the CLI's `fleet` output, and only on the rows that actually collide — adding a folder to every row would be noise paid for by everyone to solve a problem two rows have. It goes as deep as it needs to: one directory for `alpha/website` vs `beta/website`, two for `x/app/web` vs `y/app/web`. The hue keys off the same qualified label, so the colour distinguishes them too.

The hue is **not** keyed off the absolute path, tempting as that is. `--demo` writes its fleet under a temp root carrying the pid, so a path-derived hue would change on every run — breaking both the promise that a project looks the same in a screenshot taken a month later and the committed pixel baselines.

Tabs are folder-style — the selected tab shares its surface with the panel below so the section and its content read as one object.

### Keeping it true — the CLAUDE.md contract

Because nothing is cached, a session that does work and does not write it down makes the dashboard wrong. So `/launchpad:setup` writes a contract into each project's managed `CLAUDE.md` block stating which files own what, and — when that project has a backlog — that **any agent working a task owns its status**.

The rules are phrased as consequences rather than instructions ("a task finished without its status moved gets built a second time tonight"), because an agent that knows *why* a file matters keeps it right in situations the text never anticipated. The block is generated from state, and the backlog section only appears when there is a backlog, so it never describes a feature that repo does not have.

### Theme

Three states — `auto`, `light`, `dark` — cycled from the button in the sidebar footer and stored in `localStorage`. `auto` is the default and follows the OS; only an explicit choice writes `data-theme`, so picking "dark" while the OS is already dark does not freeze the page against a later OS change.

## It is local-first, and that is not a limitation

No account, no server, no tenancy, no customer data anywhere but their own machine. Say this plainly if asked — it is a feature people pay for, not a v1 compromise.

## It is read-mostly, on purpose

Everything that writes is a **queue or list action**, never a repo action:

| Write | What it does |
|---|---|
| Answer a "needs you" item | a dated line in that repo's `.launchpad/confirmed.yml`, under a namespaced id |
| Keep an existing pipeline | `disposition: leave-alone` on that pipeline in `.launchpad/state.yml` — the one write that touches state, and it earns it, because `apply` branches on that field and on nothing else |
| Capture an idea | a line in the inbox, for grooming to shape |
| Add a task | straight into the queue, skipping grooming |
| Set a priority | 0-9; past that it is a wish, not a priority |
| Retry / re-scope | move a blocked task back to `ready` or `scoped` |
| Overnight on/off | per project, and refused without a gate |
| Add / stop tracking a project | the registry holds paths only, so removing loses nothing |

**Writing into an adopted backlog is the delicate one.** A new task is written
in the *neighbours'* shape — key order learned from the files already there,
unknown fields given an empty value of the right type, `P1` vs `1` preserved —
because emitting launchpad's own vocabulary into someone else's format is what
made a real repo unpushable once already.

Adding a project is **not** onboarding. It registers a directory; the interview
that works out what a repo *is* belongs in Claude Code, where it can ask
questions. A repo that has not been onboarded still appears, as a row saying so.

Everything that changes code renders as a **command to run in Claude Code** instead. A readiness gap launchpad can fix shows `/launchpad:setup` + `/launchpad:apply`; a gap that is genuinely work (a privacy policy, crash reporting) offers to drop a scoped idea into that project's Nightshift inbox. A dashboard that grows into a full control panel is a second product to maintain, which is fatal at this price with near-zero-touch support.

**It cannot enable a project with no gate command.** The button returns an error, the same as the CLI refuses. A gate is the only thing between an overnight agent and code nobody checked, and a UI must not become the way around a safety rail.

## How a project gets on it

`/launchpad:onboard` inside the repo — `setup` adds the project as it records it — or `launchpad add <path>` for one set up elsewhere. That is the entire integration: the registry holds **paths only**, and everything on screen is re-derived from each repo's own `.launchpad/state.yml`, backlog and events on every request.

Nothing is generated, templated or cloned per project. The page ships pre-built and byte-identical to everyone — **never regenerate it, and never write a per-project dashboard.** N customers must get one consistent UI, not N inconsistent ones. If a section needs to change, change `src/dashboard/app.html` in launchpad itself.

## When it looks wrong

- **A project shows a row saying "not set up"** — that is correct and deliberate. A half-onboarded project must never produce a blank screen.
- **A project shows "`.launchpad/state.yml` cannot be read"** — that is a *different* row, and the difference matters. The project **is** set up; its state file will not parse, and the row quotes the parser's own first line so the user knows which line to open. Do **not** suggest `/launchpad:onboard` here: it would rewrite the file from a fresh detection and discard whatever per-surface config was gathered. Either fix the named line, or delete the file and accept that cost knowingly. One broken state file costs exactly one row — the other projects still score and the totals stay equal to the sum of them.
- **Nothing is cached anywhere.** If a number looks stale, it is not stale; it is what the repo says right now. The page re-reads every 30 seconds.
- **The payload states a `contract` version and its `capabilities`.** A customer can be running a page older than their state; a section it does not recognise is ignored rather than mis-rendered.
- **Marketing shows as an empty "coming" slot.** Leave it that way. An obviously-unfinished section reads as roadmap; a half-working one reads as broken.
