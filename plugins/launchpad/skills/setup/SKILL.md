---
name: setup
description: Detect this repo's deployable surfaces (macOS app, iOS app, Android app, web app, static site) and wire/refresh its launchpad deployment pipeline. Use when the user wants to set up, onboard, or re-scan a project for deployment, get it building automatically or going out to testers, add a new surface (e.g. a website) to an existing project, or asks "how do I ship this".
---

# launchpad: setup

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

Onboarding a repo is three commands and the judgement in between them:

| Command | What it does |
|---|---|
| `setup` | detect surfaces + existing pipelines, write/merge `.launchpad/state.yml`, `.launchpad/DEPLOYMENT.md`, and the managed `CLAUDE.md` block |
| *(you)* | gather each surface's `config:` into `state.yml`, and provision what needs a portal or a human |
| `apply` | write the pipeline files for every configured surface |
| `secrets` | inject that repo's required GitHub secrets from the vault |

Two more that help while working: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" detect` prints raw detection as JSON without writing anything — useful for checking what launchpad sees before committing to state — and `launchpad add` registers a finished project so it appears in `launchpad projects`.

## Step 1 — detect

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" setup
```

Read the output. It lists detected **surfaces** (with a confidence flag) and any **existing pipelines** in the repo.

**If `setup` cannot write** — an `EPERM`/`EACCES` on `.launchpad/`, a read-only
checkout, a restricted sandbox, a CI worker — that blocks *recording* the
detection, not the detection itself. Run
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" detect` instead: it prints the
same surfaces, their `framework` and their evidence as JSON and writes nothing,
so you can still answer what this repo is, what is wireable and what is refused.
Say that the state file could not be written and why, and carry on — do not
stop the conversation to have the user fix their filesystem permissions first.

**For every surface marked `[low]`, confirm the archetype with the user** ("I see an Xcode project that looks like a macOS app — correct?"). Low confidence is normal for Apple projects, where the platform is inferred from build settings. If the user corrects one, edit that surface's `archetype` in `state.yml` — see the note on hand-editing below.

**If existing pipelines were found**, ask the user for a disposition on each: **adopt**, **migrate**, or **leave-alone**, and record it in `state.yml` under that pipeline. Nothing has been changed or overwritten — see **Adopting an existing pipeline** below, which is the real behaviour and matters a lot on a repo that already ships.

Confirm what was written: `.launchpad/state.yml`, `.launchpad/DEPLOYMENT.md`, and the `<!-- launchpad:start -->` block in `CLAUDE.md`. Their own `CLAUDE.md` content outside those markers is untouched.

## Step 2 — gather config, then apply

Each archetype's section below lists the `config:` fields to gather. Then:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" apply
```

`apply` writes the workflows, Fastfiles, signing config and platform wiring for every surface that has a `config:` block, and marks it `wired`. A surface with no config is skipped with a `!` note.

## Step 3 — secrets

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secrets
```

Reads this repo's required secrets from the vault and `gh secret set`s them. Run `/launchpad:doctor` first (and again for anything it reports missing).

## On editing `.launchpad/state.yml`

The file says "do not hand-edit" because **it is not a place to invent structure** — `setup` regenerates the detected half on every run. But writing a surface's gathered `config:` block into it *is* the intended workflow, and so is recording a pipeline `disposition` or correcting a mis-detected `archetype`. What you must not do is edit the detected fields (`evidence`, `confidence`) or restructure the file, because the next `setup` will overwrite them.

Re-running `setup` **merges**: detection refreshes *what* each surface is, while each surface's gathered `config`/`status` and every pipeline disposition are preserved. `credentialsRequired` is **derived** from the surfaces, so it corrects itself. Re-running on a wired project is safe and never clobbers working config.

**`disposition` is load-bearing.** `apply` skips any surface owned by a `leave-alone` pipeline and says which pipeline stopped it — it will not wire a second pipeline beside one that already works. The mapping is only made where it is unambiguous: a `fastlane/Fastfile` owns the iOS surface in its directory (an `android/fastlane/Fastfile` owns the Android one), `vercel.json` owns the web surface, `appcast.xml` / `create-dmg.sh` own the macOS one, and a **GitHub Actions workflow owns nothing** — a workflow can build anything, so guessing would block surfaces at random. Scope is per directory, so `apps/mobile/fastlane/Fastfile` never blocks `apps/other`.

To change it, set `disposition: migrate` (or `adopt`) on that pipeline in `.launchpad/state.yml` and re-run `apply`; `setup` preserves what you set. A pipeline already present in an existing state file with **no** disposition stays undecided and is not blocked, so upgrading launchpad never stops an `apply` that was working.

`writeGuarded` (below) remains the last line of defence: it refuses to overwrite any file launchpad did not generate. The disposition is the first one — without it, the Fastfile survived but the *workflow* was still written, and a workflow calling a lane that does not exist is worse than no workflow at all.

## What runs where — macOS, Windows, Linux

**Builds happen in CI, on a runner launchpad picks.** So the developer's operating system limits what they can do *locally*, not what they can ship. `setup` prints a `!` note on any surface the current machine cannot build.

| Surface | Ships from any OS? | Local build/run | One-time setup needing a Mac |
|---|---|---|---|
| `ios` | **yes** | Mac only | **none** on the default cloud signing |
| `macos-dmg` | yes | Mac only | Developer ID cert export; Sparkle key generation |
| `android` | yes | anywhere | none |
| `web-app` | yes | anywhere | none |
| `static-site` | yes | anywhere | none |

**A Windows or Linux developer can ship an iOS app to TestFlight without owning a Mac.** On cloud signing there is no step that reads a Mac's keychain: the App Store Connect key is created in a web portal, the app record via `fastlane produce`, and the macOS runner mints the distribution certificate itself. They just can't run it in a simulator. Say this plainly rather than telling them they need a Mac — it is the single most common wrong assumption about iOS.

Opting into `match` signing *does* need a Mac once, to create the shared certificate. That is a reason to prefer cloud signing, not a reason to give up.

**Credentials are stored by the OS's own mechanism** — macOS Keychain, Secret Service (`secret-tool`) on a Linux desktop, and an AES-256-GCM encrypted file on Windows or anywhere without a keychain. The encrypted file needs `LAUNCHPAD_VAULT_PASSPHRASE` set; it will not fall back to plaintext. `doctor` prints which backend is live.

**`LAUNCHPAD_VAULT_BACKEND` overrides that choice** — `keychain`, `dpapi`, `secret-service` or `file`. An unknown value is an error, never a quiet fall back to the OS default. Reach for it where the OS keychain is unreachable or must not be touched: a self-hosted CI runner under launchd cannot open the login keychain at all (`-25308 errSecInteractionNotAllowed`), and a container or a shared machine wants its own vault rather than whoever's session it inherited. It relaxes nothing — with `file`, launchpad still refuses to store anything without a passphrase.

## Dev vs prod variants (every surface)

launchpad gives every surface a **dev** variant (local, fast, isolated) alongside the **prod** pipeline. The dev variant installs/runs next to the real app and strips prod-only gating. Mechanism per archetype:

| Surface | Dev build | Mechanism | Strips |
|---|---|---|---|
| macOS / native iOS | `xcodebuild -configuration Debug` (run locally / sim / device) | Debug-config `.dev` bundle id + "<App> Dev" name + `AppIcon-Dev` + `DEBUG` flag (via `apply` → `wireDevBuild`) | macOS: paywall + Sparkle (via `#if DEBUG`); iOS: nothing |
| web | `npm run dev` → localhost (instant, no deploy) | Vercel preview-per-branch + prod-on-main; env in `.env.development.local` | n/a |
| static site | `npx serve <siteDir>` | trunk-based preview/prod (already wired) | n/a |
| Flutter | `flutter run --flavor dev` | flavors — Android `productFlavors` + iOS `Debug/Profile/Release-<flavor>` configs & schemes (via `apply` → `wireFlutterFlavors`); see **Flutter apps** below | n/a |

Production (Release builds + the deploy pipelines) is unchanged: every dev setting lives in the Debug configuration or `#if DEBUG`, so a Release build is exactly today's output.

## Wiring a macOS app (archetype `macos-dmg`)

When `setup` detects a `macos-dmg` surface and the user wants to wire it:

1. Run `/launchpad:doctor` first — the macOS pipeline needs these global vault credentials: Developer ID cert (`DEVELOPER_ID_CERT_P12`, `DEVELOPER_ID_CERT_PASSWORD`, `DEVELOPER_ID_CERT`, `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD`, `KEYCHAIN_PASSWORD`) and Cloudflare R2 (`R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_ACCOUNT_ID`).

2. Gather the per-surface config and write it into `.launchpad/state.yml` under that surface as a `config:` block: `appName`, `scheme` (the xcodebuild scheme for this Mac app), `xcodeproj`, `r2Bucket` (default `<project>-updates`), `appcastDomain` (the R2 custom domain, e.g. `updates.<app>.com` — ask the user), `tagPrefix` (default `v`), `prebuild` (`xcodegen generate` if the repo has a gitignored xcodeproj generated from `project.yml`, else empty), and `architectures` — omit it for the default `arm64`, which is **Apple Silicon only — Intel Macs cannot run it; set `architectures: universal` to include them**. Say that sentence to the user and let them choose; do not decide it silently. `universal` builds `arm64 x86_64` (bigger DMG, and the Intel half has never been run by anyone until a user runs it), keeps the DMG name and the appcast, and fails the release if the binary is missing either architecture. Whichever it is, a landing page must not claim more than it — the release log prints `Architectures:`.

