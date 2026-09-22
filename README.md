# launchpad

**You built an app. It runs on your machine. It is not a product yet.**

launchpad is a Claude Code plugin that names everything standing between the two
— then does the parts that are mechanical.

Most people who have an unshipped app are not stuck on "how do I notarize". They
are stuck because nobody told them notarization was on the list. Or that their
release build is signed with the debug keystore. Or that losing the Android
upload keystore means that app can never be updated again, by anyone, ever.

launchpad names the list, tells you what each item costs to ignore, and wires the
pipeline for the ones a machine can do.

---

## What it does

**Reads your repo and tells you the truth.** The readiness scorecard walks the
project and grades it against the checks that actually apply — builds somewhere
other than your laptop, signing, a distribution channel, secrets out of git,
crash reporting, a privacy policy, an icon the store will accept. Every gap says
what it means and what happens if you ignore it. Nothing is cached, so it cannot
go stale.

**Wires the pipeline.** Detects each deployable surface in the repo, then writes
the CI workflows, signing configuration, distribution and release automation for
it. Pipelines you wrote yourself are detected and left alone unless you say
otherwise — breaking the thing that already ships is the one unrecoverable
mistake available here.

**Shows all of it on one screen.** Mission Control serves on
`http://127.0.0.1:4747` — every project, what is wired, what is missing, and the
reason behind every decision launchpad made on your behalf.

