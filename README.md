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

<!-- launchpad:platforms:start — generated from plugins/launchpad/src/platforms.ts; `npm run readme` rewrites it -->
launchpad ships real pipelines for five kinds of surface — iOS app, Android app, macOS app (DMG), Web app, Static site — built
with any of these:

| Built with | Surface | Where it ships |
|---|---|---|
| Flutter | iOS app + Android app | TestFlight and the App Store for iOS; Firebase App Distribution for Android (a Play upload is not wired — the release build is yours to upload). |
| Swift / Xcode (iOS) | iOS app | TestFlight on a push to your test branch, the App Store on a tag. |
| Swift / Xcode (macOS) | macOS app (DMG) | A signed, notarized, stapled DMG on your own download URL, with Sparkle in-app auto-update. |
| Next.js, Nuxt, SvelteKit, Astro, Remix, Angular, Qwik, SolidStart, Gatsby, Docusaurus, Vite, Create React App | Web app | Vercel |
| Hugo, Jekyll, Eleventy, MkDocs, Zola, Hand-written HTML | Static site | Cloudflare Pages |
| Android (Kotlin / Java) | Android app | Firebase App Distribution on a push, and the AAB Play wants kept on every build.<br>*Distribution needs a Firebase service account and an upload keystore. Without them the build still runs and still passes — the steps that need a credential say they were skipped rather than failing.* |
| React Native | iOS app + Android app | TestFlight and the App Store for iOS; Firebase App Distribution for Android.<br>*The Android lane has been run end to end against a real app. The iOS lane is generated and reviewed but has not been executed — that needs a macOS runner and an Apple Developer account.* |
| Expo | iOS app + Android app | TestFlight and the App Store for iOS; Firebase App Distribution for Android.<br>*This is the prebuild route, not EAS Build: no Expo account, no build quota, no third-party bill. EAS remains available to anyone who wants it, and launchpad does not set it up. Two limits said plainly: the iOS lane has not been run (that needs a macOS runner and an Apple Developer account) — its fastlane lane lives beside `app.json`, not in the `ios/` prebuild regenerates, and that layout is as unobserved as the rest of it — and if your `android/` is generated rather than committed, launchpad cannot wire release signing into it — prebuild would overwrite it — so that last step is a config plugin you add, or you commit `android/` and launchpad does it.* |

**Recognised, with no pipeline** — named, scored in its own terms, on the dashboard, and told plainly that
there is nothing for `apply` to write: Tauri desktop app, Electron desktop app, Swift package, Ruby on Rails app, Django app, Python web service, Laravel app, Phoenix app, Elixir project, Rust project, Go project, Python package, Ruby gem, .NET project, JVM project, Node CLI, Node package, Containerised service.
<!-- launchpad:platforms:end -->

A repo can be several of these at once; monorepos are detected surface by
surface. Every pipeline is a **GitHub Actions** workflow, so the repository has
to be on GitHub for it to run (a mirror is enough) — launchpad says so when it
finds a GitLab or Bitbucket remote, and the scorecard and dashboard work
either way. Android distribution is **Firebase App Distribution**; the release
build Play wants is produced and kept, and uploading it to Play is yours.

Expo builds on **your** GitHub Actions, with `npx expo prebuild --clean` — no
Expo account, no access token, and no monthly build quota. EAS Build is a fine
service and remains available to you; launchpad does not set it up, and does not
make you sign up for anything to ship.

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

Inside Claude Code:

```
/plugin marketplace add sidkaria/launchpad
/plugin install launchpad@launchpad
```

Or from a terminal, the same two steps:

```
claude plugin marketplace add sidkaria/launchpad
claude plugin install launchpad@launchpad
```

Installing costs nothing and asks for nothing. Restart Claude Code (or start a
new session) and the `/launchpad:` commands are there.

## First command

Open Claude Code in the repo you want to ship, and run:

```
/launchpad:onboard
```

It detects what the repo is, scores it, and walks you through what is missing.
Nothing is written to your repo before it tells you what it is about to write.
Run it from anywhere inside the repository — a subdirectory of a monorepo is
fine; launchpad works on the whole repository, because that is where GitHub
looks for workflows.

If you would rather just look first:

```
/launchpad:status
```

That prints the scorecard and changes nothing.

You talk to launchpad through Claude — the slash commands above, or just asking
("what's between this app and the App Store?"). There is no `launchpad` command
to install on your PATH. The one thing it asks you to type yourself — storing a
credential, so the value never passes through a chat — comes with the full
command to paste.

## What costs money

**The scorecard is free, permanently, in every copy.** So are setup, the
doctor, the status view, the "needs you" list, the dashboard, detection and the
support report. Reading the truth about your own
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

shows what is on this machine and where to buy a key. Activating is one step:
give Claude the key from your receipt email ("activate my launchpad key …"), and
it runs `license <key>`. Running it twice on the same machine does not use a
second of the key's five activations; `license deactivate` frees one when you
move to a new machine. A key that has validated once **keeps working offline** — if
launchpad cannot reach the licence server, that is our problem and it will not
become yours.

## Updating

Claude Code installs new versions; launchpad only tells you one exists.

```
claude plugin update launchpad@launchpad     # then restart Claude Code
```

`launchpad update` (free) reads the release notes and says whether the version
you have is missing a fix that matters — "this one is important, not optional"
when a release fixes a broken pipeline or a data-loss bug. It never installs
anything, and it never phones home for any other reason. All 1.x releases are
included in the price.

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
- `.github/workflows/launchpad-*.yml` — the pipelines, and nothing else under
  `.github/`.
- For a mobile app, `apply` also edits the build files a pipeline cannot work
  without, and prints every one it touches: the release signing config in
  `build.gradle`, the `fastlane/` directory, and for a Flutter app its dev/prod
  flavours (the Xcode project and schemes, `Info.plist`, the `Podfile`,
  `AndroidManifest.xml`, and a DEV-badged `AppIcon-dev` icon set copied from
  your `AppIcon` — only ever created, never overwritten). The flavour edits
  are listed before any is made, and are skipped — said once, recorded as
  `flavors: false` — for an app that already has flavours, schemes or app
  extensions of its own. A file you edited by hand is kept and reported, never
  overwritten.
- `~/.launchpad/projects.json` — the list of projects on your dashboard; paths
  only.
- `~/.launchpad/license.json` — your licence key.
- Your OS keychain — credentials — or, where there is no keychain launchpad can
  use (Windows, a container), an encrypted file, `~/.launchpad/vault.json`. Never
  the repo, never a `.env`.
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