3. **Per-app Sparkle key (in-app auto-update is default-on for macOS).** Each app gets its OWN key — never reuse another app's (a shared key means whoever holds it can sign updates for both apps). **Critical:** `generate_keys` with the *default* account REUSES any existing key in the login Keychain (e.g. another app's), so you must ALWAYS scope to a per-app account with `--account <app-slug>` to force a fresh, isolated key — otherwise you silently inherit the wrong key. Steps — get `generate_keys` from Sparkle's own release tarball, **not Homebrew** (the `sparkle` cask was disabled on 2026-09-01 and no longer installs): `curl -fsSL -o /tmp/sparkle.tar.xz https://github.com/sparkle-project/Sparkle/releases/download/2.6.4/Sparkle-2.6.4.tar.xz && mkdir -p /tmp/sparkle && tar -xf /tmp/sparkle.tar.xz -C /tmp/sparkle` then run the `generate_keys` inside it (`GK=$(find /tmp/sparkle -name generate_keys -type f | head -1)`):
   - Generate the per-app key (creates it in a dedicated account; leaves other apps' keys untouched): `generate_keys --account <app-slug>`.
   - Read the public key cleanly and record it: `generate_keys --account <app-slug> -p` → put the value in `.launchpad/state.yml` under the surface `config:` as `publicEdKey`. Sanity-check it differs from any other app's key.
   - Export the private key, store it as the repo secret, delete the file: `generate_keys --account <app-slug> -x sparkle_private.pem && gh secret set SPARKLE_PRIVATE_KEY < sparkle_private.pem && rm sparkle_private.pem` (exported value is ~44 base64 chars — the Ed25519 seed).
   - Also set `appSourceDir` in the config to the app target's source dir (e.g. `apps/Sender` — where its `Info.plist` lives and where `SparkleUpdater.swift` will be compiled).
   - Note: macOS may show a Keychain "allow access" prompt for `generate_keys`/`sign_update` — click Allow. This is **dev-tooling only**; it does NOT affect end users, who download the Developer-ID-signed + **notarized** app and never see a Gatekeeper override.

4. **Wire the in-app updater.** `apply` (next step) writes `<appSourceDir>/SparkleUpdater.swift`, adds the Sparkle SPM dependency to `project.yml` (xcodegen) for the app's target, and sets the four Info.plist keys (`SUFeedURL` = `https://<appcastDomain>/appcast.xml`, `SUPublicEDKey`, `SUEnableAutomaticChecks` = true, `SUScheduledCheckInterval` = 86400). Then perform the ONE source edit `apply` can't: hook the app's `@main … : App`. Add `import Sparkle`, a stored updater, and the menu command:
    ```swift
    // in the @main App struct:
    #if !DEBUG
    private let updater = SparkleUpdater()
    #endif
    // ...and on the top-level Scene in `body`:
    #if !DEBUG
    .commands {
        CommandGroup(after: .appInfo) {
            CheckForUpdatesView(updater: updater.controller.updater)
        }
    }
    #endif
    ```
    (The `#if !DEBUG` guards keep Sparkle out of local dev builds; Release builds — what CI ships — are unaffected.)
    If the project is NOT xcodegen (no `project.yml`), instead add the Sparkle SPM package (`https://github.com/sparkle-project/Sparkle`, from 2.9.3) to the `.xcodeproj` and embed `Sparkle.framework` in the app target by hand. Confirm the entry-point file with the user before editing.

    **Verify before releasing (avoids a 10×-billed CI round-trip):** after the `@main` hook, build locally to confirm the Sparkle SPM dep resolves and the app compiles + embeds the framework: `xcodegen generate && xcodebuild -project <xcodeproj> -scheme <scheme> -configuration Debug -skipMacroValidation CODE_SIGNING_ALLOWED=NO build`, then check `Sparkle.framework` (with `Autoupdate`, `Updater.app`, `XPCServices/*.xpc`) is in the built `.app/Contents/Frameworks/` and `SUPublicEDKey`/`SUFeedURL` are baked into the built `Info.plist`. Only then bump the version and tag.

5. **Dev variant (default-on).** `apply` calls `wireDevBuild`, adding a Debug-config block to the macOS target in `project.yml` (`PRODUCT_NAME = "<App> Dev"`, `PRODUCT_BUNDLE_IDENTIFIER = <base>.dev`, `SWIFT_ACTIVE_COMPILATION_CONDITIONS = DEBUG`, and `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon-Dev` once the dev icon set exists). Generate the **DEV-badged icon** (skill step, needs `brew install librsvg`):
   - Read the canonical `design/icon.svg`; produce `design/icon-dev.svg` via the `generateDevIconSvg` helper (DEV ribbon + tint).
   - Create `<appSourceDir>/Assets.xcassets/AppIcon-Dev.appiconset/`, copy the prod `AppIcon.appiconset/Contents.json` into it (same filenames), and render the PNGs from `design/icon-dev.svg` at the same sizes as the prod set with `rsvg-convert` (macOS sender: 16/32/64/128/256/512/1024).
   - If the app has no `design/icon.svg`, copy the prod `AppIcon.appiconset` to `AppIcon-Dev.appiconset` unbadged so Debug still builds, and note the dev icon isn't badged.
   The **paywall** auto-bypasses in dev (the `LicenseGate` template is `#if DEBUG`-guarded). Build a dev app with `xcodebuild -configuration Debug …`; test the real paywall/updater locally with `-configuration Release`.

6. Provision R2 + inject secrets: `npx wrangler r2 bucket create <r2Bucket>` (idempotent), then run `launchpad secrets` — **don't hand-set them.** It reads every secret this repo needs from the vault and injects it; `--dry-run` previews. (`SPARKLE_PRIVATE_KEY` is per-app and is set during step 3, not by `secrets`.) Tell the user the one manual Cloudflare step: bind the custom domain `<appcastDomain>` to the `<r2Bucket>` bucket (Cloudflare dashboard → R2 → bucket → Settings → Custom Domains) so `https://<appcastDomain>/appcast.xml` serves publicly.

7. Write the pipeline files: `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" apply` — writes `.launchpad/macos/create-dmg.sh` and `.github/workflows/launchpad-<scheme>-macos.yml` and marks the surface `wired`. Commit them. The first `/launchpad:release` then ships. `apply` now also wires in-app auto-update for the macOS surface (writes `SparkleUpdater.swift`, the Sparkle SPM dep, and the Info.plist keys) whenever the surface config has `appSourceDir` + `publicEdKey`. After `apply`, complete the one `@main` hook from the previous step, then commit. **A new tagged release is required** for the updater (and any re-keyed appcast) to ship.

## Wiring an iOS app (archetype `ios`)

By default: push to `testBranch` → TestFlight internal; tag `<tagPrefix><version>` → App Store upload (`distributeOn` narrows this — see CI trigger policy; `.launchpad/DEPLOYMENT.md` states what is actually wired). Both build → sign → upload with fastlane in CI.

**Two App Store Connect questions to settle before the first upload** — both are facts about the app, so ask rather than decide:
- **Export compliance.** If the app uses no encryption beyond HTTPS and the OS's own APIs, set `ITSAppUsesNonExemptEncryption = NO` in its `Info.plist` and every upload answers the compliance question automatically; otherwise each build waits in App Store Connect until someone answers it by hand. Never set it for an app that ships its own cryptography — it is a legal declaration.
- **Device family.** Declaring iPad support (`TARGETED_DEVICE_FAMILY` containing `2`) means the listing owes iPad screenshots too. An iPhone-only app that set it by default can drop it and owe only the iPhone set.

**Signing modes** (`config.signing`):
- **`cloud`** (the **default** for native) — Xcode automatic signing driven by the App Store Connect API key (`-allowProvisioningUpdates`). **No certs repo, no `MATCH_*` secrets — only the ASC key** (which every iOS app needs anyway to upload). This is the zero-setup path: once the ASC key is in the vault, a new app ships to TestFlight through CI with nothing else to provision. Requires the target to use **Automatic (Xcode-managed) signing** (`CODE_SIGN_STYLE = Automatic`, the Xcode default). **The ASC API key must have the Admin role** — cloud signing *creates/manages* Certificates & Profiles, which App Manager can't do (it fails with "Cloud signing permission error / No profiles found"). Xcode mints a cloud-managed distribution cert on the runner as needed. (Match's key only *uploads*, so App Manager is fine there.)
- **`match`** (opt-in via `signing: match`; always used for **flutter**) — `fastlane match` reads one shared Apple Distribution cert + profile from a private certs repo, reused across apps. Deterministic (one cert, no cloud-cert churn) at the cost of standing up the certs repo + `MATCH_*` secrets. Flutter uses match because its `ios/ExportOptions.plist` references a named match profile. Choose match for native only if you want deterministic certs or the target uses manual signing.

**Match on a self-hosted runner.** A self-hosted macOS runner registered as a launchd service cannot reach the user's login keychain (`failed to get: -25308` = `errSecInteractionNotAllowed`), which breaks both halves of match: the keychain-backed git credential (`Error cloning certificates repo, please make sure you have read access`) and match's default `.p12` import target. The generated match-mode workflow therefore (a) creates, unlocks and search-lists a throwaway `$RUNNER_TEMP/launchpad-signing.keychain-db` before the build and deletes it in an `if: always()` step after — the same pattern the macOS Developer-ID lane already uses — passing `MATCH_KEYCHAIN_NAME`/`MATCH_KEYCHAIN_PASSWORD` (env vars match reads natively, not fastlane params), and (b) clones the certs repo over SSH with a **read-only deploy key** (`MATCH_DEPLOY_KEY` + `GIT_SSH_COMMAND`), so `MATCH_GIT_URL` is emitted in `git@host:owner/repo.git` form. Set `certsAuth: 'basic'` on the surface to fall back to the legacy `MATCH_GIT_BASIC_AUTHORIZATION` PAT over HTTPS (no SSH steps); the dedicated keychain is emitted either way. All of this is match-only — a cloud-signed workflow is unchanged.

