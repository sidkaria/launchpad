import { androidFramework, androidIsWireable, type AndroidConfig } from './archetypes/android.js';
import { isWireable } from './archetypes/ios.js';
import { SECRET_CATALOGUE, PER_APP_SECRETS, vaultKeyFor } from './secrets.js';
import type { Confirmations } from './confirmations.js';
import type { Decision, Money } from './dashboard/decisions.js';
import type { Scorecard } from './scorecard.js';
import type { Archetype, LaunchpadState, Surface } from './types.js';

/**
 * One model of "what needs a human", across the whole fleet.
 *
 * The buyer's problem, in his words: *"They'll need to set up a lot of stuff —
 * passwords, API tokens, licences, how much they want to spend, which platform.
 * We should use entirely free platforms, but what WILL cost them money? We don't
 * want to bombard them with steps and questions, but we don't want to make
 * decisions for them that cost them money or cost them in the long run."*
 *
 * Every one of those facts already existed somewhere in this product — a missing
 * vault key in the Keys tab, a `?` row on the scorecard, a `$20/seat/mo` chip on
 * the Decisions tab, a pipeline with no disposition in `state.yml`, a surface
 * `apply` refuses. What did not exist was a single answer to "what is waiting on
 * me?". Seven places to look is the same as none: the one thing blocking the
 * first Android build sat three clicks inside a project page, indistinguishable
 * from twelve things that are fine.
 *
 * ## Two rules, and they are the whole design
 *
 * **Never invent an item the code cannot justify.** Every item below is derived
 * from something observable — a vault `has()`, a scorecard grade, a config
 * field, a framework the refusal logic rejects. Nothing is here because it is
 * generally good advice. A list that includes one speculative row is a list
 * people learn to skim, and skimming is how the row that mattered gets missed.
 *
 * **Never surface a question the code can answer itself.** DECISIONS.md, 2026-07-31:
 * *"We decide the stack; the decisions are the product. Ask only when it costs
 * money, is a secret, would break something that works, or is irreversible /
 * public."* Those four are exactly the categories here, and the test is blunt:
 * a fully-wired, fully-credentialed project produces an empty list.
 *
 * ## Where the kinds come from
 *
 * The 2026-08-02 audit's resolution — *"split on reversibility, not on stage"* —
 * plus the question bank's Phase 7 standing confirmations. The four groups below
 * are that split, and the ordering is the priority a first-time shipper actually
 * has: what is stopping me, then what will it cost me, then what can I not take
 * back, then what do you need me to tell you.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The model
// ─────────────────────────────────────────────────────────────────────────────

export type NeedKind =
  /** A credential only they can produce. Blocks whatever consumes it. */
  | 'paste-credential'
  /** A fact about a drawer or an inbox that no repository can show. */
  | 'confirm'
  /** A recurring or one-off bill, with the number and a default. */
  | 'decide-money'
  /** An act with no undo: a first release, a keystore, DNS. */
  | 'acknowledge-irreversible'
  /** Something of theirs that already works. Default: leave it alone. */
  | 'keep-or-migrate'
  /** A platform's own fee or gate — Play's registration, Apple's membership, Vercel's Pro tier. */
  | 'store-gate'
  /** A surface detection found and `apply` deliberately refuses. */
  | 'refused-surface';

/**
 * What the one button does.
 *
 * Exactly one per item, on purpose. A card with three buttons is a menu, and a
 * menu hands back the decision the buyer paid not to make. Where there is a real
 * second option — accept/decline a bill, keep/migrate a pipeline — it is a
 * default plus its alternative, not two equal choices.
 */
