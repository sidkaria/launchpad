import type { Archetype } from './types.js';

/**
 * Every platform and framework launchpad knows about, and exactly how well it
 * knows it. One file, read by the product and by the landing page.
 *
 * The reason this exists is a specific failure that costs refunds: a page that
 * says "works with React Native" beside a product that detects React Native and
 * then refuses to wire it. Both statements were written by someone honest, six
 * weeks apart, from two different mental models of what "support" means. The fix
 * is not diligence, it is a single list with a status column — and tests that
 * fail when detection can report something this list does not carry.
 *
 * The three statuses are the whole point, and blurring them is the one thing
 * that must never happen:
 *
 *   `deploys`     `apply` writes a real pipeline for it. Something ships.
 *   `recognised`  Detection names it and the scorecard adapts to it. Honest
 *                 guidance, a free checklist, and no pipeline — said out loud.
 *   `planned`     Detected, deliberately refused today, intended later. The
 *                 product says "not yet" rather than emitting something that
 *                 looks right and fails in CI.
 *
 * Nothing here may be added from a roadmap. Every entry is traceable to code:
 * an archetype in `src/archetypes/`, a framework row in `detect.ts`, or a rule
 * in `ecosystem.ts`. `test/platforms.test.ts` enforces that in both directions.
 */

export type PlatformStatus = 'deploys' | 'recognised' | 'planned';

export type PlatformCategory =
  | 'mobile'
  | 'desktop'
  | 'web'
  | 'static'
  | 'backend'
  | 'cli'
  | 'library';

/**
 * What the machine in front of the developer has to be.
 *
 * Deliberately not "Apple surfaces need a Mac", which is false and would cost
 * Windows and Linux buyers real capability — CI picks the runner. These three
 * values mirror `platform.ts`'s `hostSupport()` exactly, and a test asserts it.
 */
export type HostRequirement =
  /** Builds, signs and ships from any OS. */
  | 'any'
  /** CI builds it on a macOS runner; local builds need a Mac. */
  | 'mac-for-local'
  /** As above, plus one-time setup steps that read a Mac's login keychain. */
  | 'mac-for-setup';

export interface Platform {
  /** Stable id. Used by tests, by the site's URL hash, and nowhere in prose. */
  id: string;
  /** What to call it to a human. */
  name: string;
  category: PlatformCategory;
  status: PlatformStatus;
  /**
   * The archetypes `apply` wires for it. Non-empty exactly when status is
   * `deploys`; a framework producing two surfaces (Flutter) lists both.
   */
  archetypes?: Archetype[];
  /** The `ecosystem.ts` rule id that names it, where one does. */
  ecosystem?: string;
  /** The name `detect.ts` prints for it, where detection names a framework. */
  detectedAs?: string;
  /** Where a build ends up. For `recognised`, where it *would* need to go. */
  shipsTo: string;
  host: HostRequirement;
  /**
   * A Simple Icons slug, or `glyph:<name>` for the generic set used by anything
   * without a brand mark. The site fails its build on a slug that does not
   * exist rather than rendering a hole.
   */
  icon: string;
  /** The one honest line a visitor gets when they search for this. */
  answer: string;
  /** A qualification that must travel with the entry. Rendered, never hidden. */
  caveat?: string;
  /** Extra search terms — what someone would actually type. */
  aliases?: string[];
}

/** Vercel's native git integration: preview per branch, production on main. */
const VERCEL = 'Vercel — a project linked to the repo, a preview URL per branch, production on your default branch, and a custom domain if you have one.';
const PAGES = 'Cloudflare Pages — a build on push, previews per branch, and a custom domain if you have one.';

/** Web frameworks all take the same route, so they take the same sentence. */
const web = (
  id: string, name: string, detectedAs: string, icon: string, aliases?: string[],
): Platform => ({
  id, name, category: 'web', status: 'deploys', archetypes: ['web-app'],
  detectedAs, shipsTo: VERCEL, host: 'any', icon,
  answer: `Detected as a ${detectedAs} app. launchpad links the Vercel project, sets the root directory for a monorepo, syncs the environment, wires the per-app ignored build step, and binds a custom domain through Cloudflare if you want one.`,
  ...(aliases ? { aliases } : {}),
});

/** Static generators all take the same route too. */
const static_ = (
  id: string, name: string, detectedAs: string, icon: string, aliases?: string[],
): Platform => ({
  id, name, category: 'static', status: 'deploys', archetypes: ['static-site'],
  detectedAs, shipsTo: PAGES, host: 'any', icon,
  answer: `Detected as a ${detectedAs} site. launchpad writes the Cloudflare Pages release workflow, so a push builds and publishes it, with previews on other branches.`,
  ...(aliases ? { aliases } : {}),
});