1. **One-time global (doctor):**
   - **Always (and all you need for cloud):** `asc_api_key` (the `.p8` contents), `asc_key_id`, `asc_issuer_id` (App Store Connect API key) in the vault. **Role: Admin for cloud signing** (it manages Certificates & Profiles); App Manager is enough only for match/upload-only. Plus an Apple Distribution cert already on the account (create one in Xcode / the portal once). The key is **account-wide**, so the same one serves every app under the team.
   - **Match mode only:** a **private** GitHub repo to hold the encrypted certs (any name — `<you>-certs` is fine; it is referenced by `matchGitUrl`, not by convention). Then `match_password` (encryption passphrase); `match_keychain_password` (any passphrase — CI creates a throwaway keychain with it so match never imports into the login keychain); `match_deploy_key` (the private half of a **read-only SSH deploy key** on that repo — `ssh-keygen -t ed25519 -C certs -f ./match_key -N ''`, add `match_key.pub` under its Settings → Deploy keys **without** write access, vault the private `match_key`). Run `fastlane match appstore` once locally to generate + store the shared cert.

2. **Per-app:** gather config into `.launchpad/state.yml` under the surface as `config:` — `appName`, `framework` (`flutter` or `native`), `bundleId`, `scheme` (native only; '' for flutter), `workdir` (where `fastlane/` lives — e.g. `apps/mobile` for a Flutter monorepo, `.` for a root native app), `teamId` (**the user's own Apple Developer Team ID** — developer.apple.com → Membership, a 10-character string; every native app on one account shares it, so ask once and reuse), `testBranch` (push to it → TestFlight — **leave it out** unless the user wants a branch other than the repository's default; `setup` prints the default branch and `apply` fills it in, never a guessed `main`), `tagPrefix` (`v`), `signing` (omit for the default `cloud`; set `match` to opt a native target into the shared certs repo), `prebuild` (native only — `xcodegen generate` if the repo has a gitignored xcodeproj generated from `project.yml`, else omit; same value as the macOS surface), `matchGitUrl` (the shared certs repo — required only when `signing: match`; give the **https** URL, it is converted to the SSH form automatically), and `certsAuth` (match only; omit for the default `deploy-key`, set `basic` to keep the legacy `MATCH_GIT_BASIC_AUTHORIZATION` PAT). To stop building on every push, see **CI trigger policy** below. Ensure the app record exists in App Store Connect (create via `fastlane produce` or the portal). For **match** mode, also run `fastlane match appstore --app_identifier <bundleId>` once to create + store that app's App Store profile.

3. `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" apply` writes `fastlane/Fastfile`, `ios/ExportOptions.plist` (flutter only), and `.github/workflows/launchpad-<scheme>-ios.yml` (native — mirrors the macOS `launchpad-<scheme>-macos.yml` name; flutter uses the app name), and marks the surface wired.

4. Inject the secrets — **don't hand-type them**. Run `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secrets` (from the repo root): it reads each surface's required secrets from the Keychain vault and `gh secret set`s them into the repo. Anything not yet in the vault is listed — store it once via `/launchpad:doctor` and re-run. `--dry-run` previews without writing. For a cloud iOS surface this is just the 3 ASC secrets; the ASC key is account-wide, so once it's in the vault every future app auto-provisions.

5. Commit the generated files. Push to `testBranch` (or run the workflow manually) → TestFlight internal; tag `<tagPrefix><version>` → App Store upload (then submit for review by hand in App Store Connect). Defaulting to a `testBranch` push first lets you verify a real TestFlight transfer before promoting.

**Dev variant:** for a **native** iOS target, `apply` also runs `wireDevBuild` (Debug-config `.dev` bundle id + "<App> Dev" name + `AppIcon-Dev`), and you generate a DEV-badged `AppIcon-Dev` set the same way as macOS (iOS uses the single 1024 icon). A dev build installs on your device next to the TestFlight/App Store build. **Flutter** iOS uses flavors instead — see **Flutter apps** below. React Native and Expo get neither: `wireDevBuild` edits an xcodegen `project.yml`, and neither framework has one.

### React Native and Expo on iOS

Same fastlane lane as native — `build_app`, cloud signing by default, TestFlight
on a branch push and the App Store on a tag — with three differences, all of
them about what has to exist before Xcode can start:

- **Bare React Native: fastlane lives in `<workdir>/ios/fastlane/Fastfile`**,
  because that is where the React Native template puts it and where every RN
  repo that already has lanes keeps it. The workflow's working directory is
  `<workdir>/ios` to match.
- **Expo: fastlane lives in `<workdir>/fastlane/Fastfile`, beside `app.json` —
  never inside `ios/`.** Under Continuous Native Generation `ios/` is
  gitignored and `expo prebuild --clean` deletes and regenerates it before
  fastlane runs, so a lane inside it would be neither committed nor there.
  fastlane runs from `<workdir>` and archives `ios/<scheme>.xcworkspace`. If an
  older launchpad left a lane in `ios/fastlane/`, `apply` names it for you to
  delete. (Unobserved on a runner, like the rest of the iOS lane.)
- **The workspace, not the project.** `build_app` is given
  `workspace: "<scheme>.xcworkspace"` (`ios/<scheme>.xcworkspace` for Expo;
  override with `workspace` on the surface, always relative to `ios/`). CocoaPods writes the Pods project beside the app's; archiving the
  bare `.xcodeproj` compiles without every dependency `pod install` just
  installed.
- **Node, then pods.** The workflow installs the JS dependencies with the
  package manager your lockfile names, then runs `bundle install` +
  `bundle exec pod install` from `ios/` — React Native's own documented form.
  Bundler walks up, so it works whether the `Gemfile` is at the project root
  (current template) or in `ios/` (older, and what several real repos still
  have); with no Gemfile anywhere it falls back to a bare `pod install`.

**There is no Metro / `react-native bundle` step, on either platform, and that
is deliberate.** The Release scheme runs Xcode's own "Bundle React Native code
and images" build phase and the React Native Gradle plugin does the equivalent
on Android, so the release build produces the JS bundle itself. A separate
bundle step would either duplicate that work or leave a second bundle the build
ignores.

**Expo: `expo prebuild` in CI, not EAS Build.** launchpad generates
`npx expo prebuild --platform ios --clean --no-install` before the pod install
(and the Android equivalent in the Gradle lane). The full decision, with its
sources and its costs, is in `DECISIONS.md`; the short version to tell a user is
that their builds run on the GitHub account they already have, with no Expo
account, no access token and no monthly build quota — and that EAS remains
available if they ever want it, though launchpad does not set it up. `--clean`
is not optional: Expo documents an incremental prebuild as able to "layer
changes" and not necessarily reproduce, because some config plugins are not
idempotent. A CI checkout is fresh, so there is nothing to layer onto and
`--clean` costs nothing.

**The one Expo limit you must state, not discover.** With Continuous Native
Generation there is no `android/` in the repository, so **launchpad cannot wire
release signing** — anything written there is overwritten by the next prebuild.
`apply` says so, and the consequence is concrete: the release APK is unsigned,
and Firebase testers cannot install an unsigned APK. Two ways out, and the user
picks:

