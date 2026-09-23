import { androidFramework, androidIsWireable } from './archetypes/android.js';
import { isWireable } from './archetypes/ios.js';
import { SECRET_CATALOGUE, PER_APP_SECRETS, vaultKeyFor } from './secrets.js';
/**
 * The four groups, in the order a person actually needs them.
 *
 * Not a severity ranking. "Blocks a release" is first because it is the only
 * group where nothing can move until it is answered; money is second because it
 * is the one the buyer explicitly asked never to have decided for him.
 */
export const NEED_GROUPS = [
    { id: 'blocks', label: 'Blocks a release' },
    { id: 'money', label: 'Costs money' },
    { id: 'irreversible', label: 'Cannot be undone' },
    { id: 'facts', label: 'Only you can answer' },
];
const GROUP_OF = {
    'paste-credential': 'blocks',
    'refused-surface': 'blocks',
    'keep-or-migrate': 'blocks',
    'decide-money': 'money',
    'store-gate': 'money',
    'acknowledge-irreversible': 'irreversible',
    'confirm': 'facts',
};
export const groupOf = (n) => GROUP_OF[n.kind];
const GROUP_RANK = { blocks: 0, money: 1, irreversible: 2, facts: 3 };
export const WHERE_TO_GET = {
    asc_api_key: {
        what: 'the contents of the App Store Connect API key `.p8`',
        where: 'App Store Connect → Users and Access → Integrations → App Store Connect API. '
            + 'Generate it with the **Admin** role: cloud signing creates and manages Certificates & Profiles, '
            + 'which App Manager cannot do — it fails with "No profiles found".',
        scope: 'account-wide',
    },
    asc_key_id: {
        what: 'the App Store Connect key id',
        where: 'Shown next to the key you just generated, in App Store Connect → Users and Access → Integrations.',
        scope: 'account-wide',
    },
    asc_issuer_id: {
        what: 'the App Store Connect issuer id',
        where: 'The same page as the key id — one issuer id covers every key on the team.',
        scope: 'account-wide',
    },
    match_password: {
        what: 'the passphrase your shared certificates repo is encrypted with',
        where: 'You chose it when you first ran `fastlane match`. Only needed on `signing: match`, which Flutter iOS always uses.',
        scope: 'account-wide',
    },
    match_keychain_password: {
        what: 'a passphrase for the throwaway keychain match imports into',
        where: 'It is not looked up anywhere — CI uses it for a throwaway keychain that match imports the signing '
            + '`.p12` into, so the login keychain is never touched. A launchd-managed self-hosted runner cannot '
            + 'reach the login keychain at all (it fails `-25308`), which is why this exists.',
        scope: 'account-wide',
    },
    match_deploy_key: {
        what: 'the private half of a read-only SSH deploy key on the certificates repo',
        where: '`ssh-keygen -t ed25519 -C "launchpad certs (read-only)" -f ./match_key -N \'\'`, then add '
            + '`match_key.pub` under that repo\'s Settings → Deploy keys with **"Allow write access" off**.',
        scope: 'account-wide',
    },
    developer_id_cert_p12: {
        what: 'your Developer ID Application certificate, exported as base64',
        where: 'Keychain Access → export the "Developer ID Application" certificate as a `.p12`, then `base64 -i cert.p12`.',
        scope: 'account-wide',
    },
    developer_id_cert_password: {
        what: 'the passphrase you set when exporting that `.p12`',
        where: 'Keychain Access asks for it during the export. It is yours to choose; nothing else knows it.',
        scope: 'account-wide',
    },
    developer_id_cert: {
        what: 'the Developer ID certificate itself, base64',
        where: 'The same export as above — the certificate without its private key.',
        scope: 'account-wide',
    },
    apple_id: {
        what: 'the Apple ID that notarizes builds',
        where: 'The email address you sign in to developer.apple.com with.',
        scope: 'account-wide',
    },
    apple_team_id: {
        what: 'your ten-character Apple team id',
        where: 'developer.apple.com → Membership details. It is the same for every app on the team.',
        scope: 'account-wide',
    },
    apple_app_password: {
        what: 'an app-specific password for notarization',
        where: 'appleid.apple.com → Sign-In and Security → App-Specific Passwords. **Not** your account password — '
            + 'notarization rejects that one.',
        scope: 'account-wide',
    },
    keychain_password: {
        what: 'a passphrase for the throwaway signing keychain CI creates',
        where: 'CI creates a throwaway signing keychain with it. Nothing else reads it.',
        scope: 'account-wide',
    },
    r2_access_key_id: {
        what: 'a Cloudflare R2 access key id',
        where: 'dash.cloudflare.com → R2 → Manage API tokens → Create API token, with object read and write.',
        scope: 'account-wide',
    },
    r2_secret_access_key: {
        what: 'the secret half of that R2 token',
        where: 'Shown once, on the screen that creates the token. Cloudflare will not show it again.',
        scope: 'account-wide',
    },
    r2_account_id: {
        what: 'your Cloudflare account id, for R2',
        where: 'Any domain\'s Overview page → the right-hand sidebar. It is the same id as `cloudflare_account_id`; R2 reads it under its own name.',
        scope: 'account-wide',
    },
    firebase_sa_json: {
        what: 'a Firebase service account JSON',
        where: 'console.firebase.google.com → Project settings → Service accounts → Generate new private key. '
            + 'It needs the **Firebase App Distribution Admin** role.',
        scope: 'account-wide',
    },
    android_keystore_base64: {
        what: 'your Android upload keystore, base64',
        where: '`keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload`, '
            + 'then `base64 -i upload-keystore.jks`. **Back the keystore up somewhere that is not this machine** — '
            + 'lose it and this app can never be updated on Play again.',
        scope: 'account-wide',
    },
    android_keystore_password: {
        what: 'the keystore passphrase',
        where: '`keytool` asks for it when it generates the keystore.',
        scope: 'account-wide',
    },
    android_key_alias: {
        what: 'the key alias inside the keystore',
        where: '`upload`, if you used the command above.',
        scope: 'account-wide',
    },
    android_key_password: {
        what: 'the passphrase on the key inside the keystore',
        where: '`keytool` asks for this one second; it is often the same as the keystore passphrase.',
        scope: 'account-wide',
    },
    cloudflare_token: {
        what: 'a Cloudflare API token',
        where: 'dash.cloudflare.com → My Profile → API Tokens → Create Token, with **Zone:Read + Edit, DNS:Edit, '
            + 'Cloudflare Pages:Edit, Workers R2 Storage:Edit**. Add **Single Redirect · Edit** too if you will '
            + 'migrate an app that already ships.',
        scope: 'account-wide',
    },
    cloudflare_account_id: {
        what: 'your Cloudflare account id',
        where: 'Any domain\'s Overview page → the right-hand sidebar. The same id the R2 credentials use.',
        scope: 'account-wide',
    },
    vercel_token: {
        what: 'a Vercel API token',
        where: 'vercel.com → Account Settings → Tokens → Create Token.',
        scope: 'account-wide',
    },
    sparkle_private_key: {
        what: 'this app\'s own Sparkle signing key',
        where: '`/launchpad:setup` generates it — one per app, because whoever holds it can sign updates '
            + 'for that app. It is never shared between two of yours.',
        scope: 'per-app',
    },
};
export const CREDENTIAL_SETS = [
    {
        id: 'asc',
        title: 'App Store Connect API key',
        keys: ['asc_api_key', 'asc_key_id', 'asc_issuer_id'],
        where: 'App Store Connect → Users and Access → Integrations → App Store Connect API → generate a key. '
            + 'Give it the **Admin** role: cloud signing creates and manages Certificates & Profiles, which App '
            + 'Manager cannot do — it fails with "No profiles found". The key id and the issuer id are on that '
            + 'same page, beside the key you just made.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Any iOS build reaching TestFlight. It is also what lets you ship an iOS app without owning a Mac.',
    },
    {
        id: 'match',
        title: 'Shared certificates repo',
        keys: ['match_password', 'match_keychain_password', 'match_deploy_key'],
        where: 'Only on `signing: match`, which Flutter iOS always uses. The passphrase is the one you chose when '
            + 'you first ran `fastlane match`; the keychain passphrase is anything you invent, for a throwaway '
            + 'keychain CI imports the signing `.p12` into. For the deploy key: `ssh-keygen -t ed25519 -C '
            + '"launchpad certs (read-only)" -f ./match_key -N \'\'`, add `match_key.pub` under that repo\'s '
            + 'Settings → Deploy keys with **"Allow write access" off**, and store the private half.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'An iOS build signed from your own certificates repo.',
    },
    {
        id: 'developer-id',
        title: 'Developer ID certificate, for signing Mac apps',
        keys: ['developer_id_cert_p12', 'developer_id_cert_password', 'developer_id_cert', 'keychain_password'],
        where: 'Keychain Access → export the "Developer ID Application" certificate as a `.p12` with a passphrase '
            + 'you choose, then `base64 -i cert.p12`. The last one is any passphrase you invent, for the throwaway '
            + 'signing keychain CI creates — nothing else reads it.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Signing the Mac app. An unsigned one shows a Gatekeeper warning most people will not click through.',
    },
    {
        id: 'apple-notarization',
        title: 'Apple ID and an app-specific password, for notarization',
        keys: ['apple_id', 'apple_team_id', 'apple_app_password'],
        where: 'The Apple ID is the address you sign in to developer.apple.com with, and the team id is on its '
            + 'Membership details page. The password comes from appleid.apple.com → Sign-In and Security → '
            + 'App-Specific Passwords — **not** your account password, which notarization rejects.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Notarizing the Mac app, which is what stops Gatekeeper warning about it.',
    },
    {
        id: 'android-keystore',
        title: 'Android upload keystore — launchpad generates this one',
        keys: ['android_keystore_base64', 'android_keystore_password', 'android_key_alias', 'android_key_password'],
        where: '`/launchpad:setup` generates it, and all four values come out of that one act. To make one '
            + 'by hand instead: `keytool -genkey -v -keystore upload-keystore.jks -keyalg RSA -keysize 2048 '
            + '-validity 10000 -alias upload`, then `base64 -i upload-keystore.jks` — the alias is `upload`, and '
            + '`keytool` asks for the two passphrases as it goes.',
        scope: 'account-wide',
        origin: 'generated-by-launchpad',
        blocks: 'The first Android build a store will accept. A stock release build is signed with the DEBUG '
            + 'keystore: it looks shippable, and no store will take it.',
        warning: 'Back the keystore file up somewhere that is not this machine, as soon as it exists. If it is '
            + 'lost, this app can never be updated again — there is no recovery path, from anybody. It is the most '
            + 'expensive mistake available anywhere in this system and almost nobody knows about it beforehand.',
    },
    {
        id: 'firebase',
        title: 'Firebase service account key',
        keys: ['firebase_sa_json'],
        where: 'console.firebase.google.com → Project settings → Service accounts → Generate new private key. '
            + 'It needs the **Firebase App Distribution Admin** role.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Getting an Android build in front of real testers without a Play account.',
    },
    {
        id: 'cloudflare',
        title: 'Cloudflare API token',
        keys: ['cloudflare_token', 'cloudflare_account_id'],
        where: 'dash.cloudflare.com → My Profile → API Tokens → Create Token, with **Zone:Read + Edit, DNS:Edit, '
            + 'Cloudflare Pages:Edit, Workers R2 Storage:Edit**. Add **Single Redirect · Edit** too if you will '
            + 'migrate an app that already ships. The account id is on any domain\'s Overview page, in the '
            + 'right-hand sidebar.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Deploying the site to Cloudflare Pages, and pointing a domain at it.',
    },
    {
        id: 'r2',
        title: 'Cloudflare R2 token, where downloads are published',
        keys: ['r2_access_key_id', 'r2_secret_access_key', 'r2_account_id'],
        where: 'dash.cloudflare.com → R2 → Manage API tokens → Create API token, with object read and write. The '
            + 'secret half is shown once, on the screen that creates it, and Cloudflare will not show it again. '
            + 'The account id is the same one the API token above uses; R2 just reads it under its own name.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Publishing the DMG and its appcast, which is how a Mac app is downloaded and how it updates.',
    },
    {
        id: 'vercel',
        title: 'Vercel API token',
        keys: ['vercel_token'],
        where: 'vercel.com → Account Settings → Tokens → Create Token.',
        scope: 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Provisioning the web app\'s repository, so a push deploys it.',
    },
    {
        id: 'sparkle',
        title: 'Sparkle signing key — launchpad generates one per app',
        keys: ['sparkle_private_key'],
        where: '`/launchpad:setup` generates it. One per app, because whoever holds it can sign updates for '
            + 'that app — it is never shared between two of yours.',
        scope: 'per-app',
        origin: 'generated-by-launchpad',
        blocks: 'Shipping an update to people who already installed the Mac app. Ship one with no updater and '
            + 'every user is frozen on the version they downloaded.',
    },
];
const SET_OF = new Map(CREDENTIAL_SETS.flatMap(s => s.keys.map(k => [k, s])));
/**
 * The set a key belongs to, or a set of one built from what is known about it.
 *
 * The fallback is what stops a credential added by another branch from vanishing
 * off the strip while the grouping catches up. It is deliberately a card rather
 * than a silent omission — a missing credential that nothing mentions is the
 * failure this whole feature exists to end.
 */
