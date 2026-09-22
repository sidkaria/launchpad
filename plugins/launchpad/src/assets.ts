import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Archetype, LaunchpadState, Surface } from './types.js';

/**
 * Store presence: the icon, and everything else a store demands before it will
 * show your app to anyone.
 *
 * This is the launchpad thesis in miniature. Nobody fails to ship because they
 * could not write the code; they fail because Play will not publish a listing
 * without a 1024×500 feature graphic, or because App Store Connect rejects a
 * 1024px icon that has an alpha channel — and neither of those is a thing you
 * find out until you are already trying to submit. Naming them up front is
 * worth more than automating them.
 *
 * Detection is deliberately generous. A project may keep its icon in Xcode's
 * asset catalogue, in Flutter's mipmaps, in `public/`, or in a fastlane
 * metadata tree, and reporting "no icon" for an app that plainly has one is the
 * worst kind of false alarm — it is the failure the scorecard already paid for
 * once with the privacy-policy check.
 */

export interface ImageInfo {
  path: string;          // repo-relative
  width: number;
  height: number;
  /** PNG colour type 4 or 6. The App Store rejects an icon that has one. */
  hasAlpha: boolean;
}

export interface StoreAssets {
  /** The best icon found — largest square. Used for display everywhere. */
  icon?: ImageInfo;
  /** Every icon candidate, largest first. */
  icons: ImageInfo[];
  /** Play's 1024×500 feature graphic. Without it the listing cannot publish. */
  featureGraphic?: ImageInfo;
  /** Store screenshots, wherever they live. */
  screenshots: string[];
  /** A fastlane (or equivalent) metadata tree — descriptions, keywords. */
  listingDir?: string;
  /** `og:image` for a web surface — what a shared link looks like. */
  ogImage?: string;
}

const SKIP = new Set([
  'node_modules', '.git', 'build', 'dist', '.next', '.dart_tool', 'Pods', 'DerivedData',
  'vendor', '.venv', 'target', '.gradle', 'coverage', '.claude', '.worktrees', 'ios/.symlinks',
]);

/**
 * PNG header only — width, height and colour type live in the IHDR chunk at a
 * fixed offset. Reading 26 bytes beats adding an image dependency to a tool
 * whose whole point is that it installs cleanly on someone else's machine.
 */
export function pngInfo(buf: Buffer): { width: number; height: number; hasAlpha: boolean } | null {
  if (buf.length < 26) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;   // \x89PNG
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  const colorType = buf.readUInt8(25);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    // 4 = grey+alpha, 6 = RGBA. Palette (3) can carry tRNS but Apple's check is
    // about the alpha channel, so this is the honest read of it.
    hasAlpha: colorType === 4 || colorType === 6,
  };
}

function readImage(repo: string, rel: string): ImageInfo | null {
  try {
    const info = pngInfo(readFileSync(join(repo, rel)));
    return info ? { path: rel, ...info } : null;
  } catch {
    return null;
  }
}

/**
 * Depth-limited walk.
 *
 * Ten, not six. A Flutter monorepo keeps Android launcher icons at
 * `apps/mobile/android/app/src/main/res/mipmap-xxxhdpi/` — eight directories
 * down — and a shallower limit silently reports "no icon" for an app that has
 * one. The pruned directories below are what keep this cheap despite the depth.
 */
function walk(repo: string, rel: string, depth: number, hit: (rel: string, name: string) => void): void {
  if (depth < 0) return;
  let entries: string[];
  try { entries = readdirSync(join(repo, rel)); } catch { return; }
  for (const name of entries) {
    if (SKIP.has(name) || name.startsWith('.') && name !== '.well-known') continue;
    const child = rel ? join(rel, name) : name;
    let isDir = false;
    try { isDir = statSync(join(repo, child)).isDirectory(); } catch { continue; }
    if (isDir) walk(repo, child, depth - 1, hit);
    else hit(child, name);
  }
}

export function detectAssets(repo: string, state: LaunchpadState): StoreAssets {
  const kinds = new Set(state.surfaces.map(s => s.archetype));
  const icons: ImageInfo[] = [];
  const screenshots: string[] = [];
  let featureGraphic: ImageInfo | undefined;
  let listingDir: string | undefined;
  let ogImage: string | undefined;

  walk(repo, '', 10, (rel, name) => {
    const lower = rel.toLowerCase();
    const isPng = name.toLowerCase().endsWith('.png');

    // Icons: Xcode asset catalogues, Android mipmaps, web favicons.
    if (isPng && (
      lower.includes('appicon.appiconset/')
      || /(^|\/)(ic_launcher|ic_launcher-playstore|icon|app_icon|appicon)\.png$/.test(lower)
      || /(^|\/)(public|static|assets)\/(favicon|apple-touch-icon|icon)[^/]*\.png$/.test(lower)
      || /(^|\/)app\/(icon|apple-icon)\.png$/.test(lower)
    )) {
      const img = readImage(repo, rel);
      // Square only: a wide image in an icon directory is a banner, and a
      // 1024×500 feature graphic would otherwise be reported as the app icon.
      if (img && img.width === img.height) icons.push(img);
      if (img && /featuregraphic|feature_graphic/.test(lower)) featureGraphic = img;
    }
    if (isPng && /featuregraphic|feature_graphic/.test(lower)) {
      const img = readImage(repo, rel);
      if (img) featureGraphic = img;
    }
    if (/screenshots?\//.test(lower) && /\.(png|jpe?g)$/.test(lower)) screenshots.push(rel);
    if (/(^|\/)fastlane\/metadata(\/|$)/.test(lower) && !listingDir) {
      listingDir = rel.slice(0, lower.indexOf('/metadata') + '/metadata'.length);
    }
    if (!ogImage && /(^|\/)(public|static)\/(og|og-image|opengraph|social)[^/]*\.(png|jpe?g)$/.test(lower)) {
      ogImage = rel;
    }
  });

  icons.sort((a, b) => b.width - a.width);
  // An .icns has no readable dimensions here, but its presence still answers
  // "does this Mac app have an icon at all".
  if (!icons.length && kinds.has('macos-dmg')) {
    walk(repo, '', 10, rel => {
      if (rel.toLowerCase().endsWith('.icns') && !icons.length) {
        icons.push({ path: rel, width: 0, height: 0, hasAlpha: false });
      }
    });
  }

  return { icon: icons[0], icons, featureGraphic, screenshots, listingDir, ogImage };
}

/**
 * Requirements per archetype, so the check can name the exact number.
 *
 * `noAlpha` is **iOS only**, and getting that wrong is worse than not checking.
 * Apple rejects a 1024 marketing icon with an alpha channel because an iOS icon
 * is a full-bleed square the system masks itself. A macOS icon is the opposite:
 * it is *supposed* to have transparency, because the rounded-rectangle shape
 * and its margins are part of the artwork. Flagging alpha on a Mac icon would
 * send someone to break a correct asset.
 *
 * A `macos-dmg` surface ships via Developer ID anyway — direct download, no
 * review — so there is no listing to reject it in the first place.
 */
export const ICON_REQUIREMENT: Partial<Record<Archetype, { size: number; store: string; noAlpha: boolean }>> = {
  'ios': { size: 1024, store: 'the App Store', noAlpha: true },
  'macos-dmg': { size: 1024, store: 'a Mac app', noAlpha: false },
  'android': { size: 512, store: 'Play', noAlpha: false },
};

/** Does this project ship to a store that has a listing to fill in? */
export const hasStoreSurface = (s: Surface[]): boolean =>
  s.some(x => x.archetype === 'ios' || x.archetype === 'android' || x.archetype === 'macos-dmg');