1. **Commit `android/`** (Expo's "bare" layout) and re-run `apply` — launchpad
   then injects the signing config directly, exactly as it does for React
   Native, and prebuild stops regenerating it.
2. **Add an Expo config plugin** that sets the release `signingConfig`. That is
   Expo's own mechanism for native changes that survive prebuild; launchpad does
   not write one for you.

Everything else in the Expo pipeline — the build, both artifacts, the validate
lane, the version code — works without either. Do not describe Expo as
end-to-end shipping to testers until one of the two is done.

**What you own by not using EAS**, and should say once: the signing credentials
(the ASC key, as for any iOS app) and the build number. EAS's
`appVersionSource: "remote"` is a service that only exists inside EAS; on the
prebuild route the Android version code comes from the commit count
automatically, and the iOS build number is whatever your project declares.

**Unproven, and say so if asked:** the Android half of both React Native and
Expo has been run end to end against a real app on a real runner. The iOS half
is generated and reviewed but has never been executed — that needs a macOS
runner and an Apple Developer account. Do not claim it has shipped.

## Wiring an Android app (archetype `android`)

Test channel = Firebase App Distribution (no Google Play account needed).

**Two pipelines live behind this archetype, chosen by `framework`.** Flutter
gets the fastlane lane described in step 4; `native`, `react-native` and `expo`
get the Gradle lane in step 5. Read the framework first — they share almost
nothing.

1. **One-time global (doctor):** a Firebase project + a service account with the **Firebase App Distribution Admin** role; store its JSON as `FIREBASE_SA_JSON`. Generate an upload keystore once (`keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`) and store `ANDROID_KEYSTORE_BASE64` (base64 of the .jks), `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`.

2. **Per-app:** register the Android app in Firebase (get the App ID `1:NNN:android:XXX`), create a tester group. Gather config into state: `appName`, `framework`, `workdir` (plus `testBranch` only when it is not the repository's default branch — `apply` fills the default in), `firebaseAppId`, `firebaseProjectId`, `testerGroup`. For a Flutter app also set `flavor`, `codegen`, `flutterVersion` and `dartDefines` — **matching the ios surface exactly**, since both resolve to one set of files. To stop building on every push, see **CI trigger policy** below.

3. Inject the secrets with `launchpad secrets` (not by hand). Anything missing from the vault is listed by vault key — store it via `/launchpad:doctor` and re-run.

4. **Flutter:** `apply` writes `android/fastlane/Fastfile`, `android/fastlane/Pluginfile`, `android/Gemfile`, and `.github/workflows/launchpad-<app>-android.yml`, and injects a real **release signing config** into `android/app/build.gradle[.kts]` (`wireAndroidReleaseSigning`). Commit. Push to `testBranch` (or run manually) → the APK lands in Firebase App Distribution for your tester group. (Play Store production is a later, deliberate step — see below.)

   **fastlane plugins need bundler.** `gem install fastlane-plugin-firebase_app_distribution` is **not** enough: fastlane only discovers `fastlane/Pluginfile` through bundler, so without a `Gemfile` that `eval_gemfile`s it — and a lane run under `bundle exec` — the build succeeds and then dies with `Could not find action, lane or variable 'firebase_app_distribution'` *after* paying for the whole APK build. launchpad generates both; don't hand-roll them.

5. **Native Gradle / React Native / Expo:** `apply` writes only workflows — no
   fastlane, no Ruby. `.github/workflows/launchpad-<app>-android.yml` runs
   `./gradlew <module>:assembleRelease <module>:bundleRelease` on ubuntu and
   sends the APK to Firebase with the Firebase CLI; with `validate: true` it
   also writes `launchpad-<app>-android-validate.yml`.

   Everything structural is **detected, never asked**: `gradleDir` (the
   repo-relative directory holding `gradlew` — `workdir` for a native app,
   `<workdir>/android` for React Native and Expo) and `appModule` (the module
   applying `com.android.application`, found through the version catalog if
   that is where the plugin id lives). React Native and Expo additionally
   resolve `packageManager` from `packageManager` in package.json, then the
   lockfile. Override any of them on the surface only if the detection is wrong.

   Three fields you may want to set by hand:
   - `javaVersion` — defaults to `17`, which every AGP 8.x and 9.x names as its
     minimum. Raise it only if the project already moved.
   - `nodeVersion` — React Native / Expo only; defaults to what `react-native`'s
     own `engines.node` requires. There is no `.nvmrc` in the RN template to
     read, so this is a decision rather than a lookup.
   - `validateTasks` — **the project's own gate**, if it has one (e.g.
     `'spotlessCheck :app:testProdReleaseUnitTest'`). Setting it makes the
     validate lane run exactly that, blocking. Leaving it unset gives you
     `:<module>:testDebugUnitTest` as a blocking gate plus `:<module>:lint` as
     an **advisory** step. Lint is advisory on purpose: a real run against
     Google's own `sunflower` went red on its first push with four pre-existing
     lint errors and 110 warnings — the first was a string missing its Bangla
     translation — and a gate that is red on day one for somebody else's
     backlog is a gate that gets switched off in week two, taking the unit tests
     with it. Clear the backlog (or add a `lint-baseline.xml`), then set
     `validateTasks` to make lint blocking.

   **Both artifacts, every build, and the reason is not symmetry.** Play
   requires an App Bundle from every new app, but Firebase App Distribution can
   only accept an AAB once the app is **already published in Play** and the
   Firebase app is linked to it — which a pre-launch app sending builds to
   testers is not. So the APK is what goes to testers and the AAB is kept on the
   run (with AGP's `output-metadata.json`, which records the version code that
   actually shipped) for the day the Play account is ready. **Play is a later,
   deliberate step**: $25 one-time, plus — on a personal account created after
   13 Nov 2023 — a closed test with 12 testers opted in continuously for 14
   days. Say the fortnight out loud; the fee is not the barrier.

   **The version code climbs by itself.** CI passes
   `-PlaunchpadVersionCode=$(git rev-list --count HEAD)`, and `apply` injects a
   two-line reader into `defaultConfig` that applies it. The developer's own
   `versionCode` stays in the file and stays authoritative everywhere except CI.
   Observed against `sunflower`: the project declares `versionCode = 1` and the
   built APK's `output-metadata.json` reported `2`.

   **A missing credential skips, it does not fail.** With no
   `ANDROID_KEYSTORE_BASE64` the build still runs and still passes, warns that
   it is producing an **unsigned** artifact, and the distribute step prints a
   notice and exits 0. That is deliberate: a confusing auth error at the end of
   a paid-for build is the worst possible place to learn a secret was never set.

   **Release signing is injected, not assumed.** A stock Flutter app signs
   *release* with the **debug** keystore; a native Android or React Native app
   ships with no release signing at all and hands you
   `app-release-unsigned.apk`. Same trap, different coat.
   `injectAndroidReleaseSigning` adds the `key.properties` reader +
   `signingConfigs.release` and points `buildTypes.release` at it. Three things
   it has to get right, all learned the hard way:
   - **Kotlin DSL is not Groovy, and both are wired.** The injector emits
     `create("release")` / `?.let { }` into a `.kts` and `release { }` /
     `withInputStream` into a `build.gradle`, chosen by the file's own
     extension. Do not paste one DSL's snippet into the other.
   - **Never write `java.util.Properties()` fully-qualified in a Gradle Kotlin
     script** — inside an AGP build script the bare name `java` resolves to the
     Java plugin extension, which shadows the package, and the build fails with
     "Unresolved reference: util". launchpad adds `import java.util.Properties`
     instead. Groovy needs no import at all.
   - **The signing config is applied conditionally.** A release buildType
     pointing unconditionally at a config whose `storeFile` is null fails at
     `validateSigningRelease` with "Keystore file not set for signing config
     release" — so a contributor who clones the repo and runs
     `./gradlew assembleRelease` gets a Gradle error about a file they have
     never heard of. The generated line signs when the keystore is there and
     leaves the build **unsigned** when it is not, and never falls back to the
     debug keystore.

## Flutter apps (one app, two surfaces — read this before wiring either)

A Flutter app in a monorepo produces an `ios` **and** an `android` surface pointing at the same `workdir`. They share a flavor set, a `flutterVersion`, a `codegen` command and one validate workflow, so configure them together — a mismatch between the two resolves to one file and whichever surface writes last wins.

**Flavors are a knob — `flavors: true|false` on the ios/android surface — and additive when on.** They edit native files the user wrote (the Xcode project and schemes, `Info.plist`, the `Podfile`, the Android build file and manifest), so `apply` **lists every file it is about to change before changing any**, and the default is decided from evidence and written back to `state.yml`: **on** for a fresh Flutter app with no flavours (the dev variant the product promises); **off** — said once, recorded as `flavors: false` — when the app already has flavours of its own (`productFlavors`, an Xcode configuration beyond Debug/Release/Profile, a scheme beyond `Runner`, an app-extension target, `flutter_flavorizr`, `lib/main_<flavour>.dart`); and **unchanged** for an app `apply` already wired (existing states behave exactly as before). Tell the user which it was. When off, set `flavor:` to the flavour of theirs CI should build. When on, `apply` gives the app a **dev** and a **prod** flavor:

| | dev | prod |
|---|---|---|
| app id | `<base>.dev` | `<base>` — **unchanged** |
| name | "<App> Dev" | current — unchanged (set `androidLabel` on the surface to override the prod Android launcher label; it otherwise defaults to whatever the manifest already says) |
| icon | `AppIcon-dev` (iOS: `apply` makes it — a DEV-badged copy of `AppIcon.appiconset`) / `src/dev/res` mipmaps | unchanged |
| run | `flutter run --flavor dev` | `flutter build … --flavor prod` |

- **Android** gets `flavorDimensions += "env"` + `productFlavors` in `build.gradle.kts`. Declaring product flavors **removes Gradle's default no-flavor build**, so once flavored, every build must name a flavor — set `flavor: prod` on the surface so CI does. Artifact path becomes `build/app/outputs/apk/prod/release/app-prod-release.apk`.
- **iOS** clones the Runner target's `Debug`/`Profile`/`Release` configs into `<Mode>-dev`/`<Mode>-prod` and writes shared `dev.xcscheme`/`prod.xcscheme`. This is **purely additive**: the base configs and `Runner.xcscheme` are untouched, so an existing no-flavor `flutter build ipa --release` (what a hand-written deploy script runs) keeps working byte-for-byte throughout the migration.
- The dev configs name an `AppIcon-dev` icon set, and `apply` **makes** it: a copy of `ios/Runner/Assets.xcassets/AppIcon.appiconset` with every PNG DEV-badged (the same badge as the macOS dev icon). An existing `AppIcon-dev` set — e.g. one `flutter_launcher_icons` rendered — is never touched. If there is no `AppIcon` set, the dev configs keep the prod icon and `apply` says so; never hand-point them at a set that does not exist, because `actool` then fails every dev build ("None of the input catalogs contained a matching … app icon set … named "AppIcon-dev"").
- Set `flavor` on **both** surfaces. Re-running `apply` is a no-op — every injector guards on existing state.

**Two iOS pbxproj traps**, both of which produced builds that looked fine and were not: a cloned config must be registered in **both** `XCConfigurationList`s (the PBXProject's and the target's), and the clone must be made **per list** — cloning the project-level config for the target carries the wrong `SDKROOT` along with it.

**Signing is always `match` for Flutter**, never `cloud` — Flutter's `ios/ExportOptions.plist` references a named match profile. See the iOS section for the certs repo, the deploy key, and the self-hosted-runner keychain.

**Pick the three lanes by cost, not by habit.** macOS runners bill ~10× Linux, so "build everything on every push" on a busy monorepo is a real monthly bill (≈$100/mo at ~100 mobile commits). The shape that works:

| lane | trigger | runner | ships | cost |
|---|---|---|---|---|
| validate | every push, `pathFilter`ed | `ubuntu-latest` | nothing | ~$0 |
| Android → Firebase | `schedule` (batched nightly) + `dispatch` | `ubuntu-latest` | testers | ~$0, and no-ops on a quiet night |
| iOS → TestFlight | `tag` + `dispatch` | `self-hosted` Mac if you have one | TestFlight | $0 unmetered |

A self-hosted Mac (a spare Mac mini running the runner as a launchd service) removes the macOS bill entirely — at the cost of the keychain constraints documented under **Match on a self-hosted runner**.

**Two silent Flutter release traps to check before the first Android build** (PLAYBOOK §4):
- Flutter's template declares `android.permission.INTERNET` only in `src/debug` and `src/profile`. If the app talks to any server, it must be in `android/app/src/main/AndroidManifest.xml`, or the release APK fails every request with "Failed host lookup … errno = 7" — which reads like a bad URL. The scorecard row **"The Flutter release build can reach the network"** checks this: a gap when `pubspec.yaml` depends on a networking package and the main manifest lacks the line, `?` when it cannot tell. launchpad never edits the manifest itself (DECISIONS: a warning row, never a silent edit) — show the user the one line and add it only on their yes.
- A `String.fromEnvironment('X')` the pipeline never passes returns its default without a word. `grep -rn "fromEnvironment(" lib/` and make every name found either a `dartDefines` entry (CI then fails loudly if its secret is missing) or deliberately optional.

**Third-party shader packages can block Android outright.** A Flutter package shipping `.frag` shaders is compiled for **both** backends — Impeller *and* Skia — and that compilation is driven by the **dependency's pubspec**, not by whether your code builds the widget. So a package whose shaders use SkSL-invalid constructs fails `impellerc` on Android even if every call site is behind `Platform.isIOS`, and no source-level guard can avoid it. An iOS-only app adopting Android for the first time is exactly when this surfaces. The fix is a package that ships backend-specific shader entries, or dropping it — not a platform check, and not necessarily a Flutter upgrade (verify empirically; see **Verifying**).

## Adopting an existing pipeline (never overwrite what already works)

Most real repos already ship somehow. `setup` detects five kinds and records them under `pipelines:` with a `disposition:` — `adopt`, `migrate`, or `leave-alone`. A **newly detected** pipeline defaults to `leave-alone`, and `apply` honours it: the safe default is the one that does nothing to a repository that already works.

| kind | detected from |
|---|---|
| `github-actions` | any workflow in `.github/workflows/` that launchpad did not generate |
| `fastlane` | `fastlane/Fastfile` |
| `sparkle-dmg` | `appcast.xml` or a root `create-dmg.sh` |
| `vercel` | `vercel.json` |
| `heartbeat` | a `.heartbeat/` directory (an autonomous agent owns part of this repo) |

launchpad's own `launchpad-*.yml` workflows are excluded — filing them as consolidation candidates is what once made `setup` non-idempotent on every wired repo.

**launchpad will not clobber a file it did not generate.** `writeGuarded` treats a file as launchpad's only if the basename starts with `launchpad-` or the first few lines carry a `launchpad` marker; anything else is **PRESERVED** and reported, never overwritten. This is what stops `apply` from silently destroying a Fastfile lane that a working deploy script calls.

**Migrating an adopted lane — do it so both paths stay identical.** When you do move a hand-written lane onto launchpad's:
1. Keep the original verbatim at a sibling path (e.g. `Fastfile.pre-launchpad`) so the old behaviour is recoverable and diffable.
2. Point the **manual** entry point at launchpad's lane and give it the **same env** CI uses, so a manual build and a CI build are byte-identical. A manual script that keeps its own divergent copy is how "works locally, fails in CI" becomes permanent.
3. Only then let `apply` own the file.

**A `leave-alone` pipeline is a hard boundary.** If an autonomous agent or another system owns part of the repo, record it and never write inside it. Distribution must also not fire on its commits — that is what `distributeOn` without `push` (plus `validate: true`) is for: every commit is checked, nothing auto-ships.

## CI trigger policy (mobile — all opt-in)

By default an iOS/Android surface distributes on **every push to `testBranch`** (plus tags on iOS). In a monorepo whose `testBranch` is pushed constantly — especially by an autonomous agent — that fires a mobile build on unrelated commits and auto-ships unreviewed code. These optional fields on the `ios`/`android` surface `config:` narrow it. **Omit them all and the workflow is byte-for-byte what it was**, so an already-wired app never churns.

- `runsOn` — runner label. Defaults `macos-15` (iOS) / `ubuntu-latest` (Android). Set `self-hosted` to build on your own Mac.
- `distributeOn` — which triggers the *distribution* workflow listens to, any of `push` (branch push to `testBranch`), `tag` (`<tagPrefix>*`, iOS), `dispatch` (manual), `schedule`. Defaults `['push','tag','dispatch']` (iOS) / `['push','dispatch']` (Android). Branch and tag pushes are merged into one `push:` key — two `push:` keys would be invalid YAML.
- `schedule` — cron in **UTC**, required when `distributeOn` includes `schedule` (e.g. `'0 7 * * *'`).
- `pathFilter` — repo-relative globs (e.g. `['apps/mobile/**']`). Adds `paths:` to the **push** trigger only. Note it applies to the whole `push:` event, so if you also enable `tag`, tag pushes are path-gated too — for releases that must never be filtered, use a tag-only policy (`distributeOn` without `push`).
- `validate` — `true` also emits `.github/workflows/launchpad-<app>-mobile-validate.yml`: `flutter pub get` + `analyze` + `test` on **ubuntu-latest** (≈10× cheaper than macOS), on push to `testBranch` under the path filter. It ships nothing and needs **no secrets**, so it's safe on every commit. Emitted once per Flutter app dir even when both the ios and android surface set it.
- `codegen` — command regenerating the app's **generated** dart sources (e.g. `dart run tool/gen_tokens.dart`, `dart run build_runner build --delete-conflicting-outputs`). **Required whenever the repo gitignores generated sources** — without it `flutter analyze` reports `undefined_identifier` for every generated symbol, and the *build* fails the same way. It runs in **both** the validate workflow (before `analyze`) and the distribution workflow (before the build); a codegen step that only guards validate lets a green analyze hand off to a broken build. Omit for a project with no codegen; the workflow is then byte-for-byte the pre-codegen one. Set it on whichever surface carries `validate: true` (both surfaces of one app must agree, since they resolve to one file).
- `flutterVersion` — pins CI's Flutter (e.g. `'3.41.9'`). **Set this on every Flutter surface.** Unset means `channel: stable`, which *floats*: CI silently drifts ahead of your dev machine and one day fails `analyze` on a new deprecation in code that is clean locally — a failure that looks like a lint problem and is actually a version problem. Pin it to whatever `flutter --version` says on the machine the project is developed on, and bump deliberately.
- `testArgs` — extra args for the validate lane's `flutter test` (e.g. `'--exclude-tags golden'`). **Golden/screenshot tests do not belong in the cheap CI lane**: baselines rasterised on macOS do not match a Linux runner, so every golden fails on ubuntu for reasons that say nothing about the change. Exclude them here and keep them in the local pre-push gate where they pass; CI pixel coverage, if you want it, is a separate job with Linux-authored baselines. Excluding by tag requires the tag to be registered in the app's `dart_test.yaml`.
- `dartDefines` — map of `--dart-define` name → the CI env var holding its value (e.g. `{ SUPABASE_URL: 'SUPABASE_URL' }`). Values come from repo secrets at build time and are **never** written into the repo. launchpad both passes `--dart-define=NAME=$VAR` to the build *and* exports `VAR` into the step's `env:` — a define consumed by the Fastfile but not exported is a `KeyError` that only shows up in a real run, so a test walks every `ENV.fetch` in the generated Fastfile and asserts the workflow exports it. Native iOS has no `--dart-define`; these are ignored there.

**Scheduled runs no-op on a quiet night.** With `schedule` in `distributeOn`, the job's first step after checkout (`id: changed`) diffs `pathFilter` (or `workdir`) over a **26h** window — overlapping the daily cadence so a commit can't fall between two runs — and every later step is gated on `steps.changed.outputs.run == 'true'`. Manual and tag runs always proceed. This needs `fetch-depth: 0`, which the templates already set.

The typical agent-driven monorepo shape: `distributeOn: ['schedule','tag','dispatch']` + `schedule` + `pathFilter` + `validate: true` — cheap analyze/test on every push, one batched build overnight, App Store releases on tags only.

## What launchpad recognises

`setup` reports what it found; this is what those names mean.

| Detected | Archetype(s) | Wireable today |
|---|---|---|
| Xcode / xcodegen / SwiftPM targeting macOS or iOS | `macos-dmg`, `ios` | yes |
| Flutter (`pubspec.yaml` + `ios/`/`android/`) | `ios` + `android` | yes |
| **Native Gradle Android** (an Android Gradle *application* module, no `pubspec.yaml`) | `android` | **yes — a `./gradlew` release lane** |
| **React Native** (bare) | `ios` + `android` | **yes — Gradle on Android, CocoaPods + fastlane on iOS** |
| **Expo** | `ios` + `android` | **yes — `expo prebuild` in CI, then the React Native lanes** |
| Next.js · Nuxt · SvelteKit · Astro · Remix · Angular · Qwik · SolidStart · Gatsby · Docusaurus · Vite · CRA | `web-app` | yes (all deploy identically on Vercel) |
| Hugo · Jekyll · Eleventy · MkDocs · Zola, or a bare `index.html` | `static-site` | yes |

### Read the `framework` before you describe what gets built

**Wireability is per-framework, not per-platform** — and so is the *shape* of
what gets written. Before you say one word about what will be built for an
`ios` or `android` surface, read that surface's `framework`:

| Surface | `framework` | What `apply` writes |
|---|---|---|
| `android` | `flutter` | fastlane + `flutter build apk` → Firebase |
| `android` | `native`, `react-native`, `expo` | a Gradle workflow: `./gradlew assembleRelease bundleRelease` → Firebase |
| `ios` | `flutter` | fastlane + `flutter build ipa`, match signing |
| `ios` | `native` | fastlane `build_app`, cloud signing |
| `ios` | `react-native`, `expo` | the same, plus a JS install and `bundle exec pod install` |

`launchpad detect` prints `framework` as JSON and writes nothing;
`.launchpad/state.yml` carries it on the surface once `setup` has run. **Do not
infer it from the directory layout** — an Android Gradle app and a Flutter
Android surface both look like "an Android app" from the outside, and they get
entirely different workflows.

### Refused surfaces — relay the refusal, never paper over it

**Today nothing is refused by framework.** Both refusal lists
(`ANDROID_UNSUPPORTED_FRAMEWORKS` in `archetypes/android.ts`,
`UNSUPPORTED_FRAMEWORKS` in `archetypes/ios.ts`) are **empty**: every framework
detection can name — `flutter`, `native`, `react-native`, `expo` — now has a
pipeline. The mechanism is still there, and the next framework detection learns
will land in it before its pipeline is written. If `apply` ever prints a
refusal, it reads like this, and you relay it verbatim rather than writing your
own:

> ! android: this is a native Gradle app (no Flutter), and launchpad has no
> Android pipeline that builds it. Wiring it would write a workflow that looks
> right and fails on its first build step, so it is refused rather than written.
> You still get, free and today: the readiness scorecard in Android's terms, the
> release-signing and upload-keystore guidance (losing that keystore means the
> app can never be updated again), the checklist and the dashboard.

Three failures to avoid whenever `apply` refuses anything, all of them observed
in real runs:

- **Do not ask the questions the product decides.** "Is this on GitHub?", "do
  you have a release keystore?" — those are standing rule 3, and they are
  especially wrong on a refused surface, where the answers change nothing.
- **Do not promise the pipeline.** "GitHub Actions builds a signed release APK
  on every push" is the exact sentence `apply` then refuses.
- **Do not fill the gap by hand.** Writing the workflow or the Fastfile yourself
  produces precisely the file the product declined to write, with none of the
  testing behind it. Say what is refused, say what still works, and stop.

The framework only changes the evidence string for a web app: Vercel's native git integration is the same for all of them, which is why they share one archetype.

## Wiring a web app (archetype `web-app`, Vercel)

Vercel uses native git integration (preview deploy per branch, production on the main branch) — launchpad generates no workflow; it links the project.

1. **doctor cred:** `vercel_token` in the vault.
2. Gather config into state under the surface as `config:` — `project` (Vercel project name), `rootDir` (e.g. `apps/web` for a monorepo, `.` for root), `framework`, `prodDomain` ('' until a domain is wired).
3. `apply` prints the exact commands; run them with `vercel --token "$(security find-generic-password -a vercel_token -s launchpad -w)"`: `vercel link`, set the project **Root Directory** to `rootDir`, `vercel pull` to sync env. For a custom domain, don't hand-run `vercel domains add` + click DNS — use `launchpad domains --wire <domain>`: it attaches the domain to the Vercel project and creates the DNS-only records in the matching Cloudflare zone in one step, reading both tokens from the vault. Never on `.env`. **DNS is irreversible/public — get an explicit yes first** (preview with `launchpad domains`, no `--wire`).
4. Push to the main branch → Vercel auto-deploys production; branches get preview URLs. If a Vercel project already exists, leave it and only add the missing pieces.

**In a monorepo, set an Ignored Build Step** or every commit anywhere in the repo rebuilds and redeploys the web app. Set the project's `commandForIgnoringBuildStep`:

```bash
npx turbo-ignore <the web package name> && git diff --quiet HEAD^ HEAD -- <paths the graph cannot see>
```

Two things about this are easy to get backwards, and both fail silently:
- **Vercel treats exit 0 as SKIP.** So the clauses are joined with `&&` ("everything says skip → skip"), **not** `||`. Getting this wrong either deploys always or deploys never, with no error either way.
- **`turbo-ignore` only knows the JS dependency graph.** If the web build shells out to another language — e.g. a codegen step that reads Dart design tokens from a Flutter package — those paths are invisible to it, and a token-only change ships stale. Add an explicit `git diff` clause for them.

**Verify the ignore step both ways before trusting it:** push a commit that touches only the *other* app (expect a CANCELED build) and one that touches the web app (expect a real build). A skip that is actually a misconfiguration looks exactly like a correct skip.

**Confirm the deploy by fetching the live URL, not by reading deployment state.** A "Ready" production deployment and a correct alias still return the previous page from the CDN edge for a while (`x-vercel-cache: HIT`). Fetch with a cache-busting query and grep for a string that exists **only** in the new content — a headline the old page also had will match happily and tell you nothing.

**Dev workflow:** local dev is the framework dev server — `npm run dev` (→ `localhost:3000`, hot reload, no deploy). Keep local secrets in `.env.development.local` (ensure `.env*.local` is in `.gitignore`); production env lives in Vercel (`vercel env` / dashboard), synced with `vercel pull`. Vercel gives preview deploys per branch and production on main automatically — three rungs (local dev / preview / prod) with no extra pipeline.

## Wiring a static product/landing site (archetype `static-site`, Cloudflare Pages)

The landing page is **generated from the app's own visual identity, not a generic template** — a multi-step builder. Do these in order:

1. **doctor creds:** `cloudflare_token` (Pages+DNS+Zone+R2 perms) and `cloudflare_account_id` → the workflow secrets `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID`.
2. **Domain** (see the Domains section): match → confirm → set `pagesProject` (default `<project>-site`) and the custom domain.
3. **Gather config** into `.launchpad/state.yml` under the surface as `config:` — `appName`, `siteDir` (e.g. `site` co-located in the app repo, or `.`), `productionBranch` (the branch that deploys to **production**; every *other* branch gets an automatic preview URL — **leave it out** to use the repository's default branch, which `setup` prints as `Default branch: …` and `apply` fills in; a repo on `master` or `develop` must never be told `main`), `pagesProject` (default `<project>-site`), `appcastUrl` (the macOS surface's `https://<appcastDomain>/appcast.xml`, or '' if there's no Mac app), `tagline`. Three optional fields, set when known: `siteUrl` (the public origin, e.g. `https://<domain>/` — turns on the canonical link, `og:url` and a `sitemap.xml`, all of which must be absolute), `ogImage` (the 1200×630 share image — absolute, or a path under the site resolved against `siteUrl`; a relative one is omitted, because X, Slack and iMessage do not resolve it), and `downloadUrl` (only when the Mac app's name differs from the site's `appName` — it defaults to `https://<appcastDomain>/<appName>-latest.dmg`, the stable alias the macOS release workflow publishes).

   **A generator site is built, then its output is deployed — never its source.** `apply` reads `siteDir` and recognises Jekyll, Hugo, Eleventy, MkDocs and Zola; the workflow then installs that generator's standard toolchain, runs its build, and publishes its output directory (`_site`, `public`, `site`, or whatever the generator's own config names). Versions come from the repo where it pins them (`Gemfile.lock`, `package.json` + lockfile, `requirements.txt`, `.tool-versions`, `.ruby-version`/`.python-version`/`.nvmrc`, `netlify.toml`'s `HUGO_VERSION`/`ZOLA_VERSION`); otherwise launchpad's pinned defaults (DECISIONS 2026-09-23). A Jekyll site with no `Gemfile` is built with GitHub Pages' own builder (`actions/jekyll-build-pages`). Four optional knobs, only for what detection cannot see: `generator` (`jekyll|hugo|eleventy|mkdocs|zola`, or `none` to deploy the directory as-is), `siteBuild` (a build command that replaces the generator's — e.g. a Hugo site built with `hugo --environment production`, or a hand-rolled `./build.sh` on a plain site), `outputDir` (what deploys, relative to `siteDir`), `generatorVersion` (pins Hugo/Zola/MkDocs/Eleventy when the repo does not). Tell the user which generator was found and which version it builds with. **Steps 4–6 are for a plain-HTML site only:** a generator site's pages are its generator's, so launchpad never scaffolds or themes an `index.html` into one — offer theming changes in the generator's own layouts instead.
4. **Analyze the app's identity** (the builder's first real step). Read the repo for its actual design system and voice: colors (SwiftUI `Color(...)` / hex literals / `*.colorset` accent colors), fonts (system vs custom; any serif/mono usage), the app icon (`design/*.svg`, `Assets.xcassets`), and the product voice (design specs under `docs/`, README, marketing copy — value prop, feature/benefit bullets, tone). Produce a short **design brief**: accent + background + text hexes, light/dark default, font choices (map native fonts to close web fonts), the inlineable logo SVG, the headline (value prop), subhead, 3–6 benefit bullets, and the differentiator. *(If the project has no app to theme from — a standalone marketing site — skip to step 6.)*
5. **Generate a themed `<siteDir>/index.html`** from the brief: match the palette and fonts exactly, inline the logo SVG, lead with the value prop + the key differentiator, include a feature section and a download CTA. **Every download link's `href` is `https://<appcastDomain>/<appName>-latest.dmg`** — a real download with no JavaScript, never `#` and never a version-pinned file (both were tried on shipped sites: `#` is a dead button whenever the appcast fetch is blocked, and a pinned version is stale by the next release). The page **MUST also include the appcast upgrade script**, which swaps that for the exact versioned file when it can — paste this verbatim near the end of `<body>`, replacing `APPCAST_URL_HERE` with the surface's `appcastUrl`, and give every download link `data-download` and any version label `data-version`:

    ```html
    <script>
      const APPCAST = "APPCAST_URL_HERE";
      fetch(APPCAST).then(r => { if (!r.ok) throw new Error(String(r.status)); return r.text(); }).then(xml => {
        const doc = new DOMParser().parseFromString(xml, "application/xml");
        if (doc.querySelector("parsererror")) return;
        const item = doc.querySelector("item");
        if (!item) return;
        const encs = Array.from(item.getElementsByTagName("enclosure"));
        const dmg = encs.find(e => /\.dmg(\?|$)/i.test(e.getAttribute("url") || "")) || encs[0];
        const url = dmg && dmg.getAttribute("url");
        const ver = item.getElementsByTagNameNS("*","shortVersionString")[0]?.textContent
                  || item.getElementsByTagNameNS("*","version")[0]?.textContent || "";
        if (url) document.querySelectorAll("[data-download]").forEach(a => a.href = url);
        if (ver) document.querySelectorAll("[data-version]").forEach(e => e.textContent = "v" + ver);
      }).catch(() => { /* the static href still downloads */ });
    </script>
    ```
   Write this themed page to `<siteDir>/index.html` yourself (it is NOT generated by the CLI). If `appcastUrl` is '' (no Mac app), still build a themed page but make the CTA a mailing-list/"coming soon" instead of a download.

   **Before you call the page done, check it against what shipped sites got wrong** (each line cost a real site something; PLAYBOOK §7 has the stories):
   - `<head>`: a `<title>` and `description` that state the value prop; `og:title`/`og:description`; `twitter:card`; and — only with an absolute URL behind them — `canonical`, `og:url`, `og:image` + `twitter:image`. A relative `og:image` is the same as none.
   - Add a `404.html` (with `<meta name="robots" content="noindex">`) and a `robots.txt`. Without a 404 page Cloudflare Pages answers every unknown path — `/robots.txt`, `/sitemap.xml`, typos — with the homepage and a 200. **If the site deliberately uses that fallback** for campaign paths like `/ig`, rewrite those paths explicitly before adding the 404, or they die silently.
   - Every price, the checkout URL and the trial length appear in the page, the paywall and the store — **one source**: take them from the `payments:` block in `state.yml`, never retype them. A shipped site advertised a "7-day trial" that was really the licence's offline grace period, and another advertised a price the checkout did not charge.
   - Hardware and OS claims come from the build, not from memory: the macOS release log prints `Architectures:` — do not write "Apple silicon & Intel" about an `arm64` binary.
   - Video: list the MP4/H.264 `<source>` **before** WebM (a browser takes the first type it claims and does not fall back if decoding then fails — Safari), and retry `play()` on `loadeddata` and on first tap (Low Power Mode and in-app browsers refuse autoplay).
   - Put any `prefers-reduced-motion` block **last** in the CSS; media queries add no specificity, so an earlier one is overridden by a later mobile rule.
   - External CSS/JS gets a content version in its URL (`style.css?v=<hash>`) — a zone-level browser-cache TTL will otherwise serve new HTML with last week's stylesheet. Inline CSS/JS sidesteps it.
   - A privacy page exists and is linked from the footer (the App Store listing requires its URL), plus a real `support@` address that receives mail — see Domains.