**Works overnight, if you let it — as a beta.** Nightshift drains a task backlog
with Claude against your project's own check command. It is **off by default**,
opens pull requests rather than pushing to your branch, and it is **not part of
what the licence buys** — see [below](#nightshift--opt-in-beta) before turning it
on.

## What it works on

launchpad ships real pipelines for five kinds of surface:

| Surface | What gets wired |
|---|---|
| **iOS app** | build, signing, TestFlight / App Store |
| **Android app** | release signing, keystore handling, Play or Firebase App Distribution |
| **macOS app (DMG)** | signing, notarization, DMG, Sparkle auto-update, hosted downloads |
| **Web app** | Vercel deploys, preview per branch, per-app ignored build steps |
| **Static site** | Cloudflare Pages, custom domain, previews |

A repo can be several of these at once; monorepos are detected surface by
surface.

**If your project is none of them** — a Rust CLI, a Django service, a Go
daemon — launchpad says so plainly instead of pretending. There is no pipeline
for it to write, and it will tell you that rather than writing something useless.
What still works is the readiness scorecard, the dashboard and Nightshift, which
do not care what language you used. That is a real limit, and you should know it
before you buy.

## Before you install

- **Claude Code, and an Anthropic account that can use it.** launchpad is a
  plugin, not a standalone tool. It has no binary of its own and no account of
  its own — it runs inside Claude Code and uses your existing subscription. If
  you do not have Claude Code yet, start there:
  <https://claude.com/claude-code>
- **Node.js 20 or newer**, and **git**.
- Depending on what you are shipping: Xcode (iOS/macOS), the GitHub CLI (`gh`)
  for anything that touches GitHub Actions, and an Apple Developer or Google Play
  account when you get as far as a store.

## Install

```
/plugin marketplace add sidkaria/launchpad
/plugin install launchpad@launchpad
```

## First command

Open Claude Code in the repo you want to ship, and run:

```
/launchpad:onboard
```

It detects what the repo is, scores it, and walks you through what is missing.
Nothing is written to your repo before it tells you what it is about to write.

If you would rather just look first:

```
/launchpad:status
```

That prints the scorecard and changes nothing.

You talk to launchpad through Claude — the slash commands above, or just asking
("what's between this app and the App Store?"). There is no `launchpad` command
to install on your PATH.

## What costs money

**The scorecard is free, permanently, in every copy.** So are the doctor, the
status view, the dashboard and detection. Reading the truth about your own
project should not be behind a paywall — and if the list of what is missing is
not useful to you on its own, you should not buy the rest.

**$29, once**, unlocks the verbs that do the work: writing the pipelines,
managing secrets, cutting releases and wiring domains. One payment. No
subscription, no renewal, no seat count that grows.

The price rises as the product sells — $29, then $49, then $79. What you pay is
what you pay forever: **all 1.x updates are included; 2.0 is a paid upgrade,
discounted for owners.** There is no expiry and nothing to renew.

```
/launchpad:license
```

shows what is on this machine and where to buy a key; activating takes one
command after that. A key that has validated once **keeps working offline** — if
launchpad cannot reach the licence server, that is our problem and it will not
become yours.

## The source is in the box

The package you install contains the TypeScript it was built from, in
`plugins/launchpad/src/`. Read the licence check, read what gets written to your
repositories, read what leaves your machine — that is encouraged, and it is the
only honest answer for a tool that holds your signing keys.

Two things to know about it:

- **`dist/` is what actually runs.** `src/` is there to be read. Editing a `.ts`
  file changes nothing until it is compiled.
- **An update overwrites your copy.** If you change something and want to keep
  it, keep it somewhere else.

## Mission Control

```
/launchpad:dashboard
```

Serves on `http://127.0.0.1:4747`, bound to loopback. Every project you have
added, its readiness, and a Decisions view explaining why each choice was made
the way it was.

No account, no sign-in, no server of ours in the path. Your project data never
leaves your machine. launchpad makes exactly three outbound calls and you trigger
all of them: activating or re-checking your licence key, checking for a new
version when you ask it to, and listing your own Cloudflare zones when you wire a
domain. There is no telemetry.

## Nightshift — opt-in beta

An overnight worker that takes tasks from a backlog in your repo, runs Claude
against them, and gates every result on your project's own check command.

**This one is a beta, and it is the honest label rather than a modest one.** It
has never completed a full successful night end to end, and it is the only part
of launchpad that writes code to a repository while nobody is watching. It is
**off by default**, it is **not counted as part of what you paid for**, and if
you enable it you are helping test it.

Turn it on deliberately, on a repo where a bad pull request costs you nothing —
not on the app you are about to ship:

```
/launchpad:nightshift
```

## Where launchpad puts things

- `.launchpad/` in your repo — detected state, decisions, generated scripts.
  Checked in on purpose: it travels with the code and is reviewable in a diff.
- A marked block in your `CLAUDE.md`, appended between markers. Anything you
  wrote by hand is preserved byte for byte.
- `~/.launchpad/license.json` — your licence key.
- Your OS keychain — credentials. Never the repo, never a dotfile.
  Set `LAUNCHPAD_VAULT_BACKEND=file` (with `LAUNCHPAD_VAULT_PASSPHRASE`) where
  the keychain is unreachable or should not be touched — a CI runner under
  launchd, a container, a machine you share. An unknown value is an error, not
  a quiet fall back, and `file` still refuses to store anything unencrypted.

Uninstall the plugin and all of it stays behind, readable, and working without
launchpad.

## The playbook

`plugins/launchpad/PLAYBOOK.md` ships with the plugin. Every rule in it was paid
for with a failed run — why `exit 0` means *skip* in a Vercel ignored build step,
why a launchd-managed CI runner cannot reach your login keychain, why macOS CI
runners bill roughly ten times what Linux does. Read it once before you onboard
something real.

## Support and refunds

Bugs, questions and licence problems:
<https://github.com/sidkaria/launchpad/issues>

If something broke a working deploy, say so in the title — that one jumps the
queue.

**Refunds: 14 days, no questions asked.** Reply to your receipt email and say you
want it back. No justification, no form, no attempt to talk you out of it. If you
have lost the receipt, open an issue at the link above and say so — do not paste
your licence key into a public issue; the last four characters are enough to find
the purchase.

Before that is ever necessary: installing costs nothing and the scorecard is free
permanently. Run it on the app that has been sitting on your laptop and read the
list. If the free half is not useful to you, the paid half will not be either.
