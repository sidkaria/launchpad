import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readRegistry, writeRegistry } from '../registry.js';
import { demoCode } from './demo.js';
/**
 * Fernweh is the project the camera follows: three surfaces, so the widest
 * spread of checks resolve, and it ends two short of finished rather than
 * perfect — which is both truer and a better advertisement, because the two
 * that remain are the ones nobody knew about.
 */
const LEAD = 'fernweh';
const BEATS = [
    { path: '.launchpad/state.yml', says: 'onboarded — three surfaces detected' },
    { path: '.gitignore', says: 'secrets are out of the repository' },
    { path: '.github/workflows/launchpad-validate.yml', says: 'builds in CI, and tests gate every push' },
    { path: 'apps/mobile/android/app/build.gradle.kts', says: 'Android release signs with a real key' },
    { path: 'docs/privacy.md', says: 'privacy policy — a rejection, not a nag' },
    { path: 'apps/mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset', says: 'app icon the store will accept' },
    { path: 'package.json', says: 'analytics and a paywall are wired' },
    { path: 'fastlane', says: 'store listing assets' },
    { path: '.launchpad/confirmed.yml', says: 'upload keystore confirmed backed up' },
    { path: '.git/refs/tags', says: 'a release has actually gone out' },
];
/**
 * Take the fleet apart, then put it back together on a timer.
 *
 * Deliberately destructive-then-restorative rather than built-up-from-nothing:
 * the end state has to be exactly the fleet `--demo` shows without `--replay`,
 * or the recording would end somewhere the screenshots do not.
 */
export function startReplay(home, opts = {}) {
    const root = dirname(home);
    const code = demoCode(root);
    const lead = join(code, LEAD);
    const stash = join(root, 'replay-stash');
    rmSync(stash, { recursive: true, force: true });
    mkdirSync(stash, { recursive: true });
    // The whole fleet, remembered, then reduced to the one project the sequence
    // follows — as if it had just been added and nothing else existed yet.
    const full = readRegistry(home).projects;
    const leadEntry = full.find(p => p.path === lead);
    writeRegistry({ projects: leadEntry ? [leadEntry] : [] }, home);
    const pulled = [];
    for (const beat of BEATS) {
        const from = join(lead, beat.path);
        if (!existsSync(from))
            continue;
        const to = join(stash, beat.path);
        mkdirSync(dirname(to), { recursive: true });
        renameSync(from, to);
        pulled.push(beat);
    }
    // The other projects arrive after the lead has finished resolving, so the
    // camera sees one thing at a time rather than seven at once.
    const rest = full.filter(p => p.path !== lead);
    let i = 0;
    const onBeat = opts.onBeat ?? (() => undefined);
    const step = () => {
        if (i < pulled.length) {
            const beat = pulled[i++];
            const to = join(lead, beat.path);
            mkdirSync(dirname(to), { recursive: true });
            try {
                renameSync(join(stash, beat.path), to);
            }
            catch { /* already restored */ }
            onBeat(beat.says);
            return true;
        }
        const n = i - pulled.length;
        // Everything is back where it belongs; the empty shell of the stash is
        // litter in somebody's temp directory.
        if (n === 0)
            rmSync(stash, { recursive: true, force: true });
        if (n < rest.length) {
            i++;
            const reg = readRegistry(home);
            reg.projects.push(rest[n]);
            reg.projects.sort((a, b) => a.path.localeCompare(b.path));
            writeRegistry(reg, home);
            onBeat(`+ ${rest[n].path.split('/').pop()}`);
            return true;
        }
        return false;
    };
    if (opts.manual)
        return { stop: () => undefined, step };
    let timer = null;
    const tick = () => {
        if (!step()) {
            stop();
            return;
        }
        timer = setTimeout(tick, opts.everyMs ?? 1600);
    };
    const stop = () => { if (timer)
        clearTimeout(timer); timer = null; };
    timer = setTimeout(tick, opts.leadInMs ?? 3000);
    return { stop, step };
}