6. **Fallback (no app identity):** if there's genuinely nothing to theme from, run `apply` — into a site directory with no `index.html` yet it writes the generic scaffold: `index.html` (description + Open Graph tags, the `-latest.dmg` download href, the defensive appcast upgrade), a noindex `404.html`, `robots.txt`, and a `sitemap.xml` when `siteUrl` is set. None of these is ever regenerated, and none is ever added to a site that already has a page.
7. **Wire + deploy (trunk-based: `<productionBranch>` = production, every other branch = preview):** create the Pages project with its production branch set —
   ```bash
   npx wrangler pages project create <pagesProject> --production-branch=<productionBranch>
   ```
   If the project already exists, set/confirm its production branch via the Cloudflare API:
   ```bash
   curl -s -X PATCH "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/pages/projects/<pagesProject>" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"production_branch":"<productionBranch>"}'
   ```
   Inject the two Cloudflare secrets with `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secrets` — never by hand; then run `apply` — it writes the Pages deploy workflow (a push to `<productionBranch>` deploys to production / your domain; any other branch deploys to a throwaway preview URL) and **will not overwrite your themed `index.html`**. Commit + push → the site deploys; bind the custom domain in Cloudflare Pages → Custom Domains.

8. **R2 CORS (cross-origin appcast):** if the site is on `<domain>` but the appcast is on `updates.<domain>` (different origin), the page's `fetch` will be blocked unless the R2 bucket allows it. Set the CORS rule now:
   ```bash
   curl -s -X PUT "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/r2/buckets/<r2Bucket>/cors" \
     -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" \
     --data '{"rules":[{"allowed":{"origins":["https://<domain>","https://www.<domain>"],"methods":["GET","HEAD"]}}]}'
   ```
   Read `$CLOUDFLARE_API_TOKEN` and `$CLOUDFLARE_ACCOUNT_ID` from the vault (`security find-generic-password -a cloudflare_token -s launchpad -w` and `security find-generic-password -a cloudflare_account_id -s launchpad -w`).
   This rule names the production origins only, so **preview URLs and localhost always show the static fallback href** — which is why that href must be the `-latest.dmg` alias and not `#`. Verify CORS the way a browser sees it: `curl -sI -H "Origin: https://<domain>" https://<appcastDomain>/appcast.xml | grep -i access-control-allow-origin`.

