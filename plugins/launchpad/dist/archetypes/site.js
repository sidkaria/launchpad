import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { writeGuarded } from '../generated.js';
import { pathGlob, repoRelDir } from './triggers.js';
export const SITE_GLOBAL_SECRETS = ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID'];
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'site');
const tmpl = (n) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');
const underDir = (dir, rel) => (repoRelDir(dir) ? `${repoRelDir(dir)}/${rel}` : rel);
/**
 * The `paths:` block of the push trigger, or nothing at all for a root-level
 * site.
 *
 * `siteDir: '.'` used to render `- './**'`. GitHub matches path filters
 * against repository-root-relative paths and does not document a leading `./`
 * as accepted, so that filter may match nothing and the deploy never fire —
 * and a deploy that never fires is indistinguishable from a correct skip
 * (PLAYBOOK §4). At the root there is nothing to filter against, so the whole
 * key is omitted: an absent filter cannot fail to match.
 *
 * Occupies its own line in the template and ends with a newline when set, so
 * the empty case collapses to nothing and the blank line before
 * `permissions:` survives either way.
 */
export function sitePathsFilter(siteDir) {
    const glob = pathGlob(siteDir);
    return glob ? `    paths:\n      - '${glob}'\n` : '';
}
export function planSiteFiles(c) {
    // `wrangler pages deploy <dir>` wants the root as `.`, not as the empty
    // string — the deploy target and the path filter normalise differently.
    const wfVars = {
        APP_NAME: c.appName,
        SITE_DIR: repoRelDir(c.siteDir) || '.',
        PAGES_PROJECT: c.pagesProject,
        PATHS_FILTER: sitePathsFilter(c.siteDir),
    };
    const files = [
        { path: `.github/workflows/launchpad-${c.appName}-site.yml`, contents: render(tmpl('release.yml'), wfVars) },
    ];
    if (c.appcastUrl) {
        files.push({
            path: underDir(c.siteDir, 'index.html'),
            contents: render(tmpl('index.html'), { APP_NAME: c.appName, TAGLINE: c.tagline, APPCAST_URL: c.appcastUrl }),
        });
    }
    return files;
}
/**
 * Write the static-site pipeline files.
 *
 * Everything goes through `writeGuarded` — the workflow is launchpad's own
 * output and must be stamped, so a fix somebody makes to it in the field
 * survives the next `apply` and is reported, exactly as for iOS, Android and
 * macOS. This archetype used to write with a bare `writeFileSync`, which meant
 * no stamp, no `edited` category, and a hand-added `fetch-depth: 0` reverted
 * without a word (harness/FINDINGS.md F-05).
 *
 * `index.html` is the one deliberate exception, and it is a *stricter* guard
 * rather than a weaker one: HTML has no safe universal comment form, so
 * `writeGuarded` can never stamp it (see `stampLine`), which means once it
 * exists launchpad cannot distinguish its own scaffold from the themed page a
 * person or the onboard skill put there. It is scaffolding — offered when
 * absent, never regenerated. Routing it through `writeGuarded` would be laxer:
 * a themed page that happens to mention "launchpad" in its first four lines
 * would read as launchpad's own and be overwritten.
 */
export function writeSiteFiles(repo, c) {
    const files = planSiteFiles(c).filter(f => !(f.path.endsWith('index.html') && existsSync(join(repo, f.path))));
    return writeGuarded(repo, files);
}
