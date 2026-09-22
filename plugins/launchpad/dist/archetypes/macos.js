import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { writeGuarded } from '../generated.js';
// Global secrets injected from the vault; per-app secrets generated per repo.
export const MACOS_GLOBAL_SECRETS = [
    'DEVELOPER_ID_CERT_P12', 'DEVELOPER_ID_CERT_PASSWORD', 'DEVELOPER_ID_CERT',
    'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD', 'KEYCHAIN_PASSWORD',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
];
export const MACOS_PER_APP_SECRETS = ['SPARKLE_PRIVATE_KEY'];
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'macos');
function loadTemplate(name) {
    return readFileSync(join(TEMPLATES_DIR, name), 'utf8');
}
function templateVars(config) {
    return {
        APP_NAME: config.appName,
        SCHEME: config.scheme,
        XCODEPROJ: config.xcodeproj,
        R2_BUCKET: config.r2Bucket,
        APPCAST_DOMAIN: config.appcastDomain,
        TAG_PREFIX: config.tagPrefix,
        PREBUILD: config.prebuild,
    };
}
export function planMacosFiles(config) {
    const vars = templateVars(config);
    return [
        { path: '.launchpad/macos/create-dmg.sh', contents: render(loadTemplate('create-dmg.sh'), vars) },
        {
            path: `.github/workflows/launchpad-${config.scheme}-macos.yml`,
            contents: render(loadTemplate('release.yml'), vars),
        },
    ];
}
/**
 * Guarded, like every other archetype's writer.
 *
 * This one wrote unconditionally, which is how a field fix to a generated
 * workflow got reverted on the next `apply` — silently, and back to shipping
 * commit messages as release notes. `writeGuarded` keeps somebody else's file,
 * keeps an edit to ours, and rewrites only our own untouched output.
 */
export function writeMacosFiles(repo, config) {
    return writeGuarded(repo, planMacosFiles(config));
}
