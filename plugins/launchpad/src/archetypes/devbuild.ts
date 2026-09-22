import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';

export function injectDevConfig(
  projectYml: string,
  target: string,
  appName: string,
  opts?: { devIconName?: string },
): string {
  const doc = parse(projectYml) as any;
  const t = doc.targets?.[target];
  const baseId = t?.settings?.base?.PRODUCT_BUNDLE_IDENTIFIER;
  if (!t || !baseId) return projectYml;
  t.settings.configs = t.settings.configs ?? {};
  const debug: Record<string, string> = {
    PRODUCT_NAME: `${appName} Dev`,
    PRODUCT_BUNDLE_IDENTIFIER: `${baseId}.dev`,
    SWIFT_ACTIVE_COMPILATION_CONDITIONS: 'DEBUG',
  };
  if (opts?.devIconName) debug.ASSETCATALOG_COMPILER_APPICON_NAME = opts.devIconName;
  t.settings.configs.Debug = { ...(t.settings.configs.Debug ?? {}), ...debug };
  return stringify(doc);
}

export function wireDevBuild(
  repo: string,
  c: { scheme: string; appName: string; appSourceDir?: string },
): string[] {
  const pyPath = join(repo, 'project.yml');
  if (!existsSync(pyPath)) return [];
  const hasDevIcon = !!c.appSourceDir
    && existsSync(join(repo, c.appSourceDir, 'Assets.xcassets', 'AppIcon-Dev.appiconset'));
  const orig = readFileSync(pyPath, 'utf8');
  const updated = injectDevConfig(orig, c.scheme, c.appName, hasDevIcon ? { devIconName: 'AppIcon-Dev' } : undefined);
  if (updated === orig) return [];
  writeFileSync(pyPath, updated, 'utf8');
  return ['project.yml'];
}

/**
 * XcodeGen does not emit a shared scheme by default, so on a fresh CI runner
 * `fastlane gym` can't find the target scheme (it falls back to the project name
 * → "no scheme named <Project>"). Inject a shared scheme for the app target into
 * project.yml (idempotent; no-op if there's no project.yml, no matching target,
 * or the scheme is already defined).
 */
export function ensureXcodegenScheme(repo: string, scheme: string): string[] {
  const pyPath = join(repo, 'project.yml');
  if (!existsSync(pyPath)) return [];
  const orig = readFileSync(pyPath, 'utf8');
  const doc = parse(orig) as any;
  if (!doc?.targets?.[scheme]) return [];      // scheme must name a real target
  if (doc.schemes?.[scheme]) return [];        // already has a shared scheme
  doc.schemes = doc.schemes ?? {};
  doc.schemes[scheme] = {
    build: { targets: { [scheme]: 'all' } },
    run: { config: 'Debug' },
    archive: { config: 'Release' },
  };
  const updated = stringify(doc);
  if (updated === orig) return [];
  writeFileSync(pyPath, updated, 'utf8');
  return ['project.yml'];
}

export function generateDevIconSvg(baseSvg: string): string {
  const m = baseSvg.match(/viewBox\s*=\s*"\s*([\d.+-]+)[\s,]+([\d.+-]+)[\s,]+([\d.+-]+)[\s,]+([\d.+-]+)\s*"/);
  if (!m) throw new Error('generateDevIconSvg: no viewBox found in base SVG');
  const X = parseFloat(m[1]), Y = parseFloat(m[2]), W = parseFloat(m[3]), H = parseFloat(m[4]);
  const band = H * 0.26;
  const overlay =
    `  <!-- launchpad dev badge -->\n` +
    `  <rect x="${X}" y="${Y}" width="${W}" height="${H}" fill="#000000" opacity="0.10"/>\n` +
    `  <rect x="${X}" y="${Y}" width="${W}" height="${band.toFixed(2)}" fill="#1a1a1a" opacity="0.92"/>\n` +
    `  <text x="${(X + W / 2).toFixed(2)}" y="${(Y + band * 0.72).toFixed(2)}" ` +
    `font-family="Helvetica, Arial, sans-serif" font-size="${(H * 0.16).toFixed(2)}" font-weight="bold" ` +
    `fill="#ffffff" text-anchor="middle" letter-spacing="${(W * 0.02).toFixed(2)}">DEV</text>\n`;
  const idx = baseSvg.lastIndexOf('</svg>');
  return baseSvg.slice(0, idx) + overlay + baseSvg.slice(idx);
}