export type NeedAction =
  | {
    type: 'paste-credential';
    /** Which `CREDENTIAL_SETS` entry this card is. */
    set: string;
    /**
     * Every key this set covers that this fleet actually needs, with presence.
     *
     * The card is one card because it is one *act* — and the keys are still all
     * here, by name, because the person doing it has four things to store and
     * needs to know which of them are already done. `--json` carries the same
     * array, so an agent reading the list sees both the act and its parts.
     */
    keys: { vaultKey: string; secretName: string; what: string; present: boolean }[];
    /** How far through this set the vault already is. */
    present: number;
    total: number;
    /** Store it once for every project, or once per app? */
    scope: 'account-wide' | 'per-app';
    /** Does launchpad produce this, or does the user fetch it from a portal? */
    origin: 'generated-by-launchpad' | 'fetched-by-user';
    /** Where to click, once for the whole set, in the product's own words. */
    whereToGet: string;
    /** The exact commands, one per key still missing. Never a field for a value. */
    commands: string[];
    label: string;
  }
  | { type: 'confirm'; check: string; label: string }
  | {
    type: 'decide-money';
    recordId: string;
    default: 'accept' | 'decline';
    accept: string;
    decline: string;
    label: string;
  }
  | { type: 'acknowledge-irreversible'; recordId: string; label: string }
  | {
    type: 'keep-or-migrate';
    pipeline: string;
    path: string;
    default: 'keep';
    /** What the other answer is, and what it costs to change later. */
    alternative: string;
    label: string;
  }
  | { type: 'store-gate'; recordId: string; label: string }
  | { type: 'refused-surface'; framework: string; label: string };

export interface Need {
  /**
   * Stable, and namespaced with a colon so it can be written straight into
   * `.launchpad/confirmed.yml` without colliding with a scorecard check id.
   */
  id: string;
  /**
   * Unique across the fleet, which `id` deliberately is not.
   *
   * `id` is the RECORD id — the key written into a repository's own
   * `confirmed.yml` — so it must not carry a path, and two projects can both
   * have a `confirm:app-icon`. `key` is the identity of a *row in this list*,
   * and it has to be unique or the second project's unanswered question is
   * silently dropped on the way to the screen. It was, once: Northbeam's
   * question vanished because Coastline had the same one.
   */
  key: string;
  kind: NeedKind;
  /**
   * Which of the four groups this falls in.
   *
   * On the item rather than derived by each renderer. The page, the CLI and the
   * harness all group the list, and three copies of one mapping is three chances
   * for the strip to say "blocks a release" about something the terminal filed
   * under "only you can answer".
   */
  group: NeedGroup;
  /** The project chip. The first of `projects`, for a single-project item its only one. */
  project: string;
  projectPath: string;
  /** Every project this applies to — more than one only when `accountWide`. */
  projects: { label: string; path: string }[];
  /**
   * True when answering it once answers it everywhere.
   *
   * The Apple Developer Program is $99 a year whether you have one app or nine,
   * and an App Store Connect key provisions every future app under that team.
   * Asking nine times is how a list stops being read.
   */
  accountWide: boolean;
  /** The surface this is about, where it is about one. */
  surface?: string;
  title: string;
  /** One sentence a first-time shipper understands. No jargon without its gloss. */
  why: string;
  /** What it costs, as a number. Absent when it costs nothing. */
  cost?: Money;
  /**
   * The same price as a phrase — `$99 a year`, `metered — billed per minute`.
   *
   * Rendered once, here, and printed verbatim by the terminal and the page.
   * Two formatters for one number is how a chip ends up reading `$20/mo` beside
   * a total that was computed from `$20 a month` and rounded differently.
   */
  costLabel?: string;
  /** `unavoidable` · `launchpad's choice` · `optional`, worded once. */
  costClass?: string;
  /** What cannot happen until this is done. Never empty — "nothing" is an answer. */
  blocks: string;
  /**
   * The thing that must be said alongside the act, where something must.
   *
   * Its own field rather than another clause of `why`, because it is not an
   * explanation: it is the sentence about the upload keystore that has to
   * survive being skim-read. Both renderers give it its own block.
   */
  warning?: string;
  action: NeedAction;
  /**
   * The Decisions row this mirrors, when it mirrors one.
   *
   * The link is load-bearing rather than decorative: L3 asserts that an item's
   * cost equals the cost chip of the decision it names, so the strip and the
   * Decisions tab cannot quote two different prices for one thing.
   */
  decision?: { area: string; choice: string };
}

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
] as const;

