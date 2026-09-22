import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Surface, DetectedPipeline, DetectionResult, Archetype, Confidence, SurfaceFramework,
  SkippedCandidate,
} from './types.js';
import { isLaunchpadWorkflow } from './consolidation.js';
import { isLaunchpadGenerated } from './generated.js';
import { detectEcosystem } from './ecosystem.js';
import { androidAppModule, weakAndroidEvidence } from './gradle.js';
import { workspacePackageDirs, isFlutterPlugin, isExampleDir } from './workspace.js';

function read(p: string): string {
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}
function ls(p: string): string[] {
  try { return readdirSync(p); } catch { return []; }
}
function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

function surface(
  id: string, archetype: Archetype, evidence: string[], confidence: Confidence,
  framework?: SurfaceFramework,
): Surface {
  return { id, archetype, status: 'pending', evidence, confidence, ...(framework ? { framework } : {}) };
}

/**
 * Web frameworks, most specific first.
 *
 * Order matters: a Next.js app has `react` in its dependencies and a SvelteKit
 * app has `vite`, so a naive check would label both wrongly. Meta-frameworks
 * are tested before the bundlers and libraries they are built on.
 *
 * They all share one archetype because they all deploy the same way — Vercel's
 * native git integration. The framework name only changes the evidence string
 * and the `framework` value in config.
 */
