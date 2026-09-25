import { existsSync, readFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { detectStaticGenerator } from '../detect.js';
import { DEFAULT_NODE_VERSION, detectPackageManager, installCommand } from './androidgradle.js';
import { repoRelDir } from './triggers.js';

/**
 * The build step a static-site generator needs before its output is a website.
 *
 * Detection has always routed Jekyll, Hugo, Eleventy, MkDocs and Zola sites to
 * the static-site archetype — correctly, they emit HTML — and the Pages
 * workflow then ran `wrangler pages deploy <siteDir>` on the SOURCE. For a
 * Jekyll site that publishes raw Liquid (`{{ site.title }}` on the live page);
 * for Hugo, a directory of Markdown and a `hugo.toml`. The registry said "a
 * push builds and publishes it", and nothing built anything
 * (harness/journey/JOURNEY.md, "For the harvest branch" 1).
 *
 * Each generator gets its own ecosystem's standard toolchain, and the
 * generator's OUTPUT directory is what deploys:
 *
 * | generator | toolchain | build | output |
 * |---|---|---|---|
 * | Jekyll, with a Gemfile | `ruby/setup-ruby` + `bundler-cache` | `bundle exec jekyll build` (JEKYLL_ENV=production) | `_site` |
 * | Jekyll, no Gemfile | `actions/jekyll-build-pages` (GitHub Pages' own builder) | — | `_site` |
 * | Hugo | the extended release tarball | `hugo --gc --minify` | `public` |
 * | Eleventy | `actions/setup-node` + the lockfile's installer | `npx @11ty/eleventy` | `_site` |
 * | MkDocs | `actions/setup-python` + requirements or pinned pip | `mkdocs build` | `site` |
 * | Zola | the release tarball | `zola build` | `public` |
 *
 * These are the forms each project documents for CI: GitHub's own Pages
 * starter workflows for Jekyll (`pages/jekyll.yml` with a Gemfile,
 * `pages/jekyll-gh-pages.yml` without), Hugo's "Host on GitHub Pages"
 * workflow, Eleventy's and MkDocs' deployment docs, and Zola's release
 * binaries. The output directory honours the generator's own config key
 * (`destination`, `publishDir`, `dir.output`, `site_dir`, `output_dir`) when it
 * is set, and `outputDir` on the surface overrides everything.
 *
 * Versions come from where each ecosystem pins them — `Gemfile.lock`,
 * `package.json` + its lockfile, a `requirements.txt`, `.tool-versions`,
 * `.ruby-version` / `.python-version` / `.nvmrc`, a `netlify.toml`
 * `HUGO_VERSION` / `ZOLA_VERSION` — and only then from the defaults below
 * (DECISIONS 2026-09-23). A floating "latest" is PLAYBOOK §4's drift.
 *
 * A plain-HTML site has no generator and no build: its workflow is byte-for-
 * byte what it was.
 */

export type SiteGenerator = 'jekyll' | 'hugo' | 'eleventy' | 'mkdocs' | 'zola';
export const SITE_GENERATORS: SiteGenerator[] = ['jekyll', 'hugo', 'eleventy', 'mkdocs', 'zola'];

/** Pinned when nothing in the repository pins them. Bump deliberately. */
export const SITE_TOOL_DEFAULTS = {
  hugo: '0.166.0',
  zola: '0.23.6',
  mkdocs: '1.6.1',
  mkdocsMaterial: '9.7.7',
  eleventy: '3.1.6',
  /** Jekyll 4.3 on Ruby 3.4+ needs `csv`/`base64` added to the Gemfile; 3.3 builds it as-is. */
  ruby: '3.3',
  python: '3.12',
} as const;

const DEFAULT_OUTPUT: Record<SiteGenerator, string> = {
  jekyll: '_site', hugo: 'public', eleventy: '_site', mkdocs: 'site', zola: 'public',
};

const LABEL: Record<SiteGenerator, string> = {
  jekyll: 'Jekyll', hugo: 'Hugo', eleventy: 'Eleventy', mkdocs: 'MkDocs', zola: 'Zola',
};

/** The knobs a site config may carry that decide the build. All optional. */
export interface SiteBuildKnobs {
  siteDir: string;
  /** Unset → detected from the site directory. `none` deploys the directory as-is. */
  generator?: SiteGenerator | 'none';
  /** A build command that replaces the generator's own (run in the site directory). */
  siteBuild?: string;
  /** What deploys, relative to the site directory. Overrides the generator's default. */
  outputDir?: string;
  /** Pins Hugo, Zola, MkDocs or Eleventy when nothing in the repository does. */
  generatorVersion?: string;
}

/** Everything the workflow needs, resolved. `null` from `planSiteBuild` means "no build". */
export interface SiteBuildPlan {
  generator: SiteGenerator | null;
  /** Lines under `- uses: actions/checkout@v4` (a `with:` block), or ''. */
  checkoutWith: string;
  /** Complete steps, each line newline-terminated, inserted before the deploy step. */
  steps: string;
  /** Repo-relative directory `wrangler pages deploy` publishes. */
  deployDir: string;
}

const read = (p: string): string => { try { return readFileSync(p, 'utf8'); } catch { return ''; } };

/** `.tool-versions` (asdf / mise): tool → first version listed. */
export function toolVersions(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z0-9_.-]+)\s+([^\s#]+)/.exec(line);
    if (m && !(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

/** A version string safe to put in a URL and a shell line, or null. */
const cleanVersion = (v: string | undefined): string | null => {
  const s = (v ?? '').trim().replace(/^extended_/, '').replace(/^v/, '');
  return /^[0-9][0-9A-Za-z.+-]*$/.test(s) ? s : null;
};

/**
 * The generator's own output directory setting, when it is written plainly.
 * Anything computed (a JS expression, an env lookup) falls back to the default
 * and `outputDir` is the way to say otherwise.
 */
function configuredOutput(g: SiteGenerator, siteAbs: string): string | null {
  const first = (files: string[], re: RegExp): string | null => {
    for (const f of files) {
      const m = re.exec(read(join(siteAbs, f)));
      if (m) return m[1].trim();
    }
    return null;
  };
  switch (g) {
    case 'jekyll': return first(['_config.yml'], /^destination\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    case 'hugo': return first(['hugo.toml', 'hugo.yaml', 'config.toml', 'hugo.json'],
      /^\s*"?publishdir"?\s*[:=]\s*["']([^"']+)["']/im)
      ?? first(['hugo.yaml'], /^publishDir\s*:\s*([^\s#]+)/m);
    case 'eleventy': return first(['eleventy.config.js', '.eleventy.js', 'eleventy.config.mjs', 'eleventy.config.cjs'],
      /\boutput\s*:\s*["'`]([^"'`$]+)["'`]/);
    case 'mkdocs': return first(['mkdocs.yml'], /^site_dir\s*:\s*["']?([^"'#\n]+?)["']?\s*(?:#.*)?$/m);
    case 'zola': return first(['config.toml'], /^\s*output_dir\s*=\s*["']([^"']+)["']/m);
  }
}

/** A repo-relative path a workflow may publish: relative, inside the site, no `..`. */
function safeRelative(p: string, what: string): string {
  const s = p.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!s || s === '.' || s.startsWith('/') || /^[A-Za-z]:/.test(s) || s.split('/').includes('..') || /["'`$\n]/.test(s)) {
    throw new Error(`static-site: ${what} must be a directory inside the site, not "${p}"`);
  }
  return s;
}

/** The detected (or configured) generator for a site, or null for plain HTML. */
export function siteGenerator(repo: string | undefined, k: SiteBuildKnobs): SiteGenerator | null {
  if (k.generator === 'none') return null;
  if (k.generator) {
    if (!SITE_GENERATORS.includes(k.generator)) {
      throw new Error(`static-site: generator must be one of ${SITE_GENERATORS.join(', ')} or none, not "${String(k.generator)}"`);
    }
    return k.generator;
  }
  if (!repo) return null;
  const name = detectStaticGenerator(join(repo, repoRelDir(k.siteDir) || '.'));
  return name ? (name.toLowerCase() as SiteGenerator) : null;
}

/**
 * Resolve the build for a site, or null when there is nothing to build — a
 * plain-HTML site with no `siteBuild` and no `outputDir`, whose workflow must
 * stay exactly what it was.
 *
 * `repo` is where the facts come from (which generator, which lockfile, which
 * pinned version). Without it only the knobs speak — which is what a planner
 * test with no repository on disk gets.
 */
export function planSiteBuild(repo: string | undefined, k: SiteBuildKnobs): SiteBuildPlan | null {
  const gen = siteGenerator(repo, k);
  const custom = k.siteBuild?.trim() || '';
  if (!gen && !custom && !k.outputDir?.trim()) return null;

  const dir = repoRelDir(k.siteDir);                     // '' at the root
  const siteAbs = repo ? join(repo, dir || '.') : '';
  const has = (rel: string) => (repo ? existsSync(join(siteAbs, rel)) : false);
  const hasAtRoot = (rel: string) => (repo ? existsSync(join(repo, rel)) : false);
  const tv = { ...(repo ? toolVersions(read(join(repo, '.tool-versions'))) : {}), ...(repo && dir ? toolVersions(read(join(siteAbs, '.tool-versions'))) : {}) };
  const netlify = repo ? read(join(siteAbs, 'netlify.toml')) || read(join(repo, 'netlify.toml')) : '';
  const netlifyVersion = (name: string) => new RegExp(`${name}\\s*=\\s*["']([^"']+)["']`).exec(netlify)?.[1];
  const wd = dir ? [`        working-directory: ${dir}`] : [];
  const under = (rel: string) => (dir ? posix.join(dir, rel) : rel);

  // Where the generator writes on its own, and where it must write for this
  // deploy. They differ only when `outputDir` says so; then the build is told.
  const natural = gen ? safeRelative(configuredOutput(gen, siteAbs) ?? DEFAULT_OUTPUT[gen], 'the generator\'s output directory') : null;
  const output = k.outputDir?.trim() ? safeRelative(k.outputDir, 'outputDir') : natural;
  const moved = (flag: string): string => (gen && output !== natural && !custom ? ` ${flag}${output}` : '');

  const steps: string[] = [];
  const step = (...lines: string[]) => steps.push([...lines, ''].join('\n'));
  const run = (name: string, cmd: string, env: string[] = []) => step(
    `      - name: ${name}`,
    ...wd,
    ...(env.length ? ['        env:', ...env.map(e => `          ${e}`)] : []),
    ...(cmd.includes('\n') ? ['        run: |', ...cmd.split('\n').map(l => `          ${l}`)] : [`        run: ${cmd}`]),
  );

  /** Node + the project's own install, when there is a package.json. */
  const nodeSteps = (): void => {
    if (!has('package.json')) return;
    const pm = repo ? detectPackageManager(siteAbs) : 'npm';
    const lock = { npm: 'package-lock.json', yarn: 'yarn.lock', pnpm: 'pnpm-lock.yaml' }[pm];
    const locked = has(lock);
    const versionFile = ['.nvmrc', '.node-version'].find(has);
    const nodeVersion = cleanVersion(tv.nodejs ?? tv.node);
    step(
      '      - uses: actions/setup-node@v4',
      '        with:',
      versionFile ? `          node-version-file: ${under(versionFile)}` : `          node-version: '${nodeVersion ?? DEFAULT_NODE_VERSION}'`,
      ...(locked ? [`          cache: ${pm}`, `          cache-dependency-path: ${under(lock)}`] : []),
    );
    if (pm === 'pnpm') step('      - uses: pnpm/action-setup@v4', '        with:', '          run_install: false');
    run('Install JavaScript dependencies', locked ? installCommand(pm) : `${pm} install`);
  };

  let checkoutWith = '';
  if (gen && hasAtRoot('.gitmodules')) {
    // Themes are very often git submodules (Hugo's and Zola's quick starts both
    // add one), and a checkout without them builds a site with no layouts.
    checkoutWith = ['        with:', '          submodules: recursive', ''].join('\n');
  }

  const label = gen ? LABEL[gen] : 'custom';
  switch (gen) {
    case 'jekyll': {
      if (has('Gemfile') || custom) {
        const pinnedRuby = has('.ruby-version') || !!tv.ruby;
        step(
          '      - uses: ruby/setup-ruby@v1',
          '        with:',
          ...(pinnedRuby ? [] : [`          ruby-version: '${SITE_TOOL_DEFAULTS.ruby}'`]),
          ...(has('Gemfile') ? ['          bundler-cache: true'] : []),
          ...(dir ? [`          working-directory: ${dir}`] : []),
        );
        run(`Build the site (${label})`, custom || `bundle exec jekyll build${moved('--destination ')}`, ['JEKYLL_ENV: production']);
      } else {
        // No Gemfile: this is a GitHub Pages–style site, built with the same
        // pinned `github-pages` gem set GitHub itself uses (its
        // `jekyll-gh-pages.yml` starter workflow).
        step(
          `      - name: Build the site (${label}, GitHub Pages' own builder)`,
          '        uses: actions/jekyll-build-pages@v1',
          '        with:',
          `          source: ./${dir}`,
          `          destination: ./${under(output!)}`,
        );
      }
      break;
    }
    case 'hugo': {
      const v = cleanVersion(k.generatorVersion) ?? cleanVersion(tv.hugo) ?? cleanVersion(netlifyVersion('HUGO_VERSION')) ?? SITE_TOOL_DEFAULTS.hugo;
      step(
        '      - name: Install Hugo (extended)',
        '        env:',
        `          HUGO_VERSION: ${v}`,
        '        run: |',
        '          curl -fsSL -o "$RUNNER_TEMP/hugo.tar.gz" "https://github.com/gohugoio/hugo/releases/download/v${HUGO_VERSION}/hugo_extended_${HUGO_VERSION}_linux-amd64.tar.gz"',
        '          mkdir -p "$RUNNER_TEMP/hugo"',
        '          tar -C "$RUNNER_TEMP/hugo" -xzf "$RUNNER_TEMP/hugo.tar.gz"',
        '          echo "$RUNNER_TEMP/hugo" >> "$GITHUB_PATH"',
      );
      nodeSteps();
      run(`Build the site (${label})`, custom || `hugo --gc --minify${moved('--destination ')}`, ['HUGO_ENVIRONMENT: production']);
      break;
    }
    case 'eleventy': {
      nodeSteps();
      const v = cleanVersion(k.generatorVersion) ?? SITE_TOOL_DEFAULTS.eleventy;
      const bin = has('package.json') ? 'npx @11ty/eleventy' : `npx --yes @11ty/eleventy@${v}`;
      run(`Build the site (${label})`, custom || `${bin}${moved('--output=')}`);
      break;
    }
    case 'mkdocs': {
      const pyFile = has('.python-version') ? '.python-version' : null;
      const pyVersion = cleanVersion(tv.python);
      step(
        '      - uses: actions/setup-python@v5',
        '        with:',
        pyFile ? `          python-version-file: ${under(pyFile)}` : `          python-version: '${pyVersion ?? SITE_TOOL_DEFAULTS.python}'`,
      );
      const req = ['requirements.txt', 'docs/requirements.txt', 'requirements-docs.txt'].find(has);
      let install: string;
      if (req) install = `pip install -r ${req}`;
      else {
        const material = /^theme\s*:\s*(?:\n\s+name\s*:\s*)?["']?material\b/m.test(repo ? read(join(siteAbs, 'mkdocs.yml')) : '');
        const v = cleanVersion(k.generatorVersion) ?? SITE_TOOL_DEFAULTS.mkdocs;
        install = `pip install mkdocs==${v}${material ? ` mkdocs-material==${SITE_TOOL_DEFAULTS.mkdocsMaterial}` : ''}`;
      }
      run('Install MkDocs', install);
      run(`Build the site (${label})`, custom || `mkdocs build${moved('--site-dir ')}`);
      break;
    }
    case 'zola': {
      const v = cleanVersion(k.generatorVersion) ?? cleanVersion(tv.zola) ?? cleanVersion(netlifyVersion('ZOLA_VERSION')) ?? SITE_TOOL_DEFAULTS.zola;
      step(
        '      - name: Install Zola',
        '        env:',
        `          ZOLA_VERSION: ${v}`,
        '        run: |',
        '          mkdir -p "$RUNNER_TEMP/zola"',
        '          curl -fsSL "https://github.com/getzola/zola/releases/download/v${ZOLA_VERSION}/zola-v${ZOLA_VERSION}-x86_64-unknown-linux-gnu.tar.gz" | tar -xz -C "$RUNNER_TEMP/zola"',
        '          echo "$RUNNER_TEMP/zola" >> "$GITHUB_PATH"',
      );
      run(`Build the site (${label})`, custom || `zola build${moved('--output-dir ')}`);
      break;
    }
    default:
      // No generator: a custom build (or just a different directory to publish).
      if (custom) {
        nodeSteps();
        run('Build the site', custom);
      }
  }

  return {
    generator: gen,
    checkoutWith,
    steps: steps.join(''),
    deployDir: output ? under(output) : (dir || '.'),
  };
}