export function setFor(vaultKey) {
    const known = SET_OF.get(vaultKey);
    if (known)
        return known;
    const g = WHERE_TO_GET[vaultKey];
    return {
        id: `key-${vaultKey}`,
        title: g ? g.what.replace(/^(the|a|an|your) /i, m => m[0].toUpperCase() + m.slice(1)) : vaultKey,
        keys: [vaultKey],
        where: g ? g.where : `${catalogueLabel(vaultKey)}. \`/launchpad:doctor\` names exactly where to get this one and what role it needs.`,
        scope: g?.scope ?? 'account-wide',
        origin: 'fetched-by-user',
        blocks: 'Any build that has to authenticate with this — `launchpad secrets` cannot provision a repository '
            + 'until it is in the vault.',
    };
}
/** The catalogue's own group label, as the fallback description of a key. */
function catalogueLabel(vaultKey) {
    for (const g of SECRET_CATALOGUE) {
        if (g.secrets.some(s => vaultKeyFor(s) === vaultKey))
            return g.label;
    }
    if (PER_APP_SECRETS.some(s => vaultKeyFor(s) === vaultKey))
        return 'A per-app credential';
    return 'A credential launchpad needs';
}
/** The GitHub secret name a vault key came from, for the card's second line. */
function secretNameFor(vaultKey) {
    for (const g of SECRET_CATALOGUE) {
        const hit = g.secrets.find(s => vaultKeyFor(s) === vaultKey);
        if (hit)
            return hit;
    }
    const perApp = PER_APP_SECRETS.find(s => vaultKeyFor(s) === vaultKey);
    return perApp ?? vaultKey.toUpperCase();
}
// ─────────────────────────────────────────────────────────────────────────────
// Building the list
// ─────────────────────────────────────────────────────────────────────────────
const surfaceLabel = (s) => `${{ 'ios': 'iOS', 'android': 'Android', 'macos-dmg': 'macOS', 'web-app': 'Web', 'static-site': 'Site' }[s.archetype]} · ${s.id}`;
const domainOf = (s) => {
    const c = (s.config ?? {});
    const d = c.prodDomain ?? c.appcastDomain;
    return typeof d === 'string' && d ? d : undefined;
};
/** Refused by `apply`, read off the archetypes rather than restated here. */
export function refusedFramework(s) {
    if (s.archetype === 'android') {
        const f = androidFramework(s.config, s);
        return androidIsWireable(f) ? null : f;
    }
    if (s.archetype === 'ios') {
        const f = s.config?.framework ?? s.framework;
        return f && !isWireable(f) ? f : null;
    }
    return null;
}
const FRAMEWORK_PHRASE = {
    'native': 'a native Gradle app, with no Flutter in it',
    'react-native': 'a React Native app',
    'expo': 'an Expo app',
};
/** Whether this project takes money, as the scorecard grades it. Never a guess. */
const isMonetized = (p) => p.score?.checks.some(c => c.id === 'monetization' && c.grade === 'ok') ?? false;
function needsForProject(p) {
    const out = [];
    const st = p.state ?? undefined;
    /**
     * A FRESH `projects` array per item, which is why this is a getter and not a
     * constant. Spreading a shared object copies the array by reference, so the
     * account-wide merge below — which pushes onto `projects` — pushed onto every
     * item this project had raised. Nine credentials all claimed to be wanted by
     * nine projects, on a fleet of five.
     */
    const base = () => ({ project: p.label, projectPath: p.path, projects: [{ label: p.label, path: p.path }] });
    /**
     * ── credentials, one card per act ─────────────────────────────────────────
     *
     * The key list is the Keys tab's own — `requiredVaultKeys(state)` — so a
     * surface `apply` refuses contributes nothing here, because it consumes
     * nothing. That exclusion is `secrets.ts`'s, not a second opinion about it.
     *
     * What this loop adds is the grouping: the keys are bucketed into the act that
     * produces them, and a set with at least one key missing raises exactly one
     * card. A set whose keys are all present raises none — it is finished, and the
     * partial count is only interesting while there is something left to do.
     */
    const bySet = new Map();
    for (const s of p.secrets ?? []) {
        const set = setFor(s.key);
        const bucket = bySet.get(set.id) ?? { set, keys: [] };
        bucket.keys.push({ key: s.key, present: s.present });
        bySet.set(set.id, bucket);
    }
    for (const { set, keys } of bySet.values()) {
        const missing = keys.filter(k => !k.present);
        if (!missing.length)
            continue;
        // Listed in the set's own order, not the vault's alphabetical one: they come
        // out of the portal in a sequence, and that is the sequence to store them in.
        const ordered = [...keys].sort((a, b) => set.keys.indexOf(a.key) - set.keys.indexOf(b.key));
        const generated = set.origin === 'generated-by-launchpad';
        out.push({
            ...base(),
            id: `cred:${set.id}`,
            kind: 'paste-credential',
            accountWide: set.scope === 'account-wide',
            title: set.title,
            why: `${set.where}${generated
                ? ' What it needs from you is somewhere safe to keep the result.'
                : ''} Store ${keys.length === 1 ? 'it' : 'them'} once and every project that needs `
                // "your OS keychain" was false on every file vault, and "never reads the
                // value back" was false outright — `secrets` has to read it to push it.
                + `${keys.length === 1 ? 'it' : 'them'}, now or later, is provisioned automatically — launchpad keeps `
                + `${keys.length === 1 ? 'it' : 'them'} in your vault and copies ${keys.length === 1 ? 'it' : 'them'} `
                + 'into GitHub\'s secrets for you, and never shows the value.',
            blocks: set.blocks,
            ...(set.warning ? { warning: set.warning } : {}),
            action: {
                type: 'paste-credential',
                set: set.id,
                keys: ordered.map(k => ({
                    vaultKey: k.key,
                    secretName: secretNameFor(k.key),
                    what: WHERE_TO_GET[k.key]?.what ?? k.key,
                    present: k.present,
                })),
                present: keys.length - missing.length,
                total: keys.length,
                scope: set.scope,
                origin: set.origin,
                whereToGet: set.where,
                commands: ordered.filter(k => !k.present).map(k => storeCommand(k.key)),
                label: 'Add it',
            },
        });
    }
    // ── refused surfaces ───────────────────────────────────────────────────────
    for (const s of st?.surfaces ?? []) {
        const framework = refusedFramework(s);
        if (!framework)
            continue;
        out.push({
            ...base(),
            id: `refused:${s.id}`,
            kind: 'refused-surface',
            accountWide: false,
            surface: s.id,
            title: `launchpad will not wire ${s.id} — it is ${FRAMEWORK_PHRASE[framework] ?? `a ${framework} app`}`,
            why: `launchpad's ${s.archetype === 'android' ? 'Android' : 'iOS'} pipeline builds one way, and it is not `
                + 'this one. Wiring it anyway would write a workflow that looks right, runs, and fails on its first '
                + 'build step — after the runner has been paid for. Everything that is not the pipeline still applies: '
                + 'the readiness list in this platform\'s terms, the signing guidance, the roadmap and the dashboard.',
            blocks: `A ${s.archetype === 'android' ? 'CI build of the Android app' : 'CI build of the iOS app'}. `
                + 'Nothing else on this project is affected.',
            action: { type: 'refused-surface', framework, label: 'See why' },
        });
    }
    // ── a pipeline of theirs, undecided ────────────────────────────────────────
    for (const pipe of st?.pipelines ?? []) {
        if (pipe.disposition)
            continue;
        out.push({
            ...base(),
            id: `keep:${pipe.kind}:${pipe.path}`,
            kind: 'keep-or-migrate',
            accountWide: false,
            title: `\`${pipe.path}\` is yours, and launchpad has not been told what to do with it`,
            why: 'Most repositories that have got this far already ship somehow, and breaking the thing that works '
                + 'is the one unrecoverable mistake available here. launchpad recommends leaving it alone and wiring '
                + 'the dashboard around it.',
            blocks: 'Nothing is written to that file either way. Until this is answered, though, `apply` may wire a '
                + 'second pipeline beside the one that already works — and a workflow calling a lane that does not '
                + 'exist is worse than no workflow.',
            action: {
                type: 'keep-or-migrate',
                pipeline: pipe.kind,
                path: pipe.path,
                default: 'keep',
                alternative: 'Moving it to launchpad is `disposition: migrate` on that pipeline in '
                    + '`.launchpad/state.yml`; the original is preserved alongside so the old behaviour stays diffable.',
                label: 'Keep it',
            },
        });
    }
    // ── money: hosted macOS runners ────────────────────────────────────────────
    for (const s of st?.surfaces ?? []) {
        if (s.archetype !== 'ios')
            continue;
        const c = (s.config ?? {});
        if (!c.runsOn || c.runsOn === 'self-hosted')
            continue;
        if (refusedFramework(s))
            continue;
        out.push({
            ...base(),
            id: `money:macos-runner:${s.id}`,
            kind: 'decide-money',
            accountWide: false,
            surface: s.id,
            title: `Builds for ${s.id} run on GitHub's hosted macOS runners, billed by the minute`,
            why: 'macOS minutes bill roughly ten times Linux. launchpad already put the cheap checks on Linux, so '
                + 'this is the release lane only — on a busy mobile repo building everything on every push it is '
                + 'around $100 a month, and a spare Mac as a self-hosted runner takes it to nothing.',
            cost: { amount: null, currency: 'USD', cadence: 'per-minute', class: 'launchpads-choice' },
            blocks: 'Nothing — the pipeline works either way. This is a bill, not a blocker.',
            decision: { area: surfaceLabel(s), choice: `Builds on ${c.runsOn}` },
            action: {
                type: 'decide-money',
                recordId: `money:macos-runner:${s.id}`,
                default: 'accept',
                accept: 'Use hosted runners',
                decline: 'I will use my own Mac',
                // The card's button carries the verb and the cost chip beside it carries
                // the number; the full pair of answers is in the drawer.
                label: 'Accept',
            },
        });
    }
    // ── store gates ────────────────────────────────────────────────────────────
    const kinds = new Set((st?.surfaces ?? []).map(s => s.archetype));
    if (kinds.has('android')) {
        out.push({
            ...base(),
            id: 'gate:play',
            kind: 'store-gate',
            accountWide: true,
            title: 'Google Play costs $25 once — and a new personal account waits 14 days',
            why: 'The fee is not the barrier; the fortnight is. A *personal* Play account created after '
                + '13 November 2023 cannot publish to production until it has run a closed test with 12 testers '
                + 'opted in continuously for 14 days, plus identity verification. Organisation accounts and older '
                + 'personal accounts are exempt. If you want Android users this month, that is Firebase App '
                + 'Distribution — no-cost on Firebase\'s Spark plan and needing no Play account at all, which is '
                + 'why launchpad starts there.',
            cost: { amount: 25, currency: 'USD', cadence: 'one-time', class: 'unavoidable' },
            blocks: 'Publishing on Google Play. Firebase App Distribution needs neither the fee nor the wait.',
            action: { type: 'store-gate', recordId: 'gate:play', label: 'Noted' },
        });
    }
    if (kinds.has('ios') || kinds.has('macos-dmg')) {
        out.push({
            ...base(),
            id: 'gate:apple',
            kind: 'store-gate',
            accountWide: true,
            title: 'Apple\'s Developer Program is $99 a year',
            why: 'TestFlight, the App Store and notarizing a Mac app all need a paid membership; there is no free '
                + 'tier that reaches anybody else\'s device. A free Apple account can run a build on your own phone '
                + 'for seven days and no further.',
            cost: { amount: 99, currency: 'USD', cadence: 'yearly', class: 'unavoidable' },
            blocks: 'Any iOS build reaching TestFlight, and any Mac app that opens without a Gatekeeper warning.',
            action: { type: 'store-gate', recordId: 'gate:apple', label: 'Noted' },
        });
    }
    if (kinds.has('web-app') && isMonetized(p)) {
        const web = (st?.surfaces ?? []).find(s => s.archetype === 'web-app');
        out.push({
            ...base(),
            id: 'gate:vercel-pro',
            kind: 'store-gate',
            accountWide: true,
            surface: web.id,
            title: 'This site takes money, so Vercel Hobby no longer covers it',
            why: 'Hobby is licensed for non-commercial use only. There is a paywall, a checkout or a licence check '
                + 'in this repository, so the correct plan is Pro at $20 per seat per month — the same as launchpad '
                + 'costs once, except every month, for as long as the site is up. Better to hear it here than from '
                + 'Vercel.',
            cost: { amount: 20, currency: 'USD', cadence: 'monthly', class: 'unavoidable' },
            blocks: 'Nothing technically. It is a licence term, and the one people find out about late.',
            decision: {
                area: surfaceLabel(web),
                choice: (p.decisions ?? []).find(d => d.area === surfaceLabel(web) && d.choice.startsWith('Vercel'))?.choice
                    ?? 'Vercel',
            },
            action: { type: 'store-gate', recordId: 'gate:vercel-pro', label: 'Noted' },
        });
    }
    // ── irreversible ───────────────────────────────────────────────────────────
    for (const l of p.live ?? []) {
        if (l.evidence !== 'never released')
            continue;
        out.push({
            ...base(),
            id: `irreversible:first-release:${l.surface}`,
            kind: 'acknowledge-irreversible',
            accountWide: false,
            surface: l.surface,
            title: `Nothing has gone out on ${l.channel} yet`,
            why: 'The first build on a channel is the one that creates the record other people see — a TestFlight '
                + 'group, a store track, a download URL that will be linked to. launchpad asks before a first release '
                + 'on any new channel, whatever the settings say, and this is that ask.',
            blocks: 'Nothing yet. It is the release itself that cannot be taken back.',
            action: {
                type: 'acknowledge-irreversible',
                recordId: `irreversible:first-release:${l.surface}`,
                label: 'Understood',
            },
        });
    }
    for (const s of st?.surfaces ?? []) {
        if (s.archetype === 'android' && s.status !== 'wired' && !refusedFramework(s)) {
            out.push({
                ...base(),
                id: `irreversible:keystore:${s.id}`,
                kind: 'acknowledge-irreversible',
                accountWide: false,
                surface: s.id,
                title: 'launchpad will generate an upload keystore for this app',
                why: 'A stock Android release build is signed with the DEBUG keystore: it looks shippable, no store '
                    + 'will take it, and its identity changes from machine to machine. launchpad generates one real '
                    + 'upload keystore instead — and you must back it up somewhere that is not this laptop, because if '
                    + 'it is lost this app can never be updated again. There is no recovery path, from anybody.',
                blocks: 'The first Android build a store will accept.',
                action: {
                    type: 'acknowledge-irreversible',
                    recordId: `irreversible:keystore:${s.id}`,
                    label: 'Understood',
                },
            });
        }
        const domain = domainOf(s);
        if (domain && s.status !== 'wired') {
            out.push({
                ...base(),
                id: `irreversible:dns:${s.id}`,
                kind: 'acknowledge-irreversible',
                accountWide: false,
                surface: s.id,
                title: `Pointing ${domain} at this will change DNS`,
                why: 'DNS is public and shared: if that name already serves something, attaching it here replaces it, '
                    + 'and the change is visible to everyone before it is visible to you. launchpad never touches DNS '
                    + 'without an explicit yes — `launchpad domains` previews and writes nothing until you pass `--wire`.',
                blocks: `${domain} serving this project.`,
                action: { type: 'acknowledge-irreversible', recordId: `irreversible:dns:${s.id}`, label: 'Understood' },
            });
        }
    }
    // ── only-you facts ─────────────────────────────────────────────────────────
    // `answerable` is set by `scorecard()` on exactly the rows it refuses to guess
    // at, so this list cannot drift from the one the readiness tab offers.
    for (const c of p.score?.checks ?? []) {
        if (!c.answerable || c.grade !== 'unknown')
            continue;
        out.push({
            ...base(),
            id: `confirm:${c.id}`,
            kind: 'confirm',
            accountWide: false,
            title: c.title,
            why: c.detail || 'launchpad cannot see inside a drawer, a password manager or an inbox, so it will not '
                + 'guess. If this is handled, say so and it stops asking — it is recorded as your answer, dated, and '
                + 'it never counts against you either way.',
            blocks: 'Nothing. It stays an open question on the readiness list until you answer it.',
            action: { type: 'confirm', check: c.id, label: "It's handled" },
        });
    }
    return out;
}
/**
 * Union two projects' view of the same credential set.
 *
 * Two projects can need different parts of one act: a static-site repo wants the
 * Cloudflare token and account id, a Mac app wants those plus the R2 pair. When
 * they merge into one card, keeping whichever project happened to be read first
 * would make "2 of 2 stored" out of a set with five keys — a card claiming to be
 * finished while three of its keys are absent, which is the false pass this
 * product refuses everywhere else.
 */
