import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';
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

// ───────────────────────────────────────────────────── the same badge, on a PNG

/**
 * The DEV badge `generateDevIconSvg` draws, applied to an already-rendered PNG:
 * a 10% black tint over the whole icon, a near-black band across the top 26%
 * at 0.92 opacity, and "DEV" in white inside the band.
 *
 * It exists because a Flutter app has no SVG master — its asset catalog is a
 * ladder of PNGs — and its dev flavour named an `AppIcon-dev` set that nothing
 * rendered, so the dev iOS build died in `actool`. Pure Node (`zlib` only): the
 * product stays single-dependency and never shells out to an image tool the
 * buyer may not have.
 *
 * Returns `null` for a PNG this does not decode (interlaced, or not a PNG at
 * all), so the caller can copy the original unbadged — a dev icon that looks
 * like prod is cosmetic; a missing one is a failed build.
 *
 * Alpha is preserved exactly: an opaque icon stays opaque with no alpha channel
 * (the App Store refuses an icon that has one), a transparent pixel stays
 * transparent.
 */
export function badgeDevPng(png: Buffer): Buffer | null {
  const img = decodePng(png);
  if (!img) return null;
  const { width: W, height: H, rgba } = img;

  const band = Math.round(H * 0.26);
  const blend = (i: number, rgb: readonly number[], a: number) => {
    for (let k = 0; k < 3; k++) rgba[i + k] = Math.round(rgba[i + k] * (1 - a) + rgb[k] * a);
  };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      blend(i, [0, 0, 0], 0.10);
      if (y < band) blend(i, [0x1a, 0x1a, 0x1a], 0.92);
    }
  }

  // "DEV" from a 5×7 bitmap font, nearest-neighbour scaled into the band. Below
  // one pixel per font cell there is nothing legible to draw; the band alone
  // still tells a 20pt icon apart from prod.
  const cols = GLYPHS.length * 5 + (GLYPHS.length - 1);   // a blank column between letters
  const cell = Math.min((band * 0.62) / 7, (W * 0.8) / cols);
  if (cell >= 1) {
    const textW = cols * cell;
    const textH = 7 * cell;
    const x0 = (W - textW) / 2;
    const y0 = (band - textH) / 2;
    for (let y = Math.max(0, Math.floor(y0)); y < Math.min(band, Math.ceil(y0 + textH)); y++) {
      const row = Math.floor((y + 0.5 - y0) / cell);
      if (row < 0 || row > 6) continue;
      for (let x = Math.max(0, Math.floor(x0)); x < Math.min(W, Math.ceil(x0 + textW)); x++) {
        const col = Math.floor((x + 0.5 - x0) / cell);
        const g = Math.floor(col / 6);
        if (col < 0 || g >= GLYPHS.length || col % 6 === 5) continue;
        if (GLYPHS[g][row][col % 6] === '1') blend((y * W + x) * 4, [255, 255, 255], 1);
      }
    }
  }
  return encodePng(W, H, rgba, img.hasAlpha, img.keep);
}

const GLYPHS: string[][] = [
  ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],   // D
  ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],   // E
  ['10001', '10001', '10001', '10001', '01010', '01010', '00100'],   // V
];

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Ancillary chunks that describe colour, not pixels — safe to carry across a re-encode. */
const KEEP_CHUNKS = new Set(['gAMA', 'cHRM', 'sRGB', 'iCCP', 'pHYs']);

interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
  hasAlpha: boolean;
  keep: Buffer[];   // whole ancillary chunks (length + type + data + crc), in file order
}

