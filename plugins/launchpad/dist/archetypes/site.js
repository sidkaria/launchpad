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
/** Text and attribute values in the scaffold: a tagline with `&` or `"` is not markup. */
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
/** `https://x.com` and `https://x.com/` are the same origin; paths join onto it with one slash. */
const originOf = (u) => (u.trim() ? u.trim().replace(/\/+$/, '') + '/' : '');
/**
 * The download button's href when JavaScript never runs or the appcast cannot
 * be read. See `SiteConfig.downloadUrl`.
 */
export function siteDownloadUrl(c) {
    if (c.downloadUrl?.trim())
        return c.downloadUrl.trim();
    const dir = c.appcastUrl.replace(/[^/]*$/, '');
    return `${dir}${encodeURIComponent(c.appName)}-latest.dmg`;
}
/** The share image as an absolute URL, or '' when it cannot be made one. */
export function siteOgImage(c) {
    const img = c.ogImage?.trim() ?? '';
    if (!img)
        return '';
    if (/^https?:\/\//i.test(img))
        return img;
    const origin = originOf(c.siteUrl ?? '');
    return origin ? origin + img.replace(/^\.?\/+/, '') : '';
}
/**
 * The `<head>` lines that are only true with an absolute URL behind them. Each
 * ends with a newline so the empty case collapses to nothing.
 */
function headUrls(c) {
    const lines = [];
    const origin = originOf(c.siteUrl ?? '');
    if (origin) {
        lines.push(`<link rel="canonical" href="${esc(origin)}">`, `<meta property="og:url" content="${esc(origin)}">`);
    }
    const img = siteOgImage(c);
    if (img) {
        lines.push(`<meta property="og:image" content="${esc(img)}">`, `<meta name="twitter:image" content="${esc(img)}">`);
    }
    return lines.map(l => `${l}\n`).join('');
}
/**
 * `robots.txt` for the scaffold. Without one — and without a 404.html — Pages
 * answers `/robots.txt` with the homepage and a 200, which is what two shipped
 * sites were doing when they were checked.
 */
export function siteRobots(c) {
    const origin = originOf(c.siteUrl ?? '');
    return ['User-agent: *', 'Allow: /', ...(origin ? ['', `Sitemap: ${origin}sitemap.xml`] : []), ''].join('\n');
}
function siteSitemap(origin) {
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        `  <url><loc>${esc(origin)}</loc></url>`,
        '</urlset>',
        '',
    ].join('\n');
}
/**
 * Files that are scaffolding: written once into a site that has no page yet,
 * never regenerated, and never added to a site that already exists.
 *
 * HTML cannot carry a stamp (see `stampLine`), so once one of these exists
 * launchpad cannot tell its own scaffold from a page somebody built. And the
 * 404 in particular changes routing: an existing site may rely on Pages'
 * serve-index-for-everything fallback for campaign paths like `/ig`, and
 * adding a 404.html there would quietly turn those into dead links.
 */
const SCAFFOLD = /(^|\/)(index\.html|404\.html|robots\.txt|sitemap\.xml)$/;
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
        const img = siteOgImage(c);
        files.push({
            path: underDir(c.siteDir, 'index.html'),
            contents: render(tmpl('index.html'), {
                APP_NAME: esc(c.appName), TAGLINE: esc(c.tagline), APPCAST_URL: c.appcastUrl,
                DOWNLOAD_URL: esc(siteDownloadUrl(c)), HEAD_URLS: headUrls(c),
                TWITTER_CARD: img ? 'summary_large_image' : 'summary',
            }),
        }, { path: underDir(c.siteDir, '404.html'), contents: render(tmpl('404.html'), { APP_NAME: esc(c.appName) }) }, { path: underDir(c.siteDir, 'robots.txt'), contents: siteRobots(c) });
        const origin = originOf(c.siteUrl ?? '');
        if (origin)
            files.push({ path: underDir(c.siteDir, 'sitemap.xml'), contents: siteSitemap(origin) });
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
 * The scaffold (`index.html`, `404.html`, `robots.txt`, `sitemap.xml` — see
 * `SCAFFOLD`) is written only into a site with no `index.html` yet, and each
 * file only if absent. `index.html` is the case that set the rule, and it is a *stricter* guard
 * rather than a weaker one: HTML has no safe universal comment form, so
 * `writeGuarded` can never stamp it (see `stampLine`), which means once it
 * exists launchpad cannot distinguish its own scaffold from the themed page a
 * person or the onboard skill put there. It is scaffolding — offered when
 * absent, never regenerated. Routing it through `writeGuarded` would be laxer:
 * a themed page that happens to mention "launchpad" in its first four lines
 * would read as launchpad's own and be overwritten.
 */
export function writeSiteFiles(repo, c) {
    const siteExists = existsSync(join(repo, underDir(c.siteDir, 'index.html')));
    const files = planSiteFiles(c).filter(f => !(SCAFFOLD.test(f.path) && (siteExists || existsSync(join(repo, f.path)))));
    return writeGuarded(repo, files);
}
