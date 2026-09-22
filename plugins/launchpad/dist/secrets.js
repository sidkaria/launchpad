import { iosSecrets, isWireable, IOS_CLOUD_SECRETS, IOS_MATCH_SECRETS } from './archetypes/ios.js';
import { MACOS_GLOBAL_SECRETS, MACOS_PER_APP_SECRETS } from './archetypes/macos.js';
import { ANDROID_GLOBAL_SECRETS, androidFramework, androidIsWireable } from './archetypes/android.js';
import { SITE_GLOBAL_SECRETS } from './archetypes/site.js';
import { WEB_GLOBAL_SECRETS } from './archetypes/web.js';
/**
 * GitHub Actions secret name -> Keychain vault key. The vault stores creds under
 * lowercase, service-namespaced keys (see doctor); the default mapping is just
 * the lowercased secret name, so only the few whose vault key differs are listed.
 */
const VAULT_KEY_OVERRIDES = {
    ASC_KEY_P8: 'asc_api_key', // the vault holds the raw .p8 as asc_api_key
    CLOUDFLARE_API_TOKEN: 'cloudflare_token',
};
export function vaultKeyFor(secretName) {
    return VAULT_KEY_OVERRIDES[secretName] ?? secretName.toLowerCase();
}
/**
 * Every secret launchpad knows how to inject, grouped by what needs it.
 *
 * `doctor` uses this when it is run OUTSIDE a wired repo, where there is no
 * state to scope the check against. Inside a repo, `requiredVaultKeys` gives
 * the exact set that project needs — checking a hardcoded list there is how
 * doctor used to report all-✓ on a machine that could not notarize or build
 * Android.
 */
export const SECRET_CATALOGUE = [
    { label: 'iOS — App Store Connect (cloud signing, the default)', secrets: IOS_CLOUD_SECRETS },
    { label: 'iOS — shared certs repo (only when signing: match)', secrets: IOS_MATCH_SECRETS },
    { label: 'macOS — Developer ID signing, notarization, R2 distribution', secrets: MACOS_GLOBAL_SECRETS },
    { label: 'Android — Firebase App Distribution + upload keystore', secrets: ANDROID_GLOBAL_SECRETS },
    { label: 'Static site — Cloudflare Pages', secrets: SITE_GLOBAL_SECRETS },
    { label: 'Web app — Vercel', secrets: WEB_GLOBAL_SECRETS },
];
/** Per-app secrets, which are never global vault keys. Surfaced, not checked. */
export const PER_APP_SECRETS = MACOS_PER_APP_SECRETS;
/**
 * The vault keys a project actually needs, derived from its surfaces. Sorted
 * and deduped so it is stable in `state.yml` (a set that reorders on every run
 * would break the idempotent fixed point).
 */
export function requiredVaultKeys(state) {
    return [...new Set(requiredSecrets(state).global.map(vaultKeyFor))].sort();
}
/** The GitHub secrets a repo needs, unioned across its configured surfaces. */
export function requiredSecrets(state) {
    const global = new Set();
    const perApp = new Set();
    const add = (set, names) => names.forEach(n => set.add(n));
    for (const s of state.surfaces) {
        // A surface `apply` will refuse by framework (native Gradle Android, React
        // Native, Expo) needs nothing from launchpad's pipeline, because there is no
        // pipeline. Listing its keystore and store credentials as REQUIRED read as a
        // shopping list for something that would never be written — an L2 run
        // watched an agent turn that list into a promise. The refusal text already
        // tells the reader what a real release will need; this list is only what
        // launchpad itself will consume.
        if (s.archetype === 'android' && !androidIsWireable(androidFramework(s.config, s)))
            continue;
        if (s.archetype === 'ios' && s.framework && !isWireable(s.framework))
            continue;
        switch (s.archetype) {
            case 'ios':
                // Before the skill has gathered config, the signing mode is unknown —
                // assume the documented default (cloud) so a freshly-detected repo
                // still reports the ASC key it will certainly need. Every other
                // archetype's secrets are config-independent already.
                add(global, s.config ? iosSecrets(s.config) : IOS_CLOUD_SECRETS);
                break;
            case 'macos-dmg':
                add(global, MACOS_GLOBAL_SECRETS);
                add(perApp, MACOS_PER_APP_SECRETS);
                break;
            case 'android':
                add(global, ANDROID_GLOBAL_SECRETS);
                break;
            case 'static-site':
                add(global, SITE_GLOBAL_SECRETS);
                break;
            case 'web-app':
                add(global, WEB_GLOBAL_SECRETS);
                break;
        }
    }
    return { global: [...global], perApp: [...perApp] };
}
