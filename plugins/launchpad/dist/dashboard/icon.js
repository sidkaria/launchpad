import { deflateSync } from 'node:zlib';
/**
 * A tiny PNG writer, and the derived app-mark it exists to draw.
 *
 * Two jobs, both about identity. The fleet view is only scannable when eight
 * apps look like eight apps rather than eight rows of text, so every project
 * needs a mark — and a project that has no icon of its own still needs one that
 * is *its own*, derived from its name so it is stable across restarts and
 * across machines.
 *
 * Written by hand rather than pulled in: the dashboard ships with no
 * dependencies and must work with no network, and an image library would be a
 * build step on a customer's machine for the sake of a few hundred bytes of
 * pixels. `zlib` is in Node already, which is the whole reason this is
 * practical — colour type 2 (RGB, no alpha) also happens to be the one Apple
 * accepts for a 1024 marketing icon.
 */
const CRC = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();
function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++)
        c = CRC[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}
function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}
/** An opaque RGB PNG. `at` is called once per pixel, in scanline order. */
export function png(width, height, at) {
    // One filter byte per scanline (0 = None) then three bytes per pixel.
    const raw = Buffer.alloc(height * (1 + width * 3));
    let o = 0;
    for (let y = 0; y < height; y++) {
        raw[o++] = 0;
        for (let x = 0; x < width; x++) {
            const [r, g, b] = at(x, y);
            raw[o++] = r;
            raw[o++] = g;
            raw[o++] = b;
        }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; // bit depth
    ihdr[9] = 2; // colour type 2 — truecolour, NO alpha channel
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        chunk('IHDR', ihdr),
        chunk('IDAT', deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0)),
    ]);
}
/**
 * A stable number for a string. FNV-1a: not a security hash, just something
 * that spreads short names evenly and gives the same answer on every machine —
 * which is the only property that matters, because a project whose accent
 * changed between two runs would look like a different project.
 */
export function hashOf(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}
/**
 * The hue a project gets when it has no icon to take one from.
 *
 * FNV-1a avalanches properly, so a plain modulo of the whole hash spreads
 * short names across the wheel — an earlier golden-ratio version multiplied the
 * hash by an irrational and took the fraction, which threw away most of the
 * precision and landed two of the seven demo apps on the same green.
 */
export const hueOf = (name) => hashOf(name) % 360;
function hsl(h, s, l) {
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
}
/** Seven marks, so a fleet of eight never shows the same glyph twice in a row. */
const GLYPHS = [
    // ascending bars
    (u, v) => [0.30, 0.47, 0.64].some((x, i) => u > x && u < x + 0.11 && v > 0.62 - i * 0.14 && v < 0.72),
    // ring
    (u, v) => { const d = Math.hypot(u - 0.5, v - 0.5); return d > 0.25 && d < 0.35; },
    // upward chevron
    (u, v) => { const d = Math.abs(u - 0.5) - (0.62 - v); return v > 0.3 && v < 0.72 && d > -0.09 && d < 0.02; },
    // diamond outline
    (u, v) => { const d = Math.abs(u - 0.5) + Math.abs(v - 0.5); return d > 0.24 && d < 0.34; },
    // horizon: a disc sitting on a rule
    (u, v) => Math.hypot(u - 0.5, v - 0.44) < 0.18 || (v > 0.66 && v < 0.72 && u > 0.24 && u < 0.76),
    // four squares
    (u, v) => [0.28, 0.54].some(a => u > a && u < a + 0.18) && [0.28, 0.54].some(b => v > b && v < b + 0.18),
    // bolt
    (u, v) => (v < 0.5 && u > 0.5 - (0.5 - v) * 0.7 && u < 0.62 && v > 0.24)
        || (v >= 0.5 && u > 0.38 && u < 0.5 + (v - 0.5) * 0.7 && v < 0.76),
];
/**
 * The project's mark: a two-stop diagonal field with a white glyph cut into it.
 *
 * Deterministic from the name, so the same project is the same colour every
 * time — on the fleet view, in the sidebar, and in a screenshot taken a month
 * apart.
 */
export function appIcon(name, size = 1024) {
    const h = hueOf(name);
    const g = GLYPHS[hashOf(name) % GLYPHS.length];
    const a = hsl(h, 0.62, 0.52);
    const b = hsl((h + 38) % 360, 0.68, 0.34);
    return png(size, size, (x, y) => {
        const u = x / size, v = y / size;
        if (g(u, v))
            return [252, 253, 255];
        const t = Math.min(1, Math.max(0, (u + v) / 2));
        return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
    });
}
/** A wide still, for the one store asset whose absence blocks a Play listing. */
export function featureGraphic(name, w = 1024, h = 500) {
    const hue = hueOf(name);
    const a = hsl(hue, 0.55, 0.30);
    const b = hsl((hue + 38) % 360, 0.60, 0.18);
    return png(w, h, (x, y) => {
        const t = x / w;
        const band = Math.abs(y / h - 0.5) < 0.02 && x > w * 0.12 && x < w * 0.88;
        if (band)
            return hsl(hue, 0.7, 0.72);
        return [0, 1, 2].map(i => Math.round(a[i] + (b[i] - a[i]) * t));
    });
}
/** A phone-shaped screenshot, so a store-listing check has something to find. */
export function screenshot(name, n, w = 540, h = 1170) {
    const hue = (hueOf(name) + n * 14) % 360;
    const bg = hsl(hue, 0.22, 0.10);
    const card = hsl(hue, 0.30, 0.17);
    const accent = hsl(hue, 0.70, 0.60);
    return png(w, h, (x, y) => {
        if (y > 92 && y < 140 && x > 40 && x < 40 + 260)
            return accent;
        for (let i = 0; i < 6; i++) {
            const top = 190 + i * 150;
            if (y > top && y < top + 118 && x > 36 && x < w - 36)
                return card;
        }
        return bg;
    });
}
