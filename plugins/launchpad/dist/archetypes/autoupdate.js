import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { writeGuarded } from '../generated.js';
export const SPARKLE_SPM = { url: 'https://github.com/sparkle-project/Sparkle', from: '2.9.3' };
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'autoupdate');
const tmpl = (n) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');
export function planAutoupdateFiles(opts) {
    return [{ path: `${opts.appSourceDir}/SparkleUpdater.swift`, contents: tmpl('SparkleUpdater.swift') }];
}
/**
 * Guarded, like every other archetype's writer.
 *
 * This one wrote unconditionally, which is how a field fix to a generated
 * workflow got reverted on the next `apply` — silently, and back to shipping
 * commit messages as release notes. `writeGuarded` keeps somebody else's file,
 * keeps an edit to ours, and rewrites only our own untouched output.
 */
export function writeAutoupdateFiles(repo, opts) {
    return writeGuarded(repo, planAutoupdateFiles(opts));
}
export function injectSparklePackage(projectYml, macosTarget) {
    const doc = parse(projectYml);
    doc.packages = doc.packages ?? {};
    if (!doc.packages.Sparkle) {
        doc.packages.Sparkle = { url: SPARKLE_SPM.url, from: SPARKLE_SPM.from };
    }
    const target = doc.targets?.[macosTarget];
    if (target) {
        target.dependencies = target.dependencies ?? [];
        const present = target.dependencies.some((d) => d && d.package === 'Sparkle');
        if (!present)
            target.dependencies.push({ package: 'Sparkle', product: 'Sparkle' });
    }
    return stringify(doc);
}
export function wireAutoupdate(repo, c) {
    if (!c.appSourceDir || !c.publicEdKey)
        return [];
    const { appSourceDir, publicEdKey } = c; // narrowed here, not inside the closures below
    const changed = [];
    // Report what the guarded write actually did, not what it was asked to do:
    // a SparkleUpdater.swift somebody has edited is KEPT, and saying "updated"
    // about a file nothing touched is the same false claim as below.
    const res = writeAutoupdateFiles(repo, { appSourceDir });
    changed.push(...res.written.map(f => f.path));
    // These two are the USER's files, edited in place — so write only when the
    // bytes actually move, the way `wireDevBuild`, `wireFlutterFlavors` and
    // `wireAndroidReleaseSigning` all do. Writing unconditionally rewrote a
    // project.yml that needed nothing (a YAML round-trip is not byte-preserving:
    // comments and quoting styles do not survive it) and then reported the file
    // as "updated" on every single apply, which is a claim with nothing behind it.
    const patch = (relPath, fn) => {
        const abs = join(repo, relPath);
        if (!existsSync(abs))
            return;
        const orig = readFileSync(abs, 'utf8');
        const next = fn(orig);
        if (next === orig)
            return;
        writeFileSync(abs, next, 'utf8');
        changed.push(relPath);
    };
    // NOTE: c.scheme is used as the xcodegen target name (they match by convention).
    patch('project.yml', (s) => injectSparklePackage(s, c.scheme));
    const feedUrl = `https://${c.appcastDomain}/appcast.xml`;
    patch(`${appSourceDir}/Info.plist`, (s) => injectAutoupdateInfoPlistKeys(s, { feedUrl, publicEdKey }));
    return changed;
}
export function injectAutoupdateInfoPlistKeys(plist, opts) {
    const desired = [
        ['SUFeedURL', `<string>${opts.feedUrl}</string>`],
        ['SUPublicEDKey', `<string>${opts.publicEdKey}</string>`],
        ['SUEnableAutomaticChecks', `<true/>`],
        ['SUScheduledCheckInterval', `<integer>86400</integer>`],
    ];
    let out = plist;
    const toInsert = [];
    for (const [key, valueEl] of desired) {
        // Match <key>KEY</key> + following value element (string/true/false/integer).
        const re = new RegExp(`(<key>${key}</key>\\s*)(<string>[^<]*</string>|<true\\s*/>|<false\\s*/>|<integer>[^<]*</integer>)`);
        if (re.test(out)) {
            out = out.replace(re, (_m, p1) => p1 + valueEl); // refresh value (re-key-safe)
        }
        else {
            toInsert.push(`    <key>${key}</key>\n    ${valueEl}`);
        }
    }
    if (toInsert.length) {
        const idx = out.lastIndexOf('</dict>'); // top-level dict close (after any nested dicts)
        out = out.slice(0, idx) + toInsert.join('\n') + '\n' + out.slice(idx);
    }
    return out;
}