export const WEB_FRAMEWORKS: { name: string; dep?: RegExp; files?: string[] }[] = [
  { name: 'Next.js',    dep: /"next"\s*:/,             files: ['next.config.js', 'next.config.ts', 'next.config.mjs'] },
  { name: 'Nuxt',       dep: /"nuxt"\s*:/,             files: ['nuxt.config.js', 'nuxt.config.ts'] },
  { name: 'SvelteKit',  dep: /"@sveltejs\/kit"\s*:/,   files: ['svelte.config.js'] },
  { name: 'Astro',      dep: /"astro"\s*:/,            files: ['astro.config.mjs', 'astro.config.ts'] },
  { name: 'Remix',      dep: /"@remix-run\/(dev|node|react)"\s*:/, files: ['remix.config.js'] },
  { name: 'Angular',    dep: /"@angular\/core"\s*:/,   files: ['angular.json'] },
  { name: 'Qwik',       dep: /"@builder\.io\/qwik"\s*:/ },
  { name: 'SolidStart', dep: /"@solidjs\/start"\s*:/ },
  { name: 'Gatsby',     dep: /"gatsby"\s*:/,           files: ['gatsby-config.js', 'gatsby-config.ts'] },
  { name: 'Docusaurus', dep: /"@docusaurus\/core"\s*:/ },
  // Bundlers last: a meta-framework above almost always brings one of these in.
  { name: 'Vite',       dep: /"vite"\s*:/,             files: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'] },
  { name: 'Create React App', dep: /"react-scripts"\s*:/ },
];

function detectWebFramework(_dir: string, pkg: string, has: (rel: string) => boolean): string | null {
  for (const f of WEB_FRAMEWORKS) {
    if (f.dep?.test(pkg)) return f.name;
    if (f.files?.some(has)) return f.name;
  }
  return null;
}

/**
 * Static site generators — they build HTML, so they deploy like a static site.
 *
 * `config.toml` belongs to both Hugo and Zola, and whichever row ran first won
 * outright: every Zola site in the world was reported as Hugo, and the Zola row
 * could never match anything. The two files are easy to tell apart — Hugo spells
 * it `baseURL`, Zola spells it `base_url` — so the ambiguous row carries a
 * `requires` pattern and is tested first. A row without one is unconditional,
 * as before.
 */
export const STATIC_GENERATORS: { name: string; files: string[]; requires?: RegExp }[] = [
  { name: 'Zola',     files: ['config.toml'], requires: /^\s*base_url\s*=/m },
  { name: 'Hugo',     files: ['hugo.toml', 'hugo.yaml', 'config.toml'] },
  { name: 'Jekyll',   files: ['_config.yml'] },
  { name: 'Eleventy', files: ['.eleventy.js', 'eleventy.config.js'] },
  { name: 'MkDocs',   files: ['mkdocs.yml'] },
];

function detectStaticGenerator(dir: string, has: (rel: string) => boolean): string | null {
  for (const g of STATIC_GENERATORS) {
    const hit = g.files.find(has);
    if (!hit) continue;
    if (g.requires && !g.requires.test(read(join(dir, hit)))) continue;
    return g.name;
  }
  return null;
}

/**
 * Is the web build in this directory the UI of a desktop binary?
 *
 * `detectWebFramework` ran unconditionally and never asked, so
 * `modern-desktop-app-template` — a Tauri app — was reported as a `web:web-app`
 * with high confidence and the evidence "Vite detected", and `apply` then told a
 * desktop developer to go and wire Vercel's git integration. The Vite app **is**
 * the desktop binary's own UI. It is not a separately deployable site, and
 * nobody is going to visit it.
 *
 * There is a second, quieter cost: because a surface existed, the scorecard's
 * `generic` flag was false, so the Tauri author lost the three checks written
 * for exactly their situation — README, licence, "a stranger can download and
 * run it" — while gaining "An app icon the store will accept".
 *
 * Electron escaped only by luck: the fixture has no bundler in its
 * `package.json`. Any Electron app built with Vite lands in the same hole.
 *
 * The question is asked through `detectEcosystem` rather than by re-listing
 * Tauri's and Electron's marker files here, because two copies of one rule is
 * precisely the drift the registry tests exist to prevent.
 */
function desktopShell(dir: string): string | null {
  const eco = detectEcosystem(dir);
  return eco?.ships === 'desktop' ? eco.name : null;
}

/**
 * Independent evidence that this repository ALSO has a hosted web target.
 *
 * A desktop app can legitimately ship a marketing site or a companion web build
 * from the same directory, and refusing to see one would be the opposite error.
 * The bar is a deployment configuration somebody committed on purpose — not a
 * bundler, which is what got this wrong in the first place.
 */
function hostedWebEvidence(dir: string): string | null {
  for (const f of ['vercel.json', 'netlify.toml', '.vercel/project.json', 'wrangler.toml']) {
    if (existsSync(join(dir, f))) return f;
  }
  return /"hosting"\s*:/.test(read(join(dir, 'firebase.json'))) ? 'firebase.json hosting' : null;
}

function dedupe(surfaces: Surface[]): Surface[] {
  // keep one per id, preferring higher confidence
  const byId = new Map<string, Surface>();
  for (const s of surfaces) {
    const prev = byId.get(s.id);
    if (!prev || (prev.confidence === 'low' && s.confidence === 'high')) byId.set(s.id, s);
  }
  return [...byId.values()];
}

/** What one directory yielded: the surfaces, and what was considered and refused. */
interface Scan { surfaces: Surface[]; skipped: SkippedCandidate[] }

// Detect surfaces in a SINGLE directory (no recursion).
function scanDir(dir: string, at: string): Scan {
  const out: Surface[] = [];
  const skipped: SkippedCandidate[] = [];
  const has = (rel: string) => existsSync(join(dir, rel));

  // Apple: Xcode / xcodegen / SwiftPM
  const xcodeprojDirs = ls(dir).filter(n => n.endsWith('.xcodeproj'));
  if (xcodeprojDirs.length || has('project.yml') || has('Package.swift')) {
    /**
     * A SwiftPM manifest only counts as an app when it VENDS one.
     *
     * The platform heuristic below reads a blob of the Apple project files, and
     * `Package.swift` used to go into it whole — so `apple/swift-argument-parser`
     * was handed a macOS DMG surface on the strength of one `#if os(macOS)`
     * near the bottom of the file. The scorecard then demanded notarization, a
     * Sparkle updater, an app icon and store listing assets from a
     * command-line-argument library maintained by Apple: four confidently wrong
     * rows out of fifteen, one of them marked critical. Worse, the surface is
     * recorded as `pending`, so once the onboard skill gathered a config for it
     * `apply` would write a real DMG + Sparkle workflow into a library.
     *
     * A platform *conditional* is not a platform *product*. What distinguishes
     * a package somebody downloads from a package somebody links is the
     * `products:` array, and `.executable(` appears only there — a target is
     * `.executableTarget(`, which this deliberately does not match, because
     * example and tooling targets are not what the package ships.
     */
    const packageSwift = read(join(dir, 'Package.swift'));
    const vendsExecutable = /\.executable\s*\(/.test(packageSwift);
    const blob = [
      read(join(dir, 'project.yml')),
      vendsExecutable ? packageSwift : '',
      ...xcodeprojDirs.map(d => read(join(dir, d, 'project.pbxproj'))),
    ].join('\n');
    if (/macos|macosx|\.macOS/i.test(blob)) out.push(surface('macos', 'macos-dmg', ['Apple project targets macOS'], 'low'));
    if (/iphoneos|\.iOS|platform:\s*iOS/i.test(blob)) out.push(surface('ios', 'ios', ['Apple project targets iOS'], 'low', 'native'));
  }

  // Flutter
  if (has('pubspec.yaml')) {
    const ios = has('ios');
    const android = has('android');
    if (ios) out.push(surface('ios', 'ios', ['Flutter ios/ present'], 'high', 'flutter'));
    if (android) out.push(surface('android', 'android', ['Flutter android/ present'], 'high', 'flutter'));
    // `flutter create` scaffolds macos/ for every app, so a mobile Flutter app
    // is not a macOS-desktop surface — emitting one produces a spurious
    // low-confidence macos-dmg pipeline. Only a macOS-only Flutter package
    // (no ios/, no android/) is genuinely a desktop surface.
    if (has('macos') && !ios && !android) {
      out.push(surface('macos', 'macos-dmg', ['Flutter macos/ present'], 'low'));
    }
  }

  const pkg = read(join(dir, 'package.json'));
  const isExpoEarly = /"expo"\s*:/.test(pkg) || has('app.json') && /"expo"\s*:/.test(read(join(dir, 'app.json')));
  const isRNEarly = /"react-native"\s*:/.test(pkg);

  /**
   * Native Android — Kotlin or Java on Gradle, with no Flutter or React Native
   * anywhere near it.
   *
   * This was missing entirely, and it is not a niche: "Android developers" is
   * one of the audiences this product is sold to, and a native Android app
   * reported ZERO surfaces. Someone installs it, runs it against the app they
   * have been sitting on, and is told there is nothing here.
   *
   * The signal is the Android Gradle **application** plugin, not the library
   * one — a project can contain a dozen `com.android.library` modules and ship
   * nothing. The module is usually `app/`, but only by convention, so a shallow
   * scan finds it wherever it is.
   *
   * Finding that plugin is `gradle.ts`'s job, because since AGP 8 the id is
   * usually not written in the build file at all: it is declared once in
   * `gradle/libs.versions.toml` and reached as `alias(libs.plugins.android.application)`.
   * A substring scan of the build files — which is what this used to be — reports
   * zero surfaces for Android Studio's own default layout.
   */
  if (!has('pubspec.yaml') && !isExpoEarly && !isRNEarly) {
    const appModule = androidAppModule(dir);
    if (appModule !== null) {
      const where = appModule || 'the root module';
      out.push(surface('android', 'android',
        [`Android Gradle application plugin in ${where}`], 'high', 'native'));
    } else {
      // No module applies it. Before concluding "not an Android app" — and
      // handing the author the JVM-service message — look for the weaker
      // signals a convention-plugin build leaves behind. Low confidence, with
      // the evidence said out loud, because a false gap is cheaper than the
      // alternative but a false pass is not.
      const weak = weakAndroidEvidence(dir);
      if (weak) out.push(surface('android', 'android', [weak], 'low', 'native'));
    }
  }

  // React Native / Expo — like Flutter, one codebase producing two surfaces.
  // Expo may have no ios/ or android/ dir at all (prebuild generates them), so
  // the manifest is the only reliable signal.
  const isExpo = /"expo"\s*:/.test(pkg) || has('app.json') && /"expo"\s*:/.test(read(join(dir, 'app.json')));
  const isRN = /"react-native"\s*:/.test(pkg);
  if (isExpo || isRN) {
    const label = isExpo ? 'Expo' : 'React Native';
    const framework: SurfaceFramework = isExpo ? 'expo' : 'react-native';
    out.push(surface('ios', 'ios', [`${label} detected`], 'high', framework));
    out.push(surface('android', 'android', [`${label} detected`], 'high', framework));
  }

  // Web app. Every one of these deploys to Vercel through the same native git
  // integration, so they are one archetype — the framework only changes the
  // evidence string and the `framework` config value.
  //
  // …unless the bundler output is a desktop binary's UI. See `desktopShell`.
  const webFramework = detectWebFramework(dir, pkg, has);
  if (webFramework) {
    const shell = desktopShell(dir);
    const hosted = shell ? hostedWebEvidence(dir) : null;
    if (!shell || hosted) {
      out.push(surface('web', 'web-app',
        [`${webFramework} detected`, ...(hosted ? [`hosted web target (${hosted})`] : [])], 'high'));
    } else {
      skipped.push({
        path: at,
        what: `${webFramework} frontend`,
        why: `it is the UI of ${/^[aeiou]/i.test(shell) ? 'an' : 'a'} ${shell}, not a separately `
          + 'deployable site. Commit a vercel.json, netlify.toml or wrangler.toml if you do host it too.',
      });
    }
  }

  // Static site: hand-written HTML, or a generator that emits it.
  const ssg = detectStaticGenerator(dir, has);
  if (ssg) out.push(surface('site', 'static-site', [`${ssg} detected`], 'high'));
  else if (has('index.html') && !has('package.json')) {
    out.push(surface('site', 'static-site', ['index.html, no package.json'], 'high'));
  }

  return { surfaces: dedupe(out), skipped };
}

// Detect existing pipelines in a SINGLE directory; paths are prefixed by pathPrefix.
function pipelinesIn(dir: string, pathPrefix: string): DetectedPipeline[] {
  const out: DetectedPipeline[] = [];
  const has = (rel: string) => existsSync(join(dir, rel));
  const rel = (p: string) => (pathPrefix ? join(pathPrefix, p) : p);

  // launchpad's OWN workflows are not "existing pipelines" — filing them under
  // consolidation candidates made `setup` non-idempotent on every wired repo
  // (they reappear in state.yml + DEPLOYMENT.md on each run).
  for (const f of ls(join(dir, '.github', 'workflows')).filter(n => n.endsWith('.yml') || n.endsWith('.yaml'))) {
    if (isLaunchpadWorkflow(f)) continue;
    out.push({ kind: 'github-actions', path: rel(join('.github/workflows', f)) });
  }
  /**
   * …and neither is anything else launchpad generated.
   *
   * Only WORKFLOWS had an ownership filter. A `fastlane/Fastfile` that `apply`
   * had just written came straight back as a foreign pipeline: a repo
   * containing nothing but a launchpad-stamped Fastfile reported
   * `pipelines: [{fastlane, fastlane/Fastfile}]` next to the `ios` surface that
   * wrote it. PLAYBOOK §5 states the rule the other way round — "your own
   * generated files are not existing pipelines. Filing them as consolidation
   * candidates makes setup non-idempotent on every wired repo, and the entries
   * reappear forever."
   *
   * It is also the blocker under `disposition`: a `leave-alone` default keyed
   * on detected pipelines would make the SECOND `apply` stop wiring iOS,
   * silently breaking the byte-stable fixed point, because the pipeline it
   * would be leaving alone is its own.
   *
   * `isLaunchpadGenerated` is the existing test for this and is what
   * `writeGuarded` already decides ownership with, so the two cannot disagree
   * about which files belong to launchpad.
   */
  const foreign = (relPath: string): boolean =>
    !isLaunchpadGenerated(relPath, read(join(dir, relPath)));

  if (has(join('fastlane', 'Fastfile')) && foreign('fastlane/Fastfile')) {
    out.push({ kind: 'fastlane', path: rel('fastlane/Fastfile') });
  }
  const sparkle = has('appcast.xml') ? 'appcast.xml' : has('create-dmg.sh') ? 'create-dmg.sh' : null;
  if (sparkle && foreign(sparkle)) out.push({ kind: 'sparkle-dmg', path: rel(sparkle) });
  if (has('vercel.json') && foreign('vercel.json')) out.push({ kind: 'vercel', path: rel('vercel.json') });
  if (has('.heartbeat') && foreign('.heartbeat')) out.push({ kind: 'heartbeat', path: rel('.heartbeat') });
  return out;
}

/**
 * Why a workspace package that DOES look like an app is not one, or null.
 *
 * This is the other half of the Flutter-monorepo fix, and the half that keeps
 * recursion from making things worse. Walking `packages/**` on a real plugin
 * monorepo finds the federated packages that used to be invisible — and also
 * finds every plugin's `example/` app. Emitting a TestFlight pipeline for
 * twelve example apps and twelve plugin implementations would be a louder
 * version of the same wrong answer.
 *
 * A federated plugin package is a LIBRARY. It ships to pub.dev; its `ios/` and
 * `android/` directories are the platform implementation of that library, and
 * there is no app inside them to upload. An `example/` app is real but is a
 * demo used for integration testing — nobody submits `package_info_plus_example`
 * to the App Store.
 *
 * So both are skipped, and both are REPORTED, which is the actual complaint:
 * the packages were not lost because the decision was wrong, they were lost
 * because nothing ever said they had been considered.
 */
function notShippable(repo: string, relDir: string): string | null {
  if (isExampleDir(relDir)) {
    return 'it is an example app — a demo kept for integration testing, not something anyone ships. '
      + 'If you do release it, give it its own entry in .launchpad/state.yml.';
  }
  if (isFlutterPlugin(join(repo, relDir))) {
    return 'it is a Flutter plugin package: it ships to pub.dev as a library, and its ios/ and '
      + 'android/ folders are that library\'s platform implementation rather than an app to upload.';
  }
  return null;
}

export function detect(repo: string): DetectionResult {
  const root = scanDir(repo, '.');
  const surfaces: Surface[] = [...root.surfaces];
  const skipped: SkippedCandidate[] = [...root.skipped];
  const pipelines: DetectedPipeline[] = [...pipelinesIn(repo, '')];

  for (const relDir of workspacePackageDirs(repo)) {
    const pkgName = relDir.split('/').pop()!;
    const sub = scanDir(join(repo, relDir), relDir);
    skipped.push(...sub.skipped);
    pipelines.push(...pipelinesIn(join(repo, relDir), relDir));
    if (!sub.surfaces.length) continue;

    // Only worth reporting a skip for a package that WOULD have produced
    // something; a config-only workspace package is not news.
    const why = notShippable(repo, relDir);
    if (why) {
      skipped.push({
        path: relDir,
        what: [...new Set(sub.surfaces.map(s => s.archetype))].sort().join(' + '),
        why,
      });
      continue;
    }
    for (const s of sub.surfaces) {
      const id = sub.surfaces.length === 1 ? pkgName : `${pkgName}-${s.id}`;
      surfaces.push({ ...s, id, target: relDir });
    }
  }

  // Co-located static landing site in a `site/` subfolder (canonical structure:
  // app code + site/ live in one repo). Reuses scanDir's index.html heuristic.
  if (!surfaces.some(s => s.id === 'site')) {
    for (const sub of scanDir(join(repo, 'site'), 'site').surfaces) {
      if (sub.archetype === 'static-site') {
        surfaces.push({ ...sub, id: 'site', target: 'site', evidence: ['site/ contains index.html'] });
      }
    }
  }

  const eco = detectEcosystem(repo);
  return {
    surfaces: dedupe(surfaces),
    pipelines,
    ...(skipped.length ? { skipped } : {}),
    ...(eco ? { ecosystem: eco.name } : {}),
  };
}
