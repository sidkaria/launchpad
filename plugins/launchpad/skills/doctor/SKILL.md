---
name: doctor
description: Diagnose a launchpad problem with `launchpad report`, and check or store the credentials launchpad needs in the vault (App Store Connect key, Developer ID cert, Android keystore, Firebase, Cloudflare, Vercel). Use when the user says it's broken, it's not working, it stopped working, or just asks for help — `report` is the first move on any of those — and when they want to set up credentials, fix a missing secret, or work out why a deploy can't authenticate.
---

# launchpad: doctor

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

The vault is the OS keychain where there is one (the macOS Keychain or the Linux Secret Service, service `launchpad`) and an encrypted file otherwise (Windows, containers, or wherever `LAUNCHPAD_VAULT_BACKEND=file` is set) — `doctor`'s first line says which. Store a credential once and every project that needs it is provisioned automatically by `launchpad secrets` — no hand-typing a secret into a GitHub settings page, ever.

## 0. Before asking anyone for help, run `report`

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" report              # print it
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" report --out=launchpad-report.md
```

**This is the first thing to do when something is wrong, and the first thing to ask a user for.** One paste answers the four rounds every support thread otherwise starts with: which build and channel, which OS and tool versions, which surfaces were detected and with what evidence, and whether each required credential is actually present. It is free, it is a licensed-verb-free command, and it needs no network.

It is written to be safe to paste in **public**:

- Credentials appear **by name only** — `✓ present` or `✗ MISSING`. Never a value, never a length, never a hash. A length is a hint about the key space and buys a reader nothing.
- The licence appears as one word — `licensed` / `lapsed` / `unlicensed` — plus at most the **last four characters** of the key, exactly as `license` prints them. A key that validated once and has not been re-checked lately is `licensed`: nothing expires and nothing is withheld.
- The home directory is replaced with `~` everywhere, so no path carries the user's name.
- Git remotes are reduced to a **host**: `github.com`, not the org, the repo name or any token embedded in the URL. A private repo's name can itself be the unreleased product.
- The working tree is reported dirty-or-clean **by count**, never by filename.
- `.env` is never read at all. The strongest guarantee is not looking.
- `state.yml` is included, with anything secret-shaped or secret-named removed.

`test/report.test.ts` is the proof: it plants API-key-shaped strings, PEM blocks, a `.p8`, a base64 keystore, a `https://user:token@github.com/…` remote and a username-bearing home path, then asserts that **no eight-character run of any of them** reaches the output.

Still tell the user to read it before they paste it. A tool that says "this is safe" and is believed without checking is how the one field somebody added last week gets published.

### Reading it back: the report shows gaps, not causes

**A gap in the report is a candidate, not a diagnosis.** `report` says what is
absent — a missing `vercel_token`, no git remote, an unlicensed build. It does
not, and cannot, say what the user was doing when it stopped working. Naming the
first gap you see as the reason ("that's why your deploys are failing") is a
confident guess dressed as a finding, and if it is wrong it costs the support
round it was supposed to save.

So report it in the weakest true words — "these are the gaps I can see, any of
them could be it" — list them, and then ask **one** question, the one the report
cannot answer: *what happened when it failed?* One question after evidence is
worth ten before it. Keep it to one, and do not dress it up with a menu of
alternatives: a single question with four bracketed options reads as the
interrogation this whole section exists to avoid. Only call something *the*
cause once you have run the thing that fails and read the error.

## 1. See what's missing

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" doctor
```

The output depends on where you run it:

- **Inside a set-up repo** — checks exactly the credentials *that project* needs, derived from its surfaces, and lists any per-app secrets separately. This is the useful mode: a static-site-only repo is never asked for Apple credentials, and a cloud-signed iOS app is never asked for `match_*`.
- **Outside one** (no `.launchpad/state.yml`) — walks everything launchpad knows, grouped by the surface that needs it. `✓` = in the vault, `·` = absent and only needed if you ship that surface.

Prefer running it in the repo you're wiring. Run it bare when you want the whole picture.

## 2. Store what's missing

Walk the user through obtaining each one (they're one-time and portal-based). Then **the user stores it, in their own terminal** — the value should never pass through this conversation:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secret set <vault_key>                    # prompts; nothing shows as they paste
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secret set asc_api_key < AuthKey_XXXX.p8  # a file is piped, never pasted
base64 < upload-keystore.jks | node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secret set android_keystore_base64
```

`secret set` works on every vault backend (the old `security add-generic-password` recipe was macOS-only, and put the value on a command line where `ps` and shell history can see it). It refuses a name launchpad does not use and suggests the one that was probably meant — a value stored under a typo reads as missing forever. `CLAUDE_PLUGIN_ROOT` is not set in the user's own terminal: give them the full path, which `launchpad needs` and the dashboard's credential cards already print in runnable form.

**Never print a secret value back to the user, into the transcript, or into a file.** If they paste one into the chat anyway, do not repeat it — tell them to store it with `secret set` and to rotate it if the chat is shared. Re-run `doctor` to confirm it reads back `✓`.