function decodePng(buf: Buffer): DecodedPng | null {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let off = 8;
  let ihdr: Buffer | undefined;
  let plte: Buffer | undefined;
  let trns: Buffer | undefined;
  const idat: Buffer[] = [];
  const keep: Buffer[] = [];
  while (off + 12 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > buf.length) return null;
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') ihdr = data;
    else if (type === 'PLTE') plte = data;
    else if (type === 'tRNS') trns = data;
    else if (type === 'IDAT') idat.push(data);
    else if (KEEP_CHUNKS.has(type)) keep.push(buf.subarray(off, off + 12 + len));
    off += 12 + len;
    if (type === 'IEND') break;
  }
  if (!ihdr || ihdr.length < 13 || !idat.length) return null;
  const width = ihdr.readUInt32BE(0);
  const height = ihdr.readUInt32BE(4);
  const depth = ihdr[8];
  const ctype = ihdr[9];
  if (ihdr[12] !== 0) return null;                     // Adam7 interlace — copied unbadged
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[ctype];
  if (!channels || !width || !height || width * height > 4096 * 4096) return null;
  if (![1, 2, 4, 8, 16].includes(depth)) return null;
  if (ctype === 3 && (!plte || depth === 16)) return null;
  if ((ctype === 2 || ctype === 4 || ctype === 6) && depth < 8) return null;

  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }
  const bpp = Math.max(1, (channels * depth) >> 3);   // filter distance, in bytes
  const stride = Math.ceil((width * channels * depth) / 8);
  if (raw.length < height * (stride + 1)) return null;

  const px = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? px[dst + x - bpp] : 0;
      const b = y > 0 ? px[dst - stride + x] : 0;
      const c = x >= bpp && y > 0 ? px[dst - stride + x - bpp] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) return null;
      px[dst + x] = v & 0xff;
    }
  }

  /** The i-th sample of row y as 0-255 (a raw index for a palette image). */
  const sample = (y: number, i: number): number => {
    const row = y * stride;
    if (depth === 8) return px[row + i];
    if (depth === 16) return px[row + i * 2];
    const perByte = 8 / depth;
    const byte = px[row + Math.floor(i / perByte)];
    const v = (byte >> (8 - depth * ((i % perByte) + 1))) & ((1 << depth) - 1);
    return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
  };
  const key = (v: number) => (depth === 16 ? v >> 8 : depth < 8 ? Math.round((v * 255) / ((1 << depth) - 1)) : v);
  const trnsGray = trns && ctype === 0 && trns.length >= 2 ? key(trns.readUInt16BE(0)) : undefined;
  const trnsRgb = trns && ctype === 2 && trns.length >= 6
    ? [key(trns.readUInt16BE(0)), key(trns.readUInt16BE(2)), key(trns.readUInt16BE(4))] : undefined;

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (ctype === 3) {
        const idx = sample(y, x);
        if (idx * 3 + 2 >= plte!.length) return null;
        rgba[o] = plte![idx * 3]; rgba[o + 1] = plte![idx * 3 + 1]; rgba[o + 2] = plte![idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      } else if (ctype === 0 || ctype === 4) {
        const g = sample(y, x * channels);
        rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
        rgba[o + 3] = ctype === 4 ? sample(y, x * channels + 1) : g === trnsGray ? 0 : 255;
      } else {
        const r = sample(y, x * channels), g = sample(y, x * channels + 1), b = sample(y, x * channels + 2);
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
        rgba[o + 3] = ctype === 6 ? sample(y, x * channels + 3)
          : trnsRgb && r === trnsRgb[0] && g === trnsRgb[1] && b === trnsRgb[2] ? 0 : 255;
      }
    }
  }
  // An alpha CHANNEL is kept as one; a tRNS that marks nothing transparent does
  // not earn the output an alpha channel it never had.
  let hasAlpha = ctype === 4 || ctype === 6;
  if (!hasAlpha && trns) {
    for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 255) { hasAlpha = true; break; }
  }
  return { width, height, rgba, hasAlpha, keep };
}

function encodePng(width: number, height: number, rgba: Uint8Array, alpha: boolean, keep: Buffer[]): Buffer {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc(height * (stride + 1));   // every row: filter byte 0 (None)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = y * (stride + 1) + 1 + x * channels;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = alpha ? 6 : 2;
  return Buffer.concat([
    PNG_SIG,
    pngChunk('IHDR', ihdr),
    ...keep,
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

let CRC_TABLE: Uint32Array | undefined;
function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
