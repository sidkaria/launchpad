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

---

## 5. Onboarding a repo that already ships

**Never overwrite a file you did not generate.** Most real repos already ship somehow — a hand-written Fastfile, a `./deploy` script, a legacy workflow. Treat anything without your own marker as untouchable, and *report* it rather than silently preserving it.

**When you do migrate a hand-written lane, keep both paths identical.** Preserve the original verbatim at a sibling path so the old behaviour stays diffable, then point the manual entry point at the new lane with the same environment CI uses. A manual script that keeps its own divergent copy is how "works locally, fails in CI" becomes permanent.

**A leave-alone boundary is hard.** If another system or an autonomous agent owns part of the repo, never write inside it — and make sure distribution does not fire on its commits. Validate everything, ship nothing automatically.

**Migrating distribution must not break existing installs.** An app already in the world is checking a URL you are about to move. Redirect the old feed to the new one and verify an existing install still updates *before* you consider the migration done.

**Your own generated files are not "existing pipelines".** Filing them as consolidation candidates makes setup non-idempotent on every wired repo, and the entries reappear forever.

---

## 6. Talking to users about it

**A green push is not a green build. A green build is not a delivered artifact. A delivered artifact is not a release users have.** Use the weakest true word.

**Never ship an engineering fact as a hook.** "Notarized DMG", "SHA-256 verified" — correct facts, wrong slot. Nobody buying a notch utility cares.

**Absence of complaint is a signal about awareness stage, not absent demand.** Plenty of good products serve people who never post about the problem, either because they are creators rather than forum users, or because the need has no name yet. When research returns nothing, route differently instead of inventing a complaint to fit a template.

**Ops tools never live on a product domain.** A cross-product dashboard on `approvals.yourapp.com` is a category error.
