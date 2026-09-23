---
name: release
description: Ship a new version of a launchpad-managed app — bump the version, commit, and trigger the right pipeline for that surface (macOS DMG, iOS TestFlight/App Store, Android to Firebase, web, static site). Use when the user wants to release, ship, publish, or cut a new version.
---

# launchpad: release

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

## 0. Read the state first — triggers are per-surface, not universal

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" status
```

Find the target surface and read **both** its `archetype` and its `config.distributeOn`. **Never tell the user "push to `testBranch`" without checking `distributeOn` first.** The defaults are `['push','tag','dispatch']` for iOS and `['push','dispatch']` for Android, but any surface can narrow them — a cost-tuned monorepo commonly ships iOS on **tag only**, where a push to `main` ships nothing at all.

Resolve it explicitly before saying anything to the user:

| `distributeOn` contains | How this surface ships |
|---|---|
| `push` | a push to `config.testBranch` |
| `tag` | pushing an annotated tag `<tagPrefix><version>` |
| `dispatch` | `gh workflow run <workflow file>` |
| `schedule` | automatically at `config.schedule` (UTC cron), if anything under `pathFilter` changed in the last 26h |

If `pathFilter` is set, a push only triggers when a matching path changed — and because the filter applies to the whole `push:` event, tag pushes are path-gated too.

Manual trigger for any surface (the file is under `.github/workflows/launchpad-*.yml`):

```bash
gh workflow run <workflow-file> --ref <branch>
```

## 1. Bump the version

Every mobile and desktop release needs a bump. **For iOS this is mandatory, not stylistic** — TestFlight rejects any upload whose `CFBundleVersion` it has already seen for that marketing version, so re-triggering without a bump fails as a duplicate *after* paying for the whole build.

Where the version lives depends on the project:

| Project shape | Version source | Pass this path |
|---|---|---|
| xcodegen (`project.yml`) | `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` | `<path/to/project.yml>` |
| plain `.xcodeproj` | `project.pbxproj` | `<path/to/project.pbxproj>` |
| Flutter | `version: <marketing>+<build>` in `pubspec.yaml` | `<workdir>/pubspec.yaml` |

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" release <version> <path-to-version-file> <tagPrefix>
```

It bumps, commits `Release <version>`, and pushes. A non-semver version is rejected.

**Flutter bumps differently, deliberately.** The marketing half is set to your version, but the build half is **incremented, not set** — Android requires `versionCode` to be a monotonically increasing integer, and TestFlight rejects a `CFBundleVersion` it has already seen. So re-releasing the same marketing version still moves the build number, which is exactly what makes a second TestFlight upload of `1.0.0` possible. (Android's *distribution* build number comes from `git rev-list --count HEAD` in the Fastfile instead, which is why a Firebase release can read `0.1.0 (596)` while the pubspec says `0.1.0+1`.)

## 2. Trigger, per archetype

### macOS (`macos-dmg`)

Tag-driven. Ask the user for release notes, one bullet per line — **the annotated tag body becomes the appcast release notes users see in the update prompt**, so this is user-facing copy, not a commit message.

```bash
git tag -a <tagPrefix><version> -m "<notes line 1>
<notes line 2>" && git push origin <tagPrefix><version>
```

CI then: build → Developer ID sign → **notarize** → DMG → `generate_appcast` → upload to R2 → refresh `<appName>-latest.dmg` → **read `https://<appcastDomain>/appcast.xml` back and fail unless it offers this version**. Notarization dominates, ~10–20 min. Only when that last step is green is the release live for existing installs; the build log's `Architectures:` line says what the DMG runs on — check it against any hardware claim on the site. The default build is `arm64`: Apple Silicon only — Intel Macs cannot run it; `architectures: universal` on the surface includes them, and such a release fails if the binary lacks either half.

Before tagging a Mac release, three checks that each cost a shipped app a release:

- **The build number went up.** Sparkle offers an update only when `CFBundleVersion` (`CURRENT_PROJECT_VERSION`) increases; `launchpad release` bumps it together with the marketing version in the project file. A version set only in `Info.plist` is overridden by the project and never offered.
- **Every feed URL that has ever shipped still answers.** If the app's `SUFeedURL` has ever changed, each old URL must still redirect to the current appcast — `curl -sL <old-url> | grep -c "<item>"` — or the installs that carry it never update again.
- **For a risky release, update your own copy first.** The feed is global: point one installed copy at a local feed (`defaults write <bundle-id> SUFeedURL http://localhost:8787/appcast-staging.xml`), update through the real updater, then `defaults delete <bundle-id> SUFeedURL`.

### iOS (`ios`)

Two lanes; which you can use depends on `distributeOn`:

- **`beta` → TestFlight internal.** Fires on a push to `testBranch` (when `push` is enabled) or via `dispatch`. Default to this first, so the user verifies a real TestFlight transfer before submitting anything.
- **`appstore` → App Store upload, binary only.** Fires on the tag. It deliberately **does not submit for review** — the user promotes it by hand in App Store Connect.

```bash
git tag -a <tagPrefix><version> -m "<release notes>" && git push origin <tagPrefix><version>
```

~10–20 min including App Store processing; the build then appears under TestFlight → Internal Testing.

**Added a capability since the last release** (Sign in with Apple, push, iCloud — any new key in the `.entitlements`)? Enable it on the App ID in the developer portal first, and on a `match`-signed app regenerate the profile once with `fastlane match appstore --force`. CI runs `match` read-only and will otherwise reinstall the old profile, and the build dies late in `xcodebuild` with "provisioning profile … doesn't include the … entitlement".

### Android (`android`)

Ships to **Firebase App Distribution**, to the group in `config.testerGroup`. There is no tag lane. Typical config is `distributeOn: ['schedule','dispatch']`:

```bash
gh workflow run launchpad-<appName>-android.yml --ref <branch>
```

On a schedule-enabled surface it also runs itself at `config.schedule` and **no-ops on a quiet night** — the first step after checkout diffs `pathFilter` over a 26h window and gates every later step on it. Manual dispatch always proceeds.

The build number comes from `git rev-list --count HEAD`, so it is monotonic without a bump; the *marketing* version still comes from `pubspec.yaml`.

Play Store production is not wired — that's a separate, unbuilt path.

### Web app (`web-app`)

Nothing to trigger. Vercel's native git integration deploys production on a push to the main branch and gives every other branch a preview URL; launchpad generates no workflow here.

**Confirm the deploy by fetching the live URL, not by reading deployment state.** A "Ready" production deployment with the correct alias still serves the previous page from the edge for a while (`x-vercel-cache: HIT`). Fetch with a cache-busting query and grep for a string that exists **only** in the new content — a headline the old page also had will match happily and tell you nothing.

### Static site (`static-site`)

Push to `config.productionBranch` → production; any other branch → a throwaway preview URL. Same verification rule as above.

### Before the first paid release

If the app sells through a Lemon Squeezy checkout, **buy it once yourself, with a real card, from the exact checkout URL that is about to ship**, then refund it. Test-mode and live checkout URLs look identical, and a shipped app once went out with the test-mode one — real buyers could not pay. Confirm the price the checkout charges is the price the site and the paywall show.

## 3. Report honestly

Say what was triggered, roughly how long it takes, and where to look. **Do not describe a release as shipped until the pipeline has actually finished.** A green push is not a green build, a green build is not a delivered artifact, and a delivered artifact is not a release users have.