## 3. Credential reference

### iOS — App Store Connect (every iOS surface needs these)

- `asc_api_key` — the **contents of the `.p8`**. App Store Connect → Users and Access → Integrations → App Store Connect API.
- `asc_key_id`, `asc_issuer_id` — shown next to the key.

**Generate the key with the Admin role.** Cloud signing *creates and manages* Certificates & Profiles, which App Manager cannot do — it fails with "Cloud signing permission error / No profiles found". App Manager is sufficient only for match or upload-only setups.

The key is **account-wide**: store it once and every future app under that team provisions itself.

### iOS — shared certs repo (only when `signing: match`)

Skip these entirely on the default cloud signing. Flutter iOS always uses match.

- `match_password` — the certs-repo encryption passphrase.
- `match_keychain_password` — any passphrase you invent. CI uses it for a throwaway keychain that match imports the signing `.p12` into, so it never touches the login keychain. A launchd-managed self-hosted runner **cannot** reach the login keychain — it fails `-25308 errSecInteractionNotAllowed` — which is why this exists.
- `match_deploy_key` — the **private half of a read-only SSH deploy key** on the private certs repo:
  ```bash
  ssh-keygen -t ed25519 -C "launchpad certs (read-only)" -f ./match_key -N ''
  ```
  Upload `match_key.pub` under that repo's Settings → Deploy keys with **"Allow write access" off**, then vault the private `match_key`.

Set up once: one private certs repo plus `fastlane match appstore` to store the team's Apple Distribution cert. Per app, `fastlane match appstore --app_identifier <bundleId>` once to create that app's profile.

*Legacy:* a surface with `certsAuth: 'basic'` uses `match_git_basic_authorization` (base64 of `x-access-token:<PAT-with-repo-read>`) instead of the deploy key. The deploy key is preferred — it is scoped to one repo and works on a self-hosted runner, where the keychain-backed HTTPS credential does not.

### macOS — Developer ID, notarization, R2

- `developer_id_cert_p12`, `developer_id_cert_password`, `developer_id_cert` — the Developer ID Application cert exported from the login keychain as base64.
- `apple_id`, `apple_team_id`, `apple_app_password` — the notarization identity. The app-specific password comes from appleid.apple.com → Sign-In and Security → App-Specific Passwords, **not** the account password.
- `keychain_password` — any passphrase; CI creates a throwaway signing keychain with it.
- `r2_access_key_id`, `r2_secret_access_key`, `r2_account_id` — Cloudflare R2 → Manage API tokens. The DMG and the appcast are published here.

### Android — Firebase App Distribution + upload keystore

- `firebase_sa_json` — a service account JSON with the **Firebase App Distribution Admin** role.
- `android_keystore_base64`, `android_keystore_password`, `android_key_alias`, `android_key_password` — the upload keystore, generated once:
  ```bash
  keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
  ```

**Tell the user to back the keystore up somewhere outside the vault.** If it is lost, that app can never be updated on Play again — there is no recovery path. This is the most expensive mistake available anywhere in this system, and almost nobody knows it before it happens.

### Static site — Cloudflare Pages

- `cloudflare_token` — dash.cloudflare.com → My Profile → API Tokens → Create Token, with **Zone:Read + Edit, DNS:Edit, Cloudflare Pages:Edit, Workers R2 Storage:Edit**. Add **Single Redirect · Edit** as well if you will migrate an app that already ships — that permission is what lets a 301 keep an old appcast URL alive so existing installs keep updating.
- `cloudflare_account_id` — any domain's Overview page → right sidebar.

### Web app — Vercel

- `vercel_token` — vercel.com → Account Settings → Tokens → Create Token.

### Not checked by `doctor` (no surface requires them)

- `lemonsqueezy_api_key` — optional; lets the payments wiring auto-fetch a variant's checkout URL instead of asking the user to paste it.

## 4. Global vs per-app

Global credentials (Apple, Cloudflare, Vercel, Android keystore, Firebase) are shared across every app and stored **un-prefixed**.

**Per-app secrets are prefixed with the app slug** — `<app>_<secret>` — so each app's keys stay separate. `SPARKLE_PRIVATE_KEY` is the one launchpad generates today; each Mac app must have its **own**, because whoever holds a Sparkle key can sign updates for that app.

```bash
security find-generic-password -a <projectSlug>_<secret> -s launchpad -w
```

## 5. Then provision the repo

Once the vault is complete, from inside the repo:

```bash
node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js" secrets
```

It reads each surface's required secrets from the vault and `gh secret set`s them into that repo. `--dry-run` previews without writing. Anything still missing is listed by vault key — store it here and re-run.

**A credential already set as a GitHub secret is not in the vault.** If a repo ships fine but `doctor` reports its credential missing, that secret was set by hand at some point. Store it in the vault anyway, or the *next* project cannot be provisioned from it.