export type NeedGroup = (typeof NEED_GROUPS)[number]['id'];

const GROUP_OF: Record<NeedKind, NeedGroup> = {
  'paste-credential': 'blocks',
  'refused-surface': 'blocks',
  'keep-or-migrate': 'blocks',
  'decide-money': 'money',
  'store-gate': 'money',
  'acknowledge-irreversible': 'irreversible',
  'confirm': 'facts',
};

export const groupOf = (n: Need): NeedGroup => GROUP_OF[n.kind];

const GROUP_RANK: Record<NeedGroup, number> = { blocks: 0, money: 1, irreversible: 2, facts: 3 };

// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────

export interface LedgerLine {
  /** The project it belongs to, or `''` when it is an account-wide fact. */
  project: string;
  /** What this line is, short enough for a table row. */
  label: string;
  money: Money;
  /** Which of the two sources it came from, so a number can be traced. */
  from: 'decision' | 'needs-you';
}

export interface LedgerBucket {
  unavoidable: number;
  launchpadsChoice: number;
  optional: number;
  total: number;
}

export interface CostLedger {
  monthly: LedgerBucket;
  yearly: LedgerBucket;
  oneTime: LedgerBucket;
  /** Recurring cost over a year: twelve months plus the annual lines. */
  perYear: number;
  /**
   * Costs with no number to add, and why not.
   *
   * Two reasons only: metered (billed by use, at a rate that depends on how
   * much the repo builds) and conditional (real, but not yet — Vercel Pro on a
   * site with nothing to buy). Both are listed rather than silently dropped: a
   * total that quietly excludes the runner bill is a total that will be wrong
   * in exactly the month somebody notices.
   */
  unpriced: { project: string; label: string; why: string }[];
  /** Every line that fed a total, so any number can be traced to its decision. */
  lines: LedgerLine[];
  /**
   * The whole thing in one phrase — `$20 a month · $99 a year`.
   *
   * Written here so the chip on the dashboard and the last line of
   * `launchpad needs` are the same string rather than two roundings of the
   * same numbers.
   */
  summary: string;
  /** `all unavoidable`, or the mix. Read beside `summary`, never alone. */
  summaryClass: string;
}

export interface NeedsResult {
  items: Need[];
  ledger: CostLedger;
}

// ─────────────────────────────────────────────────────────────────────────────
// Inputs
// ─────────────────────────────────────────────────────────────────────────────

/** One live target, exactly as `dashboard/data.ts` computes it. */
export interface NeedsLiveTarget {
  surface: string;
  archetype: Archetype;
  channel: string;
  ref: string;
  evidence: string;
}

export interface NeedsProject {
  path: string;
  /** `labelOf()` — the name, qualified by its parent only where it collides. */
  label: string;
  state?: LaunchpadState | null;
  score?: Scorecard;
  /** Presence only. Never a value, in this module or anywhere downstream. */
  secrets?: { key: string; present: boolean }[];
  live?: NeedsLiveTarget[];
  decisions?: Decision[];
  /** `.launchpad/confirmed.yml` — the answers already given. */
  answered?: Confirmations;
}

// ─────────────────────────────────────────────────────────────────────────────
// Where to get a credential
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The where-to-get text, keyed by vault key.
 *
 * Lifted from `skills/doctor/SKILL.md` §3, which is where it has always lived
 * and where it is maintained — the point of moving a copy here is that a person
 * looking at the dashboard should not have to go and run a skill to find out
 * where to click. Every string names a place, a role where the role matters, and
 * nothing else. There is no field anywhere in this product that takes the value.
 *
 * `test/needs.test.ts` asserts that every secret in `SECRET_CATALOGUE` has an
 * entry, so a new credential added by an archetype cannot arrive here as a bare
 * key name. At runtime a missing entry degrades to the catalogue's own group
 * label rather than throwing — a dashboard that will not render because someone
 * added a secret is worse than one that says "see `/launchpad:doctor`".
 */