function mergeCredentialKeys(into, from) {
    if (into.action.type !== 'paste-credential' || from.action.type !== 'paste-credential')
        return;
    const keys = [...into.action.keys];
    for (const k of from.action.keys) {
        if (!keys.some(x => x.vaultKey === k.vaultKey))
            keys.push(k);
    }
    into.action.keys = keys;
    into.action.total = keys.length;
    into.action.present = keys.filter(k => k.present).length;
    into.action.commands = keys.filter(k => !k.present).map(k => storeCommand(k.vaultKey));
}
/**
 * The command that stores one credential — `launchpad secret set <key>`.
 *
 * It used to be `launchpad secret <key>`, which READS a credential: every
 * card on the dashboard and in `needs` told the buyer to run the one command
 * that answers "not in the vault — store it with /launchpad:doctor". The
 * value is typed at a prompt that shows nothing, or piped; the credentials that
 * arrive as a file say which file, because a multi-line `.p8` or a JSON key
 * cannot be pasted at a one-line prompt.
 *
 * Canonical `launchpad …` form here; each renderer turns it into something a
 * terminal can run (`invocation.ts`), because this model is also `--json`.
 */
const FROM_FILE = {
    asc_api_key: c => `${c} < AuthKey_XXXXXXXXXX.p8`,
    firebase_sa_json: c => `${c} < service-account.json`,
    match_deploy_key: c => `${c} < match_key`,
    android_keystore_base64: c => `base64 < upload-keystore.jks | ${c}`,
    developer_id_cert_p12: c => `base64 < cert.p12 | ${c}`,
};
export function storeCommand(vaultKey) {
    const cmd = `launchpad secret set ${vaultKey}`;
    return FROM_FILE[vaultKey]?.(cmd) ?? cmd;
}
/** Answered everywhere it applies? Then it is done and must not be asked again. */
const answeredBy = (item, byPath) => item.projects.every(pr => Boolean(byPath.get(pr.path)?.[item.id]));
/**
 * The fleet's list: every project's items, account-wide ones merged, sorted.
 *
 * Merging is what makes this usable on a real fleet. Six projects that all want
 * an App Store Connect key is ONE thing to do, and printing it six times is the
 * fastest way to teach somebody that this list is noise.
 */
