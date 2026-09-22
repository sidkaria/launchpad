import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
const SKIP = new Set([
    'node_modules', '.git', 'build', 'dist', '.next', '.dart_tool', 'Pods', 'DerivedData',
    'vendor', '.venv', 'target', '.gradle', 'coverage', '.claude', '.worktrees', 'ios/.symlinks',
]);
/**
 * PNG header only — width, height and colour type live in the IHDR chunk at a
 * fixed offset. Reading 26 bytes beats adding an image dependency to a tool
 * whose whole point is that it installs cleanly on someone else's machine.
 */
export function pngInfo(buf) {
    if (buf.length < 26)
        return null;
    if (buf.readUInt32BE(0) !== 0x89504e47)
        return null; // \x89PNG
    if (buf.toString('ascii', 12, 16) !== 'IHDR')
        return null;
    const colorType = buf.readUInt8(25);
    return {
        width: buf.readUInt32BE(16),
        height: buf.readUInt32BE(20),
        // 4 = grey+alpha, 6 = RGBA. Palette (3) can carry tRNS but Apple's check is
        // about the alpha channel, so this is the honest read of it.
        hasAlpha: colorType === 4 || colorType === 6,
    };
}
function readImage(repo, rel) {
    try {
        const info = pngInfo(readFileSync(join(repo, rel)));
        return info ? { path: rel, ...info } : null;
    }
    catch {
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
function walk(repo, rel, depth, hit) {
    if (depth < 0)
        return;
    let entries;
    try {
        entries = readdirSync(join(repo, rel));
    }
    catch {
        return;
    }
    for (const name of entries) {
        if (SKIP.has(name) || name.startsWith('.') && name !== '.well-known')
            continue;
        const child = rel ? join(rel, name) : name;
        let isDir = false;
        try {
            isDir = statSync(join(repo, child)).isDirectory();
        }
        catch {
            continue;
        }
        if (isDir)
            walk(repo, child, depth - 1, hit);
        else
            hit(child, name);
    }
}
export function detectAssets(repo, state) {
    const kinds = new Set(state.surfaces.map(s => s.archetype));
    const icons = [];
    const screenshots = [];
    let featureGraphic;
    let listingDir;
    let ogImage;
    walk(repo, '', 10, (rel, name) => {
        const lower = rel.toLowerCase();
        const isPng = name.toLowerCase().endsWith('.png');
        // Icons: Xcode asset catalogues, Android mipmaps, web favicons.
        if (isPng && (lower.includes('appicon.appiconset/')
            || /(^|\/)(ic_launcher|ic_launcher-playstore|icon|app_icon|appicon)\.png$/.test(lower)
            || /(^|\/)(public|static|assets)\/(favicon|apple-touch-icon|icon)[^/]*\.png$/.test(lower)
            || /(^|\/)app\/(icon|apple-icon)\.png$/.test(lower))) {
            const img = readImage(repo, rel);
            // Square only: a wide image in an icon directory is a banner, and a
            // 1024×500 feature graphic would otherwise be reported as the app icon.
            if (img && img.width === img.height)
                icons.push(img);
            if (img && /featuregraphic|feature_graphic/.test(lower))
                featureGraphic = img;
        }
        if (isPng && /featuregraphic|feature_graphic/.test(lower)) {
            const img = readImage(repo, rel);
            if (img)
                featureGraphic = img;
        }
        if (/screenshots?\//.test(lower) && /\.(png|jpe?g)$/.test(lower))
            screenshots.push(rel);
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
export const ICON_REQUIREMENT = {
    'ios': { size: 1024, store: 'the App Store', noAlpha: true },
    'macos-dmg': { size: 1024, store: 'a Mac app', noAlpha: false },
    'android': { size: 512, store: 'Play', noAlpha: false },
};
/** Does this project ship to a store that has a listing to fill in? */
export const hasStoreSurface = (s) => s.some(x => x.archetype === 'ios' || x.archetype === 'android' || x.archetype === 'macos-dmg');