/** An ecosystem launchpad can name but has no pipeline for. */
const known = (
  id: string, name: string, category: PlatformCategory, icon: string,
  shipsTo: string, aliases?: string[],
): Platform => ({
  id, name, category, status: 'recognised', ecosystem: id, shipsTo, host: 'any', icon,
  answer: `launchpad recognises this as ${/^[aeiou]/i.test(name) ? 'an' : 'a'} ${name} and says so. You get the readiness scorecard in its terms, the checklist, the dashboard and the overnight worker — all free. There is no pipeline for it, and launchpad tells you that rather than writing something useless.`,
  ...(aliases ? { aliases } : {}),
});

export const PLATFORMS: readonly Platform[] = [
  // ── Mobile and desktop: the archetypes with real pipelines ────────────────
  {
    id: 'flutter',
    name: 'Flutter',
    category: 'mobile',
    status: 'deploys',
    archetypes: ['ios', 'android'],
    shipsTo: 'TestFlight and the App Store for iOS; Firebase App Distribution or Play for Android.',
    host: 'mac-for-local',
    icon: 'flutter',
    answer: 'Both surfaces from one repo. launchpad writes the iOS and Android workflows, fastlane lanes, match signing, the release keystore and the Gradle wiring that makes the release build actually use it, flavours and dart-defines, plus the cheap analyze/test workflow on Linux.',
    aliases: ['dart', 'pubspec', 'melos', 'ios', 'android', 'mobile', 'app'],
  },
  {
    id: 'ios-native',
    name: 'Swift / Xcode (iOS)',
    category: 'mobile',
    status: 'deploys',
    archetypes: ['ios'],
    shipsTo: 'TestFlight on a push to your test branch, the App Store on a tag.',
    host: 'mac-for-local',
    icon: 'swift',
    answer: 'launchpad writes the macOS-runner workflow and the fastlane lanes, and signs with cloud signing by default — an App Store Connect key from the web portal, the certificate minted by the runner, so no certificates repo and no Mac needed for setup. `match` is there if you want deterministic certs.',
    aliases: ['swift', 'swiftui', 'uikit', 'xcode', 'xcodegen', 'iphone', 'ipad', 'ipa', 'testflight', 'app store', 'spm', 'objective-c'],
  },
  {
    id: 'macos',
    name: 'Swift / Xcode (macOS)',
    category: 'desktop',
    status: 'deploys',
    archetypes: ['macos-dmg'],
    shipsTo: 'A signed, notarized, stapled DMG on your own download URL, with Sparkle in-app auto-update.',
    host: 'mac-for-setup',
    icon: 'apple',
    answer: 'The whole desktop lane: Developer ID signing, notarization and stapling, DMG creation, a per-app Sparkle key, the appcast, and hosting the download on R2 behind your domain. Releases cut on a tag.',
    aliases: ['mac', 'dmg', 'sparkle', 'notarize', 'notarization', 'appkit', 'developer id', 'desktop'],
  },

  // ── Web: every framework detect.ts names, all one archetype ───────────────
  web('nextjs', 'Next.js', 'Next.js', 'nextdotjs', ['next', 'react', 'vercel', 'app router']),
  web('nuxt', 'Nuxt', 'Nuxt', 'nuxtdotjs', ['vue']),
  web('sveltekit', 'SvelteKit', 'SvelteKit', 'svelte', ['svelte']),
  web('astro-web', 'Astro', 'Astro', 'astro', ['astro']),
  web('remix', 'Remix', 'Remix', 'remix', ['react router']),
  web('angular', 'Angular', 'Angular', 'angular', ['ng']),
  web('qwik', 'Qwik', 'Qwik', 'qwik', []),
  web('solidstart', 'SolidStart', 'SolidStart', 'solid', ['solidjs', 'solid']),
  web('gatsby', 'Gatsby', 'Gatsby', 'gatsby', ['react']),
  web('docusaurus', 'Docusaurus', 'Docusaurus', 'docusaurus', ['docs']),
  web('vite', 'Vite', 'Vite', 'vite', ['react', 'vue', 'preact', 'spa']),
  web('cra', 'Create React App', 'Create React App', 'react', ['react', 'react-scripts']),

  // ── Static sites ──────────────────────────────────────────────────────────
  static_('hugo', 'Hugo', 'Hugo', 'hugo', ['go']),
  static_('jekyll', 'Jekyll', 'Jekyll', 'jekyll', ['ruby', 'github pages']),
  static_('eleventy', 'Eleventy', 'Eleventy', 'eleventy', ['11ty']),
  static_('mkdocs', 'MkDocs', 'MkDocs', 'materialformkdocs', ['python', 'docs']),
  static_('zola', 'Zola', 'Zola', 'glyph:page', ['rust']),
  {
    id: 'plain-html',
    name: 'Hand-written HTML',
    category: 'static',
    status: 'deploys',
    archetypes: ['static-site'],
    detectedAs: 'index.html, no package.json',
    shipsTo: PAGES,
    host: 'any',
    icon: 'html5',
    answer: 'An index.html with no build step is a site, and launchpad treats it as one: the Cloudflare Pages workflow, previews per branch, a custom domain if you want one. A `site/` folder alongside app code is picked up the same way.',
    aliases: ['html', 'css', 'static', 'landing page', 'index.html'],
  },

  // ── Detected, deliberately refused, intended later ────────────────────────
  {
    id: 'react-native',
    name: 'React Native',
    category: 'mobile',
    status: 'planned',
    detectedAs: 'React Native',
    shipsTo: 'Not yet. When it lands: TestFlight / App Store and Firebase App Distribution or Play.',
    host: 'mac-for-local',
    icon: 'react',
    answer: 'Detected as iOS and Android surfaces, and then launchpad refuses to wire them — a native Fastfile for a React Native app looks right and fails in CI, so it says "not yet wireable" instead. The free scorecard, the checklist and the dashboard all work today.',
    caveat: 'A planned pipeline is not a promised date. Until it exists, this is a free-scorecard stack.',
    aliases: ['rn', 'metro', 'expo', 'mobile'],
  },
  {
    id: 'expo',
    name: 'Expo',
    category: 'mobile',
    status: 'planned',
    detectedAs: 'Expo',
    shipsTo: 'Not yet. When it lands: TestFlight / App Store and Firebase App Distribution or Play.',
    host: 'mac-for-local',
    icon: 'expo',
    answer: 'Detected from the manifest even before prebuild creates the ios/ and android/ directories, then deliberately left alone: launchpad will not emit a pipeline it knows would fail. The free scorecard, the checklist and the dashboard all work today.',
    caveat: 'A planned pipeline is not a promised date. Until it exists, this is a free-scorecard stack.',
    aliases: ['eas', 'react native', 'app.json'],
  },
  {
    id: 'android-native',
    name: 'Android (Kotlin / Java)',
    category: 'mobile',
    status: 'recognised',
    detectedAs: 'Android Gradle application plugin',
    shipsTo: 'Firebase App Distribution or Play — not wired yet; a Gradle build step is what is missing.',
    host: 'any',
    icon: 'android',
    answer: 'The Gradle app module is found wherever it lives, including the modern layout where the plugin id is declared only in `gradle/libs.versions.toml` and the module says `alias(libs.plugins.android.application)`. You get the readiness scorecard in Android\'s terms — release signing, and the upload keystore whose loss means the app can never be updated again — plus the checklist, the dashboard and the overnight worker, all free.',
    caveat: 'There is no pipeline for it yet. launchpad\'s Android release workflow builds with `flutter build apk`, so `apply` REFUSES a Gradle-only project and says so rather than writing a workflow that would fail on its first build step. This is a scorecard-and-guidance stack today, not a one-command deploy.',
    aliases: ['kotlin', 'java', 'gradle', 'apk', 'aab', 'play store', 'jetpack compose', 'version catalog', 'libs.versions.toml'],
  },

  // ── Recognised ecosystems: named honestly, no pipeline ────────────────────
  known('tauri', 'Tauri desktop app', 'desktop', 'tauri',
    'A signed installer per OS, built by its own toolchain.',
    ['rust', 'desktop', 'webview']),
  known('electron', 'Electron desktop app', 'desktop', 'electron',
    'A signed installer per OS, built by electron-builder or Forge.',
    ['electron-builder', 'forge', 'desktop']),
  known('swift-package', 'Swift package', 'library', 'swift',
    'A version tag other packages can depend on — SwiftPM resolves straight from the git URL.',
    ['spm', 'swiftpm', 'package.swift', 'swift package manager', 'library']),
  known('rails', 'Ruby on Rails app', 'backend', 'rubyonrails',
    'A host that runs it — Fly, Render, Heroku, your own box.',
    ['ruby', 'gemfile', 'puma']),
  known('django', 'Django app', 'backend', 'django',
    'A host that runs it — Fly, Render, Railway, your own box.',
    ['python', 'manage.py', 'wsgi']),
  known('python-service', 'Python web service', 'backend', 'python',
    'A host that runs it — Fly, Render, Railway, your own box.',
    ['fastapi', 'flask', 'litestar', 'sanic', 'aiohttp', 'uvicorn']),
  known('laravel', 'Laravel app', 'backend', 'laravel',
    'A host that runs it — Forge, Vapor, your own box.',
    ['php', 'artisan', 'composer']),
  known('phoenix', 'Phoenix app', 'backend', 'phoenixframework',
    'A host that runs it — Fly, Gigalixir, your own box.',
    ['elixir', 'mix', 'liveview']),
  known('elixir', 'Elixir project', 'library', 'elixir',
    'Hex, so a stranger can add it as a dependency.',
    ['mix', 'hex', 'erlang', 'beam']),
  known('rust', 'Rust project', 'cli', 'rust',
    'crates.io, plus release binaries someone can download.',
    ['cargo', 'crate', 'crates.io', 'binary']),
  known('go', 'Go project', 'cli', 'go',
    'The Go module proxy, plus release binaries someone can download.',
    ['golang', 'go.mod', 'module', 'binary']),
  known('python', 'Python package', 'library', 'python',
    'PyPI, so `pip install` works for a stranger.',
    ['pypi', 'pip', 'pyproject', 'setup.py', 'wheel']),
  known('ruby-gem', 'Ruby gem', 'library', 'rubygems',
    'RubyGems, so `gem install` works for a stranger.',
    ['gemspec', 'ruby']),
  known('dotnet', '.NET project', 'backend', 'dotnet',
    'NuGet, or a host that runs it.',
    ['c#', 'csharp', 'csproj', 'fsharp', 'nuget', 'asp.net']),
  known('jvm', 'JVM project', 'backend', 'openjdk',
    'Maven Central, or a host that runs it.',
    ['java', 'kotlin', 'gradle', 'maven', 'spring', 'pom.xml']),
  known('node-cli', 'Node CLI', 'cli', 'nodedotjs',
    'npm, so `npx` works for a stranger.',
    ['npm', 'bin', 'javascript', 'typescript']),
  known('node-lib', 'Node package', 'library', 'nodedotjs',
    'npm, so `npm install` works for a stranger.',
    ['npm', 'javascript', 'typescript', 'package.json']),
  known('docker', 'Containerised service', 'backend', 'docker',
    'A registry and a host that runs the image.',
    ['dockerfile', 'compose', 'container', 'kubernetes']),
];

