# The launchpad playbook

Every rule here was paid for with a failed run. None of them are opinions.

The skills tell you *what to do*. This tells you *what goes wrong*, which is the part that costs money and days. Read it once before onboarding anything real; come back to it when something behaves impossibly.

---

## 1. Verifying — what actually proves a thing works

**Xcode's query commands lie.** `xcodebuild -list` and `-showBuildSettings` report success against a project whose build configurations are broken. Only `-showdestinations`, a real `archive`, or a `pod install` catch it. Two separate bugs once hid behind "verified on the real project" — if your evidence is a query command, it is not evidence.

**Verify empirically, never from release notes.** "The upstream fix is in the version we're on" is a hypothesis, not a fact. A provably-included fix still failed. Build it and look.

**Confirm a web deploy by fetching the live URL, not by reading deployment state.** A "Ready" production deployment with a correct alias still serves the previous page from the edge for a while (`x-vercel-cache: HIT`). Fetch with a cache-busting query and grep for a string that exists **only** in the new content. A headline the old page also had will match happily and tell you nothing.

**Diff the worktree, not the branch ref.** A git worktree's branch ref can sit at an old commit while all the actual work is uncommitted in the tree. Diffing the ref once produced the confident, wrong conclusion that a redesign had already shipped.

**Prove the idempotent fixed point.** After wiring, re-run `setup` then `apply` and expect `git status` to be clean. A repo that drifts on re-run will fight every future change, and you will not notice until it has fought you five times.

**Check the machine before blaming the pipeline.** Full disks, partial SDK/NDK installs and out-of-memory kills present as bizarre toolchain errors — `snapshotter exited with code -9` is a SIGKILL, not a compiler opinion. Rule the host out before rearchitecting anything.

**A new archetype path has never run before it runs.** Most bugs in any milestone come from the code path executing for the first time on a real project. When a project is the first of its kind, budget for a run-fix-run loop — and fix each finding **generically, with a test**, never by patching the project.

**A skipped check looks exactly like a passing one.** A secret-scanning step was gated on "is the tool installed?", the tool never was, and for months the gate logged `skip: not yet introduced` on every push — visually identical to a pass. Another project's gate ran its tests through a runner that was not installed, while the tests themselves never needed it. A step you depend on fails when its tool is missing; only a step you genuinely do not need yet may skip, and it says so differently from a pass.

**Read a release back from where users read it.** A green upload proves the upload. Existing installs only ever see what the public feed URL serves, so the last step of a release fetches that URL, cache-busted, and fails unless it offers the new version — an unbound custom domain, a wrong bucket and a stale edge all pass every step before it.

**Claims about hardware come from the binary.** A landing page promised "Apple silicon & Intel" for months while every DMG was arm64-only — the update feed even recorded it. `lipo -archs` on the built executable is the evidence; copy is not.

---

## 2. Cost — the decisions that show up on a bill

**macOS CI runners bill ~10× Linux.** "Build everything on every push" on a busy monorepo is a real monthly bill — roughly $100/mo at ~100 mobile commits. The shape that works:

| lane | trigger | runner | ships | cost |
|---|---|---|---|---|
| validate | every push, path-filtered | `ubuntu-latest` | nothing | ~$0 |
| Android → testers | batched nightly + dispatch | `ubuntu-latest` | testers | ~$0, no-ops on a quiet night |
| iOS → TestFlight | tag + dispatch | self-hosted Mac if you have one | TestFlight | $0 unmetered |

A spare Mac running the GitHub runner as a launchd service removes the macOS bill entirely, at the cost of the keychain constraints in §3.

**Put the cheap gate on every push and the expensive one on purpose.** Analyze and test on Linux cost nothing and catch most of it. A build that ships should be something you asked for.

**Scheduled runs must no-op on a quiet night.** Diff the path filter over a **26-hour** window — overlapping the daily cadence, so a commit can't fall between two runs — and gate every later step on it.

---

## 3. Signing and keys — the expensive traps

**Losing the Android upload keystore means that app can never be updated again.** There is no recovery, no support ticket, no appeal. Back it up somewhere that is not the machine that made it. Almost nobody knows this before it happens to them.

**A stock Flutter app signs its *release* build with the *debug* keystore.** The output looks shippable, no store will take it, and its identity silently changes per machine. Wire a real release signing config before you build anything you intend to ship.

**Never reuse one app's update-signing key for another app.** Whoever holds a Sparkle key can sign updates for that app. Generating a key with the default account silently *reuses* an existing one, so always scope to a per-app account and sanity-check that the public key actually differs.