export function fleetNeeds(projects) {
    const answers = new Map(projects.map(p => [p.path, p.answered ?? {}]));
    const byId = new Map();
    for (const p of projects) {
        for (const raw of needsForProject(p)) {
            // Account-wide items merge by their record id; everything else is keyed by
            // project as well, so two projects asking the same question both get a row.
            const item = {
                ...raw,
                key: raw.accountWide ? raw.id : `${p.path}|${raw.id}`,
                group: GROUP_OF[raw.kind],
                ...(raw.cost ? { costLabel: priceOf(raw.cost), costClass: CLASS_WORD[raw.cost.class] } : {}),
            };
            const seen = byId.get(item.key);
            if (!seen) {
                byId.set(item.key, item);
                continue;
            }
            seen.projects.push(...item.projects);
            mergeCredentialKeys(seen, item);
        }
    }
    const items = [...byId.values()]
        .filter(item => !answeredBy(item, answers))
        .sort((a, b) => GROUP_RANK[groupOf(a)] - GROUP_RANK[groupOf(b)]
        || (a.accountWide === b.accountWide ? 0 : a.accountWide ? -1 : 1)
        || a.project.localeCompare(b.project)
        || a.id.localeCompare(b.id));
    return { items, ledger: ledgerFor(projects, items) };
}
/** The same list, for one project. The strip on a project page shows this. */
export function projectNeeds(all, path) {
    return all.filter(n => n.projects.some(p => p.path === path));
}
// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────
const emptyBucket = () => ({ unavoidable: 0, launchpadsChoice: 0, optional: 0, total: 0 });
const BUCKET_FIELD = {
    'unavoidable': 'unavoidable',
    'launchpads-choice': 'launchpadsChoice',
    'optional': 'optional',
};
/**
 * Totals per month, per year and once, split by who the cost belongs to.
 *
 * Built from the decisions' own cost chips plus the money items above, which is
 * the point: there is one place a price is written down, and both the chip a
 * buyer reads and the number a total adds come out of it. A second, separately
 * maintained price list is how a dashboard ends up quoting $20 on one tab and
 * $30 on another.
 *
 * Two deliberate exclusions, both stated rather than silent:
 *
 *   - a **conditional** decision cost (`onlyWhen`) is not added, because it is
 *     not being paid. Where the condition has actually come true, `needs.ts`
 *     raises it as a `store-gate` item and THAT is what counts — so the Vercel
 *     $20 is charged exactly once, in the projects where there is something to
 *     buy, and nowhere else.
 *   - a **metered** cost (`amount: null`) has no number. Inventing one would put
 *     the single figure a buyer quotes on the one line we cannot stand behind.
 */