**Dev workflow:** preview locally with `npx serve <siteDir>` (or `python3 -m http.server` in the dir) — instant, no deploy. The trunk-based split (push to the production branch → prod; other branches → preview URL) is already wired.

## Payments / licensing (Lemon Squeezy, macOS only)

**Scope guard:** Lemon Squeezy licensing targets **`macos-dmg` surfaces only**. Never add it to an iOS or App Store build — Apple requires StoreKit/IAP for digital goods; an LS checkout in an App Store build is rejected. Web subscriptions (webhooks + server entitlement) are a separate future capability.

**Strategy: activate → validate → deactivate, on the public License API.** The generated `LicenseManager.swift` activates a key once per Mac (consuming one of its seats and storing the instance id), validates that instance on later launches, and releases the seat on deactivation. All three endpoints are public: no Authorization header, no API key in the binary — shipping one is the mistake to avoid, since anyone can extract it and mint licences. (An earlier template called only `/validate`, which never consumes a seat; a shipped app's "2 devices" licence worked on unlimited Macs that way. A key stored by such a build claims its seat automatically on the next launch.)

### Step-by-step

1. **Read price + entry-point from the app's docs.** Look for a price in `docs/`, `README`, `CLAUDE.md`, or a design brief. If not found, **prompt the user**: "What price are you charging?" and "What gating model? (gate-on-launch / trial / freemium)". Record the answer before proceeding.

2. **Product setup in the Lemon Squeezy dashboard (manual — LS API cannot create products).** Tell the user:
   - Go to the LS dashboard → Products → New Product.
   - Enable **License Keys** on the product; set an activation limit (e.g. 3 devices).
   - Under the variant's "Share" link, copy the **hosted checkout URL** (looks like `https://store.lemonsqueezy.com/checkout/buy/<id>`).
   - Note the **Variant ID** (shown in the URL or variant settings), and the **store id** and **product id** (Settings → Stores, and the product's page) — they become `storeId` / `productId` below.
   - **Test mode is store-wide and its checkout URLs look exactly like live ones.** A shipped app went out with a test-mode checkout and real buyers could not pay. Before the first paid release, open the checkout URL you are about to ship in a private window with the store in live mode and buy the product once with a real card (then refund it).

3. **Capture the variant / checkout URL.** If the user has `lemonsqueezy_api_key` in the vault (`security find-generic-password -a lemonsqueezy_api_key -s launchpad -w`), use it to auto-fetch:
   ```bash
   curl -s -H "Authorization: Bearer <key>" \
     "https://api.lemonsqueezy.com/v1/variants/<variantId>" \
     | jq '.data.attributes.buy_now_url'
   ```
   If no API key is available, ask the user to paste the checkout URL from the dashboard "Share" link.

4. **Derive the theme from the app's design brief.** Apply the same identity analysis as the landing-page builder: read hex colors from SwiftUI source / `.colorset` files / design docs; identify a headline font design token (`.serif` / `.rounded` / `.monospaced` / `.default`); confirm the accent, background, and ink (text) hex values. Produce:
   - `accentHex` — primary CTA button color (no `#`)
   - `bgHex` — paywall background color (no `#`)
   - `inkHex` — primary text color (no `#`)
   - `headlineFontDesign` — SwiftUI design token string, e.g. `.serif`

5. **Build the `PaymentsConfig` and generate the licensing Swift files** into the app's licensing directory (e.g. `apps/Sender/Licensing/`):
   ```ts
   import { writePaymentsFiles } from 'launchpad/archetypes/payments';
   writePaymentsFiles(repoRoot, {
     appName, destDir, keychainAccount, graceDays,
     checkoutUrl, tagline, priceLine,
     accentHex, bgHex, inkHex, headlineFontDesign,
     trialDays, priceAmount,   // optional — omit for a plain gate-on-launch paywall; see "Free trial" below
     storeId, productId,       // strongly recommended — see "Key constraints"
   });
   ```
   `keychainAccount` defaults to `<AppName>-License`; `graceDays` defaults to 7. **`storeId`** and **`productId`** (numbers from step 2) make the manager refuse a key from any other Lemon Squeezy store or product — **without them, any valid Lemon Squeezy key for anybody's product unlocks the app**; unset or `0` means unchecked. **`trialDays`** (a positive integer, e.g. `3`) opts into a client-only free trial; omit/`0` for the plain paywall. **`priceAmount`** (e.g. `$6.99`) is the CTA price and **defaults to `priceLine`**. Without `trialDays` this writes the three files `LicenseManager.swift`, `LicenseView.swift`, `LicenseGate.swift`; with `trialDays > 0` it additionally writes `TrialManager.swift` + `TrialGateView.swift` and swaps `LicenseGate.swift` for the trial-aware variant.

6. **Wire the gate — wrap the root view in `LicenseGate`.** This is the **one place** the skill touches app source. Find the app's entry-point view (the root `WindowGroup` content) and wrap it:
   ```swift
   // Before:
   WindowGroup { ContentView() }
   // After:
   WindowGroup { LicenseGate { ContentView() } }
   ```
   Add `import SwiftUI` if missing. Confirm with the user which file is the root entry point before editing.

7. **Add the files to the Xcode target.** If the project uses XcodeGen (`project.yml`), verify the licensing directory is already listed under `sources` for the macOS target — XcodeGen picks up the whole dir automatically (any file count, so the trial files are included with no extra step). If using a plain `.xcodeproj`, instruct the user to drag all the licensing files into the Xcode project navigator under the correct target.

8. **Store config in `state.yml`.** Under the `macos-dmg` surface, add a `payments:` block with the full `PaymentsConfig` values so future skill runs can update the paywall without re-prompting.

9. **Re-release for the paywall to ship.** The paywall is only live once a new notarized DMG is distributed. After wiring, run `/launchpad:release` (or the manual release flow) to cut a new tagged build. Update the landing page price from "Free" / "Download" to the actual price.

### Free trial (optional, client-only)

Set `trialDays` (e.g. `3`) to put a **client-only** free trial in front of the paywall — no backend, no network call, **no new secret** (so `doctor`/creds are unchanged). `priceAmount` (e.g. `$6.99`) is the CTA price and **defaults to `priceLine`**.

- **Flow.** Licensed users open straight into the app (no flash — see the constraint below). While the trial is **active** and the user is unlicensed, every launch shows a **blocking `TrialGateView`**: "N days left in your free trial", a primary **"Continue to free trial"** button (enters the app for that session), a secondary "Unlock lifetime — <price>" (opens `{{CHECKOUT_URL}}`), and an "Already bought? Enter your license key" affordance. When the trial **expires**, the gate becomes the hard paywall (`LicenseView`, "Your free trial has ended").
- **Anti-reset persistence.** Trial start (+ a monotonic `lastSeen`) live in a Keychain item `<keychainAccount>-Trial` — deleting/reinstalling the `.app` does **not** clear Keychain, so a reinstall doesn't reset the trial for a normal user, and the `max(now, lastSeen)` guard blocks clock-rollback. This is the standard bar for direct-distribution Mac apps (Keychain-Access deletion / binary patching are explicitly out of scope).
- **Dev builds.** The whole gate (paywall + trial) is `#if DEBUG`-bypassed — a Debug build opens straight to `content()`. Exercise the real trial/paywall with `-configuration Release`.
- **macOS only.** Same scope guard as licensing — never wire a trial (or any LS checkout) into an iOS/App Store target; Apple requires StoreKit there.
- **Backward-compat.** With `trialDays` unset/`0` the output is **byte-for-byte** the non-trial three-file set (regression-tested) — turning trials on never changes an existing paid app until you opt in.
- **Wiring is unchanged.** The trial lives *inside* `LicenseGate`, so the only app-source edit is the same `LicenseGate { ContentView() }` wrap from step 6 — no extra `@main` hooks.

### Key constraints
- `LicenseManager.swift` ships **no Authorization header**. It seeds `isLicensed` synchronously from the stored record at launch (**optimistic cached entitlement**; a record the Keychain could not *read* counts as present, so a transient error never sends a buyer to re-activate and burn a seat), so a licensed user opens straight into the app — **no paywall flash** — then revalidates in the background.
- **Only a 5xx, a 429 or a transport failure is "offline"** (→ the grace window). Lemon Squeezy answers 4xx with a well-formed body, so those are decoded and believed. A definitive rejection puts the gate up **but keeps the key** (prefilled for a one-click retry); the key is deleted in exactly one place, an explicit deactivation.
- Keychain items are **updated in place**, never deleted and re-added — a re-add rebuilds the item's access list and throws away the user's "Always Allow".
- The activation's name in the Lemon Squeezy dashboard is the Mac's name plus a short hash of its hardware UUID, so a second activation of the same Mac after a reinstall is visibly a duplicate. **Say so on the privacy page.**
- The gate constructs neither manager in DEBUG, so a Debug build makes no network call and never starts the trial clock.
- The `gracePeriod` is configurable via `graceDays`; the default 7 days is long enough to cover a normal offline stretch (a flight, a bad week of wifi) without letting a refunded license run indefinitely. A clock set back more than a day does not extend it. **Do not describe it as a trial** anywhere a buyer reads — a shipped site advertised a "7-day free trial" that was really this.
- `LicenseGate.swift` has no template variables — it is copied verbatim (the plain gate, or the trial-aware gate when `trialDays > 0`).
- The paywall's `LicenseView.swift` "buy" button uses `{{BUY_LABEL}}` ("Buy License", or "Unlock lifetime — <price>" under a trial) → `{{CHECKOUT_URL}}`; no payment code runs in-app.

## Verifying — read `PLAYBOOK.md` before onboarding anything real

`${CLAUDE_PLUGIN_ROOT}/PLAYBOOK.md` is the canonical list of what goes wrong and how to tell success from the appearance of it. Every rule in it was paid for with a failed run. The ones that bite hardest during onboarding:

- **Xcode's query commands lie** — only `-showdestinations`, a real `archive`, or `pod install` prove a project.
- **Verify empirically, not from release notes** — a provably-included upstream fix still failed.
- **Prove the fixed point** — re-run `setup` then `apply` and expect a clean `git status` (bar any PRESERVED-file warning).
- **Check the machine before blaming the pipeline** — full disks and partial SDK installs present as bizarre toolchain errors.
- **A new archetype path has never run before it runs.** When a project is the first of its kind, budget for a run-fix-run loop and fix each finding **generically, with a test** — never patch the project.

## Domains (Cloudflare)

Before wiring a site/web custom domain, run the domain match:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" domains
```

It lists your Cloudflare zones and reports a match for the project. **If it reports a match, confirm with the user**, then wire it (Pages custom domain / the `updates.` R2 subdomain / the Vercel domain via the Cloudflare API using the vault token) and set the domain in state. **If no match**, leave the custom domain empty — defaults `<project>.pages.dev` / `<project>.vercel.app` are used — and tell the user to buy a domain on Cloudflare → Domain Registration and re-run setup. NEVER change a domain's DNS without explicit user confirmation.

**"No zones" can mean "no permission".** Cloudflare answers a zones call from a token without Zone:Read with success and an **empty list** — indistinguishable from "this account has no domains". The usual cause is the R2-only token. Before telling anyone to buy a domain, confirm the token's scopes.

**A paid app needs a support address that receives mail before launch.** The privacy page, the terms and every in-app error point at it, and refund requests are what arrive. With Cloudflare Email Routing, *enabling* routing (which writes the MX records) is a separate permission from creating routing rules, and a setup that only created rules left one app's domain with no MX at launch — refund emails bounced. Check with `dig +short MX <domain>`, then send it a test message.

## When nothing is detected

A Python API, a Go CLI, a library — these genuinely have no surface launchpad
ships a pipeline for, and `setup` says so plainly rather than reporting
"0 surfaces" and sending someone to `apply`, which would do nothing.

**Do not treat it as a detection failure to work around.** Say what the limit
is, then say what still works, because that is most of the value:

- `launchpad score` — the great majority of the checklist is archetype-agnostic
  (CI, tests, secrets hygiene, legal, landing page, support, crash reporting)
- Nightshift — the overnight worker runs on any repo that has a gate command
- The dashboard — that project sits alongside the rest

If a surface really was missed, `launchpad detect` prints exactly what was
looked for, which is the honest way to tell "unsupported" from "a bug".
