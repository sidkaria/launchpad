---
name: status
description: Show launchpad status — this project's surfaces and pipelines, its readiness score, or every project you manage at once. Use when the user asks what's wired, what's left to do, whether something is production ready or ready to ship, how close a repo is to being a real product, what is missing or risky in it, for a readiness review or audit of a repo, or how all their apps are doing.
---

# launchpad: status

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

## Every project at once

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" projects
```

One line per registered app: readiness score, how many surfaces are wired, which platforms, and a count of critical gaps. Use this when the user asks about their apps in general rather than the repo they happen to be sitting in — it is the whole "all my apps in one place" promise, and it is read fresh every time, so it can never be stale.

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" add [path]      # register (defaults to cwd)
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" remove [path]   # unregister; the repo is untouched
```

`setup` adds the project to the fleet as it records it, so an onboarded project is always on the list (and `needs` sees it). `add` is for a project set up before that, or moved: it requires the project to be set up first. The registry lives at `~/.launchpad/projects.json` and holds **only paths** — every project's truth stays in its own repo, so deleting the registry loses nothing but the list.

A project row can report a problem instead of a score: the directory is gone, or it was never set up. Say which, rather than treating it as a failure.

## This project

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" status
```

If it reports the project is not set up, offer to run `/launchpad:setup`. Otherwise summarize the JSON for the user in plain language: surfaces and their status, existing pipelines, and required credentials.

## Readiness — what still stands between this and a real product

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" score
```

`score` grades the project against one fixed rubric and reports what is missing, what it costs, and what is unrecoverable. It is derived entirely from state and files on disk — nothing is asked and nothing is cached, so it cannot go stale.

Lead with it whenever the user asks "what's left", "is this ready", or "what should I do next". Most people do not know the list — that is the point of it. The checks:

| | |
|---|---|
| builds in CI | not just on your machine |
| versioned releases | a version you edit by hand is one you ship twice |
| **Android release signing** | a stock project signs *release* with the **debug** keystore |
| **keystore backup** | lose it and that app can **never** be updated on Play again |
| **notarization** | an un-notarized Mac app shows a warning most people won't click through |
| distribution live | something that actually reaches users |
| **auto-update** | a Mac app with no updater strands every user on v1 forever |
| test gate | the cheap Linux one, on every push |
| **secrets out of git** | a committed key is public, and deleting it doesn't remove the history |
| crash reporting | or you learn about crashes from a one-star review |
| usage visibility | one number per app |
| monetization | and platform-correct: IAP on mobile; an external checkout link is US-storefront-only |
| **privacy policy** | mandatory for both stores; its absence is a rejection |
| landing page | somewhere to send a stranger |
| support contact | required on both store listings |

Bold rows are the ones that cost something unrecoverable or block a submission outright; `score` sorts those first and marks them `[critical]`.

## The rubric is not the same for every project

**`score` names what the repo IS before it says what is missing from it** — "Rust CLI", "Django app", "Electron desktop app" — and the questions change accordingly. Rails and Rust used to produce byte-identical scorecards, and a Rust CLI author was told a privacy policy is "MANDATORY for the App Store and Play". The missing pipeline was always stated honestly; the questions around it were not.

So when the repo has no store surface, these appear instead of the store rows:

| | |
|---|---|
| **a licence someone else can rely on** | no LICENSE means default copyright: nobody may legally use or depend on it, and for a library that is the silent reason a company never adopts it |
| a README that explains what this is | for anything installed from a registry, the README *is* the product page |
| a stranger can install it / **it runs somewhere that is not your laptop** | the finish line, in the terms of this project — a registry for a CLI, a deploy for a service, a download for a desktop app |

And the wording of the shared rows changes too: distribution talks about crates.io rather than TestFlight, monetization talks about licence keys rather than StoreKit, and a web service is not told it has "no page describing this app" when the app *is* the page.

**Electron and Tauri are desktop apps.** launchpad ships no pipeline for them — its macOS lane is Xcode-based — but signing, notarization and an updater apply exactly as they do to a Mac app, and those rows are asked (naming `electron-builder` or Tauri's own tooling, not `notarytool`). Saying "macOS apps are supported" and then having nothing to say about an Electron build was the most confusing case in the product.

**Never read the store rows out to someone whose project has no store.** If the scorecard is not asking about the App Store, neither should you.

Some checks report `?` rather than a pass or a fail — keystore backup and support contact always, and others when the only available evidence is a filename or a config value rather than something observed. No file on disk can prove them, so launchpad will not guess.

**`?` is a question, so ask it — and then record the answer.**

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" confirm                    # list what is waiting on the user
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" confirm keystore-backup "in 1Password, vault: Shipping"
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" confirm keystore-backup --undo
```

Ask the user plainly, once, and if they say it is handled, record it. An unanswerable question re-asked on every run is not diligence — it is nagging, and it trains people to skim past the rows that do matter. A note is worth capturing where there is one ("where is that backup?"), because the answer is more useful in six months than the tick is.

Two rules, and they are not negotiable:

- **Never confirm on the user's behalf.** It is recorded as *their* answer, dated, and rendered as "you confirmed this on <date>" rather than as a verified fact. Asserting it for them would put a false pass in the one place the scorecard is being careful.
- **Only `?` can be confirmed.** A `✗` is something launchpad actually observed. It cannot be confirmed away, by the user or by you, and the CLI refuses. If the user insists a gap is fine, the honest answer is that the check is wrong and should be fixed — not silenced.

Confirmed rows count as done and stop appearing in the queue. Nothing expires: a two-year-old answer shows its date and lets the reader judge.