export function ledgerFor(projects, items) {
    const monthly = emptyBucket(), yearly = emptyBucket(), oneTime = emptyBucket();
    const unpriced = [];
    const lines = [];
    /**
     * Decision rows a "needs you" item already speaks for, keyed by project and
     * area.
     *
     * By AREA rather than by the exact choice string, because the two are written
     * for different readers: a decision's choice carries the detail ("Vercel, root
     * apps/web → fernweh.app") and an item names the surface it is about. An area
     * is `Web · web`, and one surface has one cost.
     *
     * Without this the same fact is counted or listed twice — once as the Vercel
     * chip's conditional $20, once as the store-gate item that says the condition
     * has come true — and a ledger that says $40 for one $20 subscription is worse
     * than no ledger.
     */
    const charged = new Set(items.filter(i => i.decision).flatMap(i => i.projects.map(pr => `${pr.path}|${i.decision.area}`)));
    const put = (line) => {
        const m = line.money;
        if (m.amount == null) {
            unpriced.push({
                project: line.project, label: line.label,
                why: `billed by use, at ${m.cadence === 'per-minute' ? 'a per-minute rate' : 'a rate'} that depends on how much this repo builds`,
            });
            return;
        }
        if (m.onlyWhen) {
            unpriced.push({ project: line.project, label: line.label, why: `$${m.amount} ${cadenceWord(m.cadence)}, ${m.onlyWhen}` });
            return;
        }
        const bucket = m.cadence === 'one-time' ? oneTime : m.cadence === 'yearly' ? yearly : monthly;
        bucket[BUCKET_FIELD[m.class]] += m.amount;
        bucket.total += m.amount;
        lines.push(line);
    };
    for (const p of projects) {
        for (const d of p.decisions ?? []) {
            if (!d.money)
                continue;
            if (charged.has(`${p.path}|${d.area}`))
                continue;
            put({ project: p.label, label: `${d.area} — ${d.choice}`, money: d.money, from: 'decision' });
        }
    }
    for (const item of items) {
        if (!item.cost)
            continue;
        put({
            project: item.accountWide ? '' : item.project,
            label: item.title,
            money: item.cost,
            from: 'needs-you',
        });
    }
    const summary = [
        monthly.total ? `$${monthly.total} a month` : '',
        yearly.total ? `$${yearly.total} a year` : '',
        oneTime.total ? `$${oneTime.total} once` : '',
    ].filter(Boolean).join(' · ')
        // "free today" rather than "free" when something is metered or conditional.
        // Both are true and only one of them survives the first busy month, and the
        // unpriced lines underneath say which it is.
        || (unpriced.length ? 'free today' : 'free');
    // Which classes actually contributed. "all unavoidable" is a much stronger
    // sentence than "$144" on its own, and the opposite — a total that is mostly
    // launchpad's own choices — is the one a buyer is entitled to push back on.
    const present = new Set();
    for (const b of [monthly, yearly, oneTime]) {
        if (b.unavoidable)
            present.add('unavoidable');
        if (b.launchpadsChoice)
            present.add('launchpads-choice');
        if (b.optional)
            present.add('optional');
    }
    const words = [...present].map(c => CLASS_WORD[c]);
    const summaryClass = !words.length ? (unpriced.length ? 'nothing fixed yet' : 'nothing to pay')
        : words.length === 1 ? `all ${words[0]}`
            : words.join(' + ');
    return {
        monthly, yearly, oneTime,
        perYear: monthly.total * 12 + yearly.total,
        unpriced,
        lines,
        summary,
        summaryClass,
    };
}
const cadenceWord = (c) => ({ 'one-time': 'once', 'monthly': 'a month', 'yearly': 'a year', 'per-minute': 'a minute' })[c];
// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────
/** `$20 a month`, `$99 a year`, `metered`. One phrasing, shared by the CLI and the page. */
export function priceOf(m) {
    if (!m)
        return '';
    if (m.amount == null)
        return `metered — billed ${cadenceWord(m.cadence).replace(/^a /, 'per ')}`;
    if (m.amount === 0)
        return 'free';
    return `$${m.amount} ${cadenceWord(m.cadence)}${m.onlyWhen ? `, ${m.onlyWhen}` : ''}`;
}
export const CLASS_WORD = {
    'unavoidable': 'unavoidable',
    'launchpads-choice': 'launchpad\'s choice',
    'optional': 'optional',
};
/**
 * The whole thing as one terminal screen — `launchpad needs`.
 *
 * Grouped by what it blocks, because that is the order the work happens in, and
 * with the ledger at the end, because "what will this cost me" is the question
 * the buyer asked and the one no other screen answered.
 */
