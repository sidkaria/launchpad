import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { writeGuarded } from '../generated.js';
/**
 * The sentence every place that describes the macOS surface says about the
 * default. A shipped app's landing page claimed Intel support for months over
 * an arm64-only binary; the default stays arm64 (DECISIONS 2026-09-22), so the
 * only honest thing is to say what it means, in the same words everywhere.
 */
export const MACOS_ARM64_ONLY = 'Apple Silicon only — Intel Macs cannot run it; set `architectures: universal` to include them';
/** What the macOS surface runs on, in words — for DEPLOYMENT.md and anything else a person reads. */
export function macosRunsOn(c) {
    const a = c.architectures ?? 'arm64';
    if (a === 'arm64')
        return MACOS_ARM64_ONLY;
    if (a === 'universal')
        return 'Apple Silicon and Intel Macs (a universal binary: arm64 + x86_64)';
    return `\`architectures: ${String(a)}\` is not a value launchpad knows (arm64 or universal) — \`apply\` refuses it`;
}
/**
 * The xcodebuild flags and the release-log check for a choice. `arm64` adds
 * NOTHING — both are empty strings — which is what keeps an existing surface's
 * generated files byte-identical.
 */
function architectureVars(c) {
    const a = c.architectures ?? 'arm64';
    if (a === 'arm64')
        return { ARCH_FLAGS: '', ARCH_CHECK: '' };
    if (a !== 'universal') {
        throw new Error(`macos-dmg ${c.scheme}: architectures must be 'arm64' or 'universal', not '${String(a)}'`);
    }
    return {
        // A generic destination, or xcodebuild builds for the runner's own
        // architecture; ARCHS + ONLY_ACTIVE_ARCH=NO so every target — the app and
        // each framework it embeds — is built for both.
        ARCH_FLAGS: ' \\\n  -destination \'generic/platform=macOS\' ARCHS="arm64 x86_64" ONLY_ACTIVE_ARCH=NO',
        ARCH_CHECK: [
            '',
            '  # `architectures: universal` is a promise to Intel owners. Fail the release',
            '  # rather than ship them a binary that will not open.',
            '  echo "Requested: universal (arm64 x86_64)"',
            '  for WANT in arm64 x86_64; do',
            '    case " ${ARCHS} " in',
            '      *" ${WANT} "*) ;;',
            '      *) echo "::error::architectures: universal is set, but ${APP_NAME} was built for \'${ARCHS}\' (no ${WANT})."; exit 1 ;;',
            '    esac',
            '  done',
        ].join('\n'),
    };
}
// Global secrets injected from the vault; per-app secrets generated per repo.
export const MACOS_GLOBAL_SECRETS = [
    'DEVELOPER_ID_CERT_P12', 'DEVELOPER_ID_CERT_PASSWORD', 'DEVELOPER_ID_CERT',
    'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD', 'KEYCHAIN_PASSWORD',
    'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
];
export const MACOS_PER_APP_SECRETS = ['SPARKLE_PRIVATE_KEY'];
/**
 * The Sparkle release whose signed tools tarball the workflow downloads to run
 * `generate_appcast`.
 *
 * Pinned, and fetched from Sparkle's own GitHub release rather than Homebrew.
 * The workflow used `brew install sparkle` until Homebrew disabled the cask on
 * 2026-09-01 for failing Gatekeeper — after which every macOS release built from
 * this template died at its second step. This is the version a shipping app's
 * pipeline has since released on, repeatedly; it is the tools only, so it is
 * independent of the framework version the app links (`SPARKLE_SPM`). Bump it
 * deliberately, after a real release on the new version (PLAYBOOK §4).
 */
export const SPARKLE_TOOLS_VERSION = '2.6.4';
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
        SPARKLE_TOOLS_VERSION,
        ...architectureVars(config),
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