**A launchd-managed CI runner cannot reach the login keychain.** It fails `-25308 errSecInteractionNotAllowed`, which breaks both the keychain-backed git credential and any import that targets the default keychain. Create a throwaway keychain for the build and delete it in an `if: always()` step.

**Prefer a read-only deploy key to a token.** It is scoped to one repository, it works on a self-hosted runner where a keychain-backed HTTPS credential does not, and it cannot write.

**Automatic signing will pick the wrong certificate.** `CODE_SIGN_STYLE = Automatic` with `CODE_SIGN_IDENTITY = "iPhone Developer"` picks a *development* cert out of the keychain instead of the distribution cert you carefully provisioned. Pin the identity and profile for the configuration being archived.

**An unsigned app is a blocked app.** Un-notarized on macOS is a Gatekeeper warning most users won't click through; unsigned on Windows is a SmartScreen block. Both are invisible to a first-time shipper and both cost you most of your downloads.

**Adding an Apple capability breaks the next release unless the portal moves first.** Declaring a new entitlement (Sign in with Apple, push, iCloud…) needs the capability enabled on the App ID *and* a regenerated App Store profile. A CI that runs `match` read-only keeps reinstalling the old profile, and every iOS build then dies late in `xcodebuild` with "provisioning profile … doesn't include the … entitlement" — it broke every release of one app for an hour. Enable it, run `match appstore --force` once from a machine with write access to the certificates repo, then release.

**Sparkle compares the build number, not the version users see.** It offers an update only when `CFBundleVersion` (`CURRENT_PROJECT_VERSION`) goes up. A release that bumped only the marketing version — or bumped the copy in `Info.plist`, which the project's build settings silently override — was never offered to anyone, and the app kept reporting "you have 1.0". Bump both, in the project, every release.

**A debug switch that is not compiled out ships.** A `// DEBUG:` comment is not `#if DEBUG`: three environment-variable switches shipped in every release of one app, and one made it execute a script from a user-supplied directory. A release check that greps the binary for known-bad names only catches names someone already thought of — check it against an *allowlist* of the strings a release may contain.

---

## 4. Pipelines — failure modes that look like success

**Exit 0 means SKIP in a Vercel ignored build step.** So the clauses join with `&&` ("everything says skip → skip"), **not** `||`. Getting it backwards either deploys always or deploys never, with no error either way. Verify it both directions — push a commit touching only the other app (expect CANCELED) and one touching this app (expect a real build). A skip that is actually a misconfiguration looks exactly like a correct skip.

**`turbo-ignore` only knows the JS dependency graph.** If a build shells out to another language — a codegen step reading design tokens from a Flutter package, say — those paths are invisible to it and a token-only change ships stale. Add an explicit `git diff` clause.

**A floating toolchain version drifts CI away from your machine.** `channel: stable` silently moves ahead and one day fails `analyze` on a new deprecation in code that is clean locally. It reads as a lint problem and is a version problem. Pin it, and bump deliberately.

**Match the project's own gate before loosening anything.** When a check fails in CI but passes locally, suspect the environment before the code. The project's gate may already be stricter than the pipeline's, and loosening it hides the real cause.

**Golden/screenshot tests do not belong in the cheap CI lane.** Baselines rasterised on macOS never match a Linux runner, so every golden fails for reasons that say nothing about the change. Exclude them by tag and keep them in the local pre-push gate where they pass.

**Codegen must run in every lane that compiles.** A codegen step that only guards validate lets a green analyze hand off to a broken build.

**Fastlane only discovers plugins through bundler.** `gem install fastlane-plugin-x` is not enough — without a `Gemfile` that loads the `Pluginfile`, and a lane run under `bundle exec`, the build succeeds and then dies with "Could not find action, lane or variable" *after* paying for the entire build.

**A third-party dependency's shaders compile whether or not you use them.** Shader compilation is driven by the dependency's manifest, not by whether your code builds the widget — so a platform check at the call site cannot save you. The fix is a package that ships backend-specific shaders, or dropping it.

**A package manager is not a pinned dependency.** Homebrew disabled the `sparkle` cask on 2026-09-01 for failing Gatekeeper; every release pipeline that ran `brew install sparkle` died the same morning at its second step. Fetch a tool a release depends on from its own signed release, at a pinned version, and bump it deliberately.

**A signing key passed through a temporary file can fail on a newline.** Sparkle's `generate_appcast --ed-key-file <file>` rejected a perfectly valid key with "Private key not found in the argument". `echo "$KEY" | generate_appcast --ed-key-file -` is the documented CI form, and the key never touches disk.