interface CredentialGuidance {
  /** What it is, in one clause. */
  what: string;
  /** Where to click, and what role it needs. */
  where: string;
  scope: 'account-wide' | 'per-app';
}

export const WHERE_TO_GET: Record<string, CredentialGuidance> = {
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

// ─────────────────────────────────────────────────────────────────────────────
// Credentials, grouped by the thing a person actually does
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One trip to one portal, or one command, however many vault keys come out of it.
 *
 * The first version of this list was keyed on vault keys, and the demo fleet
 * showed the consequence: the Android upload keystore was **four** cards — "the
 * key alias inside the keystore", "the passphrase on the key inside the
 * keystore", "your Android upload keystore, base64", "the keystore passphrase"
 * — for a single act that launchpad performs itself with one `keytool`
 * invocation. The App Store Connect key was three cards from one screen. Twenty
 * vault keys read as twenty jobs, when the person in front of it has eight
 * things to do.
 *
 * A count that is not a count of *decisions somebody has to make* is a count
 * that makes the list look hopeless, and a list that looks hopeless does not get
 * worked through. So a card is an ACT, the keys it produces are listed inside
 * it, and the card states how far along it already is ("2 of 4 stored") — which
 * a vault-key-per-card list could not express at all, because the parts were
 * strangers to each other.
 *
 * `origin` is load-bearing rather than descriptive. "launchpad generates this
 * one" and "go and fetch this from a portal" are different sentences and only
 * one of them is a chore; the keystore card in particular must say launchpad
 * makes it, because the *next* thing that card has to say is the backup warning,
 * and that warning only makes sense once you know the thing exists.
 *
 * **Where this should live.** The grouping is a fact about the archetypes'
 * secret lists, so it belongs beside `SECRET_CATALOGUE` in `src/secrets.ts` —
 * a `group` field on each `SecretGroup`, or a set id per secret. It is here
 * instead because that module is owned by another branch right now, and keyed by
 * secret NAME so the move is a rename and not a rewrite. A key that belongs to
 * no set still gets a card of its own, so nothing can go missing in the
 * meantime, and `test/needs.test.ts` fails if a catalogue secret is unplaced.
 */
export interface CredentialSet {
  /** Stable id. Appears in the need id, so it is part of the record. */
  id: string;
  /** What the card is called. A noun phrase: the button carries the verb. */
  title: string;
  /** The vault keys this act produces, in the order they come out of it. */
  keys: readonly string[];
  /** Where to click or what to run — once, for the whole set. */
  where: string;
  scope: 'account-wide' | 'per-app';
  origin: 'generated-by-launchpad' | 'fetched-by-user';
  /** What cannot happen until this set is complete, in the user's terms. */
  blocks: string;
  /** What must be said immediately after the act, where something must. */
  warning?: string;
}

export const CREDENTIAL_SETS: readonly CredentialSet[] = [
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

const SET_OF = new Map<string, CredentialSet>(
  CREDENTIAL_SETS.flatMap(s => s.keys.map(k => [k, s] as const)));

/**
 * The set a key belongs to, or a set of one built from what is known about it.
 *
 * The fallback is what stops a credential added by another branch from vanishing
 * off the strip while the grouping catches up. It is deliberately a card rather
 * than a silent omission — a missing credential that nothing mentions is the
 * failure this whole feature exists to end.
 */
export function setFor(vaultKey: string): CredentialSet {
  const known = SET_OF.get(vaultKey);
  if (known) return known;
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
function catalogueLabel(vaultKey: string): string {
  for (const g of SECRET_CATALOGUE) {
    if (g.secrets.some(s => vaultKeyFor(s) === vaultKey)) return g.label;
  }
  if (PER_APP_SECRETS.some(s => vaultKeyFor(s) === vaultKey)) return 'A per-app credential';
  return 'A credential launchpad needs';
}

/** The GitHub secret name a vault key came from, for the card's second line. */
function secretNameFor(vaultKey: string): string {
  for (const g of SECRET_CATALOGUE) {
    const hit = g.secrets.find(s => vaultKeyFor(s) === vaultKey);
    if (hit) return hit;
  }
  const perApp = PER_APP_SECRETS.find(s => vaultKeyFor(s) === vaultKey);
  return perApp ?? vaultKey.toUpperCase();
}

// ─────────────────────────────────────────────────────────────────────────────
// Building the list
// ─────────────────────────────────────────────────────────────────────────────

const surfaceLabel = (s: Surface): string => `${
  { 'ios': 'iOS', 'android': 'Android', 'macos-dmg': 'macOS', 'web-app': 'Web', 'static-site': 'Site' }[s.archetype]
} · ${s.id}`;

const domainOf = (s: Surface): string | undefined => {
  const c = (s.config ?? {}) as Record<string, unknown>;
  const d = c.prodDomain ?? c.appcastDomain;
  return typeof d === 'string' && d ? d : undefined;
};

/** Refused by `apply`, read off the archetypes rather than restated here. */
export function refusedFramework(s: Surface): string | null {
  if (s.archetype === 'android') {
    const f = androidFramework(s.config as Partial<AndroidConfig> | undefined, s);
    return androidIsWireable(f) ? null : f;
  }
  if (s.archetype === 'ios') {
    const f = (s.config as { framework?: string } | undefined)?.framework ?? s.framework;
    return f && !isWireable(f) ? f : null;
  }
  return null;
}

const FRAMEWORK_PHRASE: Record<string, string> = {
  'native': 'a native Gradle app, with no Flutter in it',
  'react-native': 'a React Native app',
  'expo': 'an Expo app',
};

/** Whether this project takes money, as the scorecard grades it. Never a guess. */
const isMonetized = (p: NeedsProject): boolean =>
  p.score?.checks.some(c => c.id === 'monetization' && c.grade === 'ok') ?? false;

/** Every item one project raises, before account-wide merging. */
type RawNeed = Omit<Need, 'key' | 'group' | 'costLabel' | 'costClass'>;

function needsForProject(p: NeedsProject): RawNeed[] {
  const out: RawNeed[] = [];
  const st = p.state ?? undefined;
  /**
   * A FRESH `projects` array per item, which is why this is a getter and not a
   * constant. Spreading a shared object copies the array by reference, so the
   * account-wide merge below — which pushes onto `projects` — pushed onto every
   * item this project had raised. Nine credentials all claimed to be wanted by
   * nine projects, on a fleet of five.
   */
  const base = (): Pick<RawNeed, 'project' | 'projectPath' | 'projects'> =>
    ({ project: p.label, projectPath: p.path, projects: [{ label: p.label, path: p.path }] });

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
  const bySet = new Map<string, { set: CredentialSet; keys: { key: string; present: boolean }[] }>();
  for (const s of p.secrets ?? []) {
    const set = setFor(s.key);
    const bucket = bySet.get(set.id) ?? { set, keys: [] };
    bucket.keys.push({ key: s.key, present: s.present });
    bySet.set(set.id, bucket);
  }
  for (const { set, keys } of bySet.values()) {
    const missing = keys.filter(k => !k.present);
    if (!missing.length) continue;
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
    if (!framework) continue;
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
    if (pipe.disposition) continue;
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
    if (s.archetype !== 'ios') continue;
    const c = (s.config ?? {}) as { runsOn?: string };
    if (!c.runsOn || c.runsOn === 'self-hosted') continue;
    if (refusedFramework(s)) continue;
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
    const web = (st?.surfaces ?? []).find(s => s.archetype === 'web-app')!;
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
    if (l.evidence !== 'never released') continue;
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
    if (!c.answerable || c.grade !== 'unknown') continue;
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
function mergeCredentialKeys(into: Need, from: Need): void {
  if (into.action.type !== 'paste-credential' || from.action.type !== 'paste-credential') return;
  const keys = [...into.action.keys];
  for (const k of from.action.keys) {
    if (!keys.some(x => x.vaultKey === k.vaultKey)) keys.push(k);
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
const FROM_FILE: Record<string, (cmd: string) => string> = {
  asc_api_key: c => `${c} < AuthKey_XXXXXXXXXX.p8`,
  firebase_sa_json: c => `${c} < service-account.json`,
  match_deploy_key: c => `${c} < match_key`,
  android_keystore_base64: c => `base64 < upload-keystore.jks | ${c}`,
  developer_id_cert_p12: c => `base64 < cert.p12 | ${c}`,
};

export function storeCommand(vaultKey: string): string {
  const cmd = `launchpad secret set ${vaultKey}`;
  return FROM_FILE[vaultKey]?.(cmd) ?? cmd;
}

/** Answered everywhere it applies? Then it is done and must not be asked again. */
const answeredBy = (item: Need, byPath: Map<string, Confirmations>): boolean =>
  item.projects.every(pr => Boolean(byPath.get(pr.path)?.[item.id]));

/**
 * The fleet's list: every project's items, account-wide ones merged, sorted.
 *
 * Merging is what makes this usable on a real fleet. Six projects that all want
 * an App Store Connect key is ONE thing to do, and printing it six times is the
 * fastest way to teach somebody that this list is noise.
 */
export function fleetNeeds(projects: NeedsProject[]): NeedsResult {
  const answers = new Map(projects.map(p => [p.path, p.answered ?? {}]));
  const byId = new Map<string, Need>();

  for (const p of projects) {
    for (const raw of needsForProject(p)) {
      // Account-wide items merge by their record id; everything else is keyed by
      // project as well, so two projects asking the same question both get a row.
      const item: Need = {
        ...raw,
        key: raw.accountWide ? raw.id : `${p.path}|${raw.id}`,
        group: GROUP_OF[raw.kind],
        ...(raw.cost ? { costLabel: priceOf(raw.cost), costClass: CLASS_WORD[raw.cost.class] } : {}),
      };
      const seen = byId.get(item.key);
      if (!seen) { byId.set(item.key, item); continue; }
      seen.projects.push(...item.projects);
      mergeCredentialKeys(seen, item);
    }
  }

  const items = [...byId.values()]
    .filter(item => !answeredBy(item, answers))
    .sort((a, b) =>
      GROUP_RANK[groupOf(a)] - GROUP_RANK[groupOf(b)]
      || (a.accountWide === b.accountWide ? 0 : a.accountWide ? -1 : 1)
      || a.project.localeCompare(b.project)
      || a.id.localeCompare(b.id));

  return { items, ledger: ledgerFor(projects, items) };
}

/** The same list, for one project. The strip on a project page shows this. */
export function projectNeeds(all: Need[], path: string): Need[] {
  return all.filter(n => n.projects.some(p => p.path === path));
}

// ─────────────────────────────────────────────────────────────────────────────
// The ledger
// ─────────────────────────────────────────────────────────────────────────────

const emptyBucket = (): LedgerBucket => ({ unavoidable: 0, launchpadsChoice: 0, optional: 0, total: 0 });

const BUCKET_FIELD = {
  'unavoidable': 'unavoidable',
  'launchpads-choice': 'launchpadsChoice',
  'optional': 'optional',
} as const;

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
export function ledgerFor(projects: NeedsProject[], items: Need[]): CostLedger {
  const monthly = emptyBucket(), yearly = emptyBucket(), oneTime = emptyBucket();
  const unpriced: CostLedger['unpriced'] = [];
  const lines: LedgerLine[] = [];

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
  const charged = new Set(
    items.filter(i => i.decision).flatMap(i => i.projects.map(pr => `${pr.path}|${i.decision!.area}`)));

  const put = (line: LedgerLine): void => {
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
      if (!d.money) continue;
      if (charged.has(`${p.path}|${d.area}`)) continue;
      put({ project: p.label, label: `${d.area} — ${d.choice}`, money: d.money, from: 'decision' });
    }
  }
  for (const item of items) {
    if (!item.cost) continue;
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
  const present = new Set<Money['class']>();
  for (const b of [monthly, yearly, oneTime]) {
    if (b.unavoidable) present.add('unavoidable');
    if (b.launchpadsChoice) present.add('launchpads-choice');
    if (b.optional) present.add('optional');
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

const cadenceWord = (c: Money['cadence']): string =>
  ({ 'one-time': 'once', 'monthly': 'a month', 'yearly': 'a year', 'per-minute': 'a minute' })[c];

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

/** `$20 a month`, `$99 a year`, `metered`. One phrasing, shared by the CLI and the page. */
export function priceOf(m: Money | undefined): string {
  if (!m) return '';
  if (m.amount == null) return `metered — billed ${cadenceWord(m.cadence).replace(/^a /, 'per ')}`;
  if (m.amount === 0) return 'free';
  return `$${m.amount} ${cadenceWord(m.cadence)}${m.onlyWhen ? `, ${m.onlyWhen}` : ''}`;
}

export const CLASS_WORD: Record<Money['class'], string> = {
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
export function renderNeeds(
  result: NeedsResult, opts: { runnable?: (command: string) => string } = {},
): string {
  const { items, ledger } = result;
  // `launchpad …` is not on anybody's PATH; the CLI passes the real invocation.
  const run = (c: string) => (opts.runnable ? c.replace(/(^|\| )launchpad(?= )/, (m, pre: string) => `${pre}${opts.runnable!('launchpad')}`) : c);
  const out: string[] = [];
  if (!items.length) {
    out.push('Nothing needs you.');
    out.push('');
    out.push('  Every credential launchpad requires is in your vault, every question it cannot answer');
    out.push('  itself has been answered, and nothing is waiting on a decision only you can make.');
  } else {
    out.push(`${items.length} thing${items.length === 1 ? '' : 's'} need${items.length === 1 ? 's' : ''} you.`);
    for (const g of NEED_GROUPS) {
      const mine = items.filter(i => groupOf(i) === g.id);
      if (!mine.length) continue;
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
        if (n.warning) out.push(...wrap(`! ${n.warning}`, 4));
        if (a.type === 'paste-credential') {
          // The keys the act produces, each said once, with what is already
          // done marked — a card is one job, and this is its checklist.
          for (const k of a.keys) out.push(`    ${k.present ? '✓' : '·'} ${k.vaultKey}   ${k.what}`);
          for (const cmd of a.commands) out.push(`    → ${run(cmd)}`);
        } else out.push(`    → ${a.label}`);
      }
    }
  }

  out.push('');
  out.push('What this fleet costs');
  const bucket = (label: string, b: LedgerBucket, suffix: string): void => {
    if (!b.total) return;
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
  } else if (ledger.perYear) {
    out.push(`  $${ledger.perYear} a year in total, before anything metered.`);
  }
  for (const u of ledger.unpriced) {
    out.push(`  · ${u.label}${u.project ? ` (${u.project})` : ''} — ${collapse(u.why)}`);
  }
  out.push('');
  return out.join('\n');
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Soft-wrap a sentence to 92 columns at the given indent. */
function wrap(text: string, indent: number): string[] {
  const pad = ' '.repeat(indent);
  // `**emphasis**` is for the page; a terminal would print the asterisks.
  const words = collapse(text).replace(/\*\*/g, '').split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > 88) { lines.push(pad + line); line = w; }
    else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(pad + line);
  return lines;
}