// ── Small helpers. No dependencies, no I/O. ─────────────────────────────────

export const byId = (id: string): Platform | undefined =>
  PLATFORMS.find(p => p.id === id);

export const withStatus = (status: PlatformStatus): Platform[] =>
  PLATFORMS.filter(p => p.status === status);

/** Archetypes some entry claims a pipeline for. */
export const deployedArchetypes = (): Archetype[] =>
  [...new Set(withStatus('deploys').flatMap(p => p.archetypes ?? []))];

/**
 * One lowercase string per platform to match a query against.
 *
 * Built here rather than in each consumer so the landing page's filter and any
 * future `launchpad platforms --search` agree by construction instead of by
 * two people implementing the same rules.
 */
export const searchIndex = (p: Platform): string =>
  [p.id, p.name, p.detectedAs ?? '', p.category, ...(p.aliases ?? [])]
    .join(' ')
    .toLowerCase();

export const search = (query: string): Platform[] => {
  const q = query.trim().toLowerCase();
  if (!q) return [...PLATFORMS];
  return PLATFORMS.filter(p => searchIndex(p).includes(q));
};

/**
 * The surfaces launchpad ships pipelines for, in the words the README and the
 * CLI use. `test/platforms.test.ts` checks both against this, so the prose
 * cannot quietly grow a sixth surface or lose one.
 */
export const SURFACE_LABELS: Record<Archetype, string> = {
  'ios': 'iOS app',
  'android': 'Android app',
  'macos-dmg': 'macOS app (DMG)',
  'web-app': 'Web app',
  'static-site': 'Static site',
};

/** "iOS, Android, macOS apps, web apps and static sites" — one place. */
export const surfaceSentence = (): string =>
  'iOS, Android, macOS apps, web apps and static sites';

export const hostNote = (host: HostRequirement): string => ({
  'any': 'Builds and ships from macOS, Windows or Linux.',
  'mac-for-local': 'CI builds it on a macOS runner, so you can ship it from any OS — but running it locally needs a Mac.',
  'mac-for-setup': 'CI builds it on a macOS runner, but two one-time setup steps read a Mac\'s keychain.',
}[host]);