**Flutter's template grants the network only to debug and profile builds.** `INTERNET` is declared in `src/debug` and `src/profile`, not `src/main` — so a release APK fails every request with "Failed host lookup … errno = 7", which reads like a wrong server URL rather than a missing permission. An app that talks to a server needs it in `src/main/AndroidManifest.xml`.

**A missing compile-time define is silent.** `String.fromEnvironment` (and every `--dart-define`-style mechanism) returns the default when the value was never passed. One app's release builds booted signed-out and 401'd for weeks; another's CI builds shipped with the paywall inert because two defines existed in code and in nobody's pipeline. Read every define with a fetch that fails the build (`ENV.fetch` in a Fastfile), and grep the code for defines the pipeline does not pass.

**A host that rebuilds your environment can change the runtime under you.** A managed Python host rebuilt an app on a newer interpreter; an optional dependency with compiled code, imported at module top level, then failed to import and took the whole app down — for a feature almost nobody used. Pin the runtime version the host builds with, import heavy optional dependencies lazily, and fetch the live URL after every deploy.

**On a branch that auto-deploys, the migration ships before the code that reads it.** Code that read a new column went live ahead of the migration that added it, and a web app was down for four days. Apply the migration to production first; make the push refuse a new migration file without an explicit acknowledgement.

**A missing public env var is a 500, not a build error.** A web app's API returned 500 in production because the browser-exposed copies of two variables (`NEXT_PUBLIC_*`) were never set — an earlier doc had said never to prefix them. The build passes either way; set every key the `.env.example` lists, then hit an authenticated endpoint and expect a 401, not a 500.

**Put serverless functions next to the database.** Unpinned, a web app's functions ran in the host's default US region against a database in Australia, and every query crossed the Pacific. Pin the function region to the database's.

**When the web build cannot run your generator, commit its output and gate on no diff.** A monorepo's design tokens were generated by a Dart tool, and the web host has no Dart. The fix was to commit the generated CSS and have the local gate regenerate everything and fail on any diff — and that gate was itself silently off for weeks, because it exited early "when the tree was dirty" and the overnight agent always ran dirty.

**A build setting that names an asset is a promise the asset exists.** A Flutter dev flavour set `ASSETCATALOG_COMPILER_APPICON_NAME = AppIcon-dev`, rendering that set was a runbook step nobody knew about, and every dev iOS build died in `actool` — "None of the input catalogs contained a matching … app icon set … named "AppIcon-dev"". Whatever writes the name makes the thing, or does not write the name.

**A macOS icon set with only a 1024 entry is dropped without a word.** `actool` needs the full 16–1024 ladder for a Mac app; given a single size it builds, ships, and shows the generic icon.

---

## 5. Onboarding a repo that already ships

**Never overwrite a file you did not generate.** Most real repos already ship somehow — a hand-written Fastfile, a `./deploy` script, a legacy workflow. Treat anything without your own marker as untouchable, and *report* it rather than silently preserving it.

**When you do migrate a hand-written lane, keep both paths identical.** Preserve the original verbatim at a sibling path so the old behaviour stays diffable, then point the manual entry point at the new lane with the same environment CI uses. A manual script that keeps its own divergent copy is how "works locally, fails in CI" becomes permanent.

**A leave-alone boundary is hard.** If another system or an autonomous agent owns part of the repo, never write inside it — and make sure distribution does not fire on its commits. Validate everything, ship nothing automatically.

**Migrating distribution must not break existing installs.** An app already in the world is checking a URL you are about to move. Redirect the old feed to the new one and verify an existing install still updates *before* you consider the migration done. One app's feed URL changed four times; versions from its first year are still reachable only through two chained 301s. Keep a table of every feed URL that has ever shipped inside a binary, and check each one — following redirects, and confirming it serves the *current* appcast — before every release. Removing any link in that chain stops those users updating forever, with no error and no telemetry.

**Never hand-edit a generated appcast; fix the generator and re-release.** A hand-patched feed ended up with a doubled signature attribute.

**A fix to a generated file is a bug report.** Every hand edit found in shipped apps' launchpad-generated workflows was a field failure the template also had — and a file launchpad regenerates is exactly where a field fix gets reverted. Move it into the generator.

**Your own generated files are not "existing pipelines".** Filing them as consolidation candidates makes setup non-idempotent on every wired repo, and the entries reappear forever.

---

## 6. Talking to users about it

**A green push is not a green build. A green build is not a delivered artifact. A delivered artifact is not a release users have.** Use the weakest true word.

**Never ship an engineering fact as a hook.** "Notarized DMG", "SHA-256 verified" — correct facts, wrong slot. Nobody buying a notch utility cares.

