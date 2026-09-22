import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { writeGuarded, type WriteResult } from '../generated.js';

export interface MacosConfig {
  appName: string;       // PRODUCT_NAME / .app + DMG base name
  scheme: string;        // xcodebuild scheme (unique per surface)
  xcodeproj: string;     // e.g. MyApp.xcodeproj
  r2Bucket: string;      // e.g. myapp-updates
  appcastDomain: string; // R2 custom domain, e.g. updates.myapp.com
  tagPrefix: string;     // e.g. "v"
  prebuild: string;      // e.g. "xcodegen generate" or ""
  appSourceDir?: string; // app target's source dir (e.g. "apps/Sender") — where SparkleUpdater.swift + Info.plist live
  publicEdKey?: string;  // per-app Sparkle public key (set by setup after generate_keys)
}

export interface GeneratedFile {
  path: string;          // repo-relative
  contents: string;
}

// Global secrets injected from the vault; per-app secrets generated per repo.
export const MACOS_GLOBAL_SECRETS = [
  'DEVELOPER_ID_CERT_P12', 'DEVELOPER_ID_CERT_PASSWORD', 'DEVELOPER_ID_CERT',
  'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD', 'KEYCHAIN_PASSWORD',
  'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_ACCOUNT_ID',
];
export const MACOS_PER_APP_SECRETS = ['SPARKLE_PRIVATE_KEY'];

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'macos');

function loadTemplate(name: string): string {
  return readFileSync(join(TEMPLATES_DIR, name), 'utf8');
}

function templateVars(config: MacosConfig): Record<string, string> {
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

export function planMacosFiles(config: MacosConfig): GeneratedFile[] {
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
export function writeMacosFiles(repo: string, config: MacosConfig): WriteResult {
  return writeGuarded(repo, planMacosFiles(config));
}
