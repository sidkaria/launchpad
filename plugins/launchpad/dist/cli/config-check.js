/**
 * The settings `apply` cannot wire a surface without.
 *
 * A config gathered by hand, by an older launchpad or by an agent that
 * stopped halfway can be missing one of them, and `apply` used to render it
 * anyway: an absent `appName` became `.github/workflows/launchpad-undefined-site.yml`
 * with the word `undefined` inside, reported as "wired". The generators treat
 * their config as complete (that is their contract), so the check belongs here,
 * at the one place a half-gathered config meets them.
 *
 * Deliberately short: only fields every surface of that archetype must have and
 * that name files or targets. `test/cli.test.ts` fails if one of these stops
 * being a required field of its archetype's `*Config` interface.
 */
export const REQUIRED_CONFIG = {
    'static-site': ['appName', 'siteDir', 'pagesProject'],
    'web-app': ['project', 'rootDir'],
    'ios': ['appName', 'bundleId', 'workdir', 'testBranch'],
    'android': ['appName', 'workdir', 'testBranch'],
    'macos-dmg': ['appName', 'scheme', 'xcodeproj', 'r2Bucket', 'appcastDomain', 'tagPrefix'],
};
/** Which required settings are absent. An empty string counts as set: `''` is a real answer for some. */
export function missingConfig(archetype, config) {
    const c = (config ?? {});
    return (REQUIRED_CONFIG[archetype] ?? []).filter(f => c[f] === undefined || c[f] === null);
}