**Every number a buyer reads has one source.** A site advertised a "7-day free trial" that was really the licence's offline grace period; another advertised a price the checkout did not charge, because the charge lives in the payment provider and the price had been typed into eight places. Price, trial length and checkout URL come from one config and are rendered everywhere else.

**Absence of complaint is a signal about awareness stage, not absent demand.** Plenty of good products serve people who never post about the problem, either because they are creators rather than forum users, or because the need has no name yet. When research returns nothing, route differently instead of inventing a complaint to fit a template.

**Ops tools never live on a product domain.** A cross-product dashboard on `approvals.yourapp.com` is a category error.

---

## 7. Product sites — what a landing page gets wrong

**The download button must work without JavaScript.** A button whose `href` is `#` and is filled in from the update feed is dead wherever that fetch fails — and it fails on every preview URL and on localhost, because the feed's CORS rule names production only. Two shipped sites each patched this by hardcoding the current DMG, and both went stale (one by two releases; the other was edited in five places per release). Publish a stable `<App>-latest.dmg` and point the `href` at it; let the script upgrade it to the exact version.

**Without a 404 page, every path exists.** Cloudflare Pages treats a site with no `404.html` as a single-page app and answers every unknown path with the homepage and a 200 — `/robots.txt`, `/sitemap.xml` and every typo, each one a duplicate homepage to a crawler. Two live sites were doing it. Ship a `noindex` 404 — but if the site deliberately uses that fallback for campaign paths (`/ig`), rewrite those paths first, or adding the 404 kills them silently.

**A relative `og:image` is no image.** X, Slack and iMessage do not resolve it; a site's shared links showed no picture for months. Canonical, `og:url` and `og:image` are absolute or absent.

**List H.264 before WebM.** A browser plays the first `<source>` whose type it claims to support and does not fall back if decoding then fails; WebM first gambled the hero video on Safari. Autoplay is a request, not a guarantee — Low Power Mode and in-app browsers refuse it — so retry `play()` on `loadeddata` and on the first tap.

**Put the reduced-motion block last.** Media queries add no specificity, so a later mobile rule overrode it and visitors with Reduce Motion on got 1,235px of blank scroll.

**Version asset URLs by content.** A zone-level browser-cache TTL served phones new HTML with a four-hour-old stylesheet. `style.css?v=<hash>` — or inline CSS — and the mismatch cannot happen.

---

## 8. Selling it — licences, checkouts, support

**Validating a licence key never consumes a seat.** A "2 devices" licence worked on unlimited Macs because the app only ever called `/validate`. Activate once per machine (store the instance id), validate that instance afterwards, deactivate to free the seat. All three calls are public — no API key belongs in the binary.

**Only the server failing is "offline".** One app treated every non-200 as "not licensed", so a payment provider's 5xx paywalled paying customers. Lemon Squeezy answers 4xx with a real body; decode it and believe it. Only a 5xx, a rate limit or a transport error falls back to the offline grace window.

**A rejection is not proof the licence is dead.** It is also what a rate limit, a stale instance or a decoder bug look like. Deleting the key on one destroys the customer's proof of purchase; drop the "recently confirmed" stamp instead, keep the key, and delete it only on an explicit deactivation. Likewise a Keychain read that *errors* is not an absent licence — one buyer re-activated the same Mac twice in three days because a transient read failure showed them the gate.

**Update Keychain items in place.** Delete-then-add rebuilds the item's access list, so the user's "Always Allow" never stuck and the password prompt came back every launch.

**Check that the key is for your product.** A licence API that validates any key from any store will unlock your app with a key for somebody else's product. Compare the response's store and product ids.

**A test-mode checkout looks exactly like a live one.** An app shipped with its test-mode checkout URL and real buyers could not pay. Before the first paid release, buy the product once, with a real card, from the URL that ships — then refund it.

**Tests never touch the real licence store.** A test's cleanup deleted its developer's own licence, twice. Point tests and debug builds at a separate store.

**A paid app needs an inbox that receives mail before launch day.** Refund requests bounced because the domain had no MX records: enabling email routing is a separate permission from creating routing rules, and the setup script printed success when the enable step had failed. `dig MX <domain>` before you publish an address. Relatedly, a Cloudflare zones call returns success with an *empty list* when the token lacks Zone:Read — which looks exactly like "no such domain".

**Test an update on your own machine before anyone else gets it.** The feed is global. Point one installed copy at a local feed (`defaults write <bundle-id> SUFeedURL http://localhost:8787/appcast-staging.xml`), install the update through the real updater, then `defaults delete` it — signed with the real update key, or the updater rightly refuses it.