export function renderNeeds(result, opts = {}) {
    const { items, ledger } = result;
    // `launchpad …` is not on anybody's PATH; the CLI passes the real invocation.
    const run = (c) => (opts.runnable ? c.replace(/(^|\| )launchpad(?= )/, (m, pre) => `${pre}${opts.runnable('launchpad')}`) : c);
    const out = [];
    if (!items.length) {
        out.push('Nothing needs you.');
        out.push('');
        out.push('  Every credential launchpad requires is in your vault, every question it cannot answer');
        out.push('  itself has been answered, and nothing is waiting on a decision only you can make.');
    }
    else {
        out.push(`${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} you.`);
        for (const g of NEED_GROUPS) {
            const mine = items.filter(i => groupOf(i) === g.id);
            if (!mine.length)
                continue;
            out.push('');
            out.push(`${g.label} (${mine.length})`);
            for (const n of mine) {
                const where = n.accountWide && n.projects.length > 1
                    ? `all ${n.projects.length} projects`
                    : n.accountWide ? `${n.project} — and any future project`
                        : n.project;
                const a = n.action;
                out.push('');
                out.push(`  ${n.title}${a.type === 'paste-credential' && a.total > 1
                    ? `   ${a.present} of ${a.total} stored` : ''}`);
                out.push(`    ${where}${n.cost ? `   ${priceOf(n.cost)} · ${CLASS_WORD[n.cost.class]}` : ''}`);
                out.push(...wrap(n.why, 4));
                out.push(...wrap(`Blocks: ${n.blocks}`, 4));
                if (n.warning)
                    out.push(...wrap(`! ${n.warning}`, 4));
                if (a.type === 'paste-credential') {
                    // The keys the act produces, each said once, with what is already
                    // done marked — a card is one job, and this is its checklist.
                    for (const k of a.keys)
                        out.push(`    ${k.present ? '✓' : '·'} ${k.vaultKey}   ${k.what}`);
                    for (const cmd of a.commands)
                        out.push(`    → ${run(cmd)}`);
                }
                else
                    out.push(`    → ${a.label}`);
            }
        }
    }
    out.push('');
    out.push('What this fleet costs');
    const bucket = (label, b, suffix) => {
        if (!b.total)
            return;
        const parts = [
            b.unavoidable ? `$${b.unavoidable} unavoidable` : '',
            b.launchpadsChoice ? `$${b.launchpadsChoice} launchpad's choice` : '',
            b.optional ? `$${b.optional} optional` : '',
        ].filter(Boolean);
        out.push(`  $${b.total} ${suffix}   (${parts.join(' · ')})`);
        void label;
    };
    bucket('monthly', ledger.monthly, 'a month');
    bucket('yearly', ledger.yearly, 'a year');
    bucket('one-time', ledger.oneTime, 'once');
    if (!ledger.monthly.total && !ledger.yearly.total && !ledger.oneTime.total) {
        out.push('  Nothing recurring, and nothing one-off. Every platform launchpad chose has a free tier');
        out.push('  that covers what you are doing.');
    }
    else if (ledger.perYear) {
        out.push(`  $${ledger.perYear} a year in total, before anything metered.`);
    }
    for (const u of ledger.unpriced) {
        out.push(`  · ${u.label}${u.project ? ` (${u.project})` : ''} — ${collapse(u.why)}`);
    }
    out.push('');
    return out.join('\n');
}
const collapse = (s) => s.replace(/\s+/g, ' ').trim();
/** Soft-wrap a sentence to 92 columns at the given indent. */
function wrap(text, indent) {
    const pad = ' '.repeat(indent);
    // `**emphasis**` is for the page; a terminal would print the asterisks.
    const words = collapse(text).replace(/\*\*/g, '').split(' ');
    const lines = [];
    let line = '';
    for (const w of words) {
        if (line && (line + ' ' + w).length > 88) {
            lines.push(pad + line);
            line = w;
        }
        else
            line = line ? `${line} ${w}` : w;
    }
    if (line)
        lines.push(pad + line);
    return lines;
}
