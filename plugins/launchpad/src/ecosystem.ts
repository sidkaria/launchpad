import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What KIND of thing this repo is, independent of whether launchpad can wire it.
 *
 * Detection until now answered one question: which of the five archetypes does
 * this repo contain? That question has a correct answer of "none" for a great
 * many real projects, and the product then behaved as though the repo itself
 * were empty. Rails and Rust produced **byte-identical** scorecards, and a Rust
 * CLI author was told that a privacy policy is "MANDATORY for the App Store and
 * Play" and that a Stripe checkout would get them rejected. For the
 * Python/Go/Rust/Rails/Electron buyer that is the refund: not that the pipeline
 * is missing — the message about that is honest — but that the tool visibly does
 * not know what it is looking at.
 *
 * An archetype is "launchpad ships a pipeline for this". An ecosystem is "this
 * is what the project IS". They are different questions and conflating them is
 * what produced the identical scorecards.
 *
 * The point of this file is not to add pipelines. It is so the product can say
 * "Rust CLI" out loud, and then ask the questions that actually apply to one.
 */

/**
 * What "shipped" means here — the single most useful thing to know, because it
 * decides which questions are worth asking.
 */
export type Ships =
  /** A binary someone runs. Shipped = installable from somewhere. */
  | 'cli'
  /** Code other code depends on. Shipped = published, versioned, licensed. */
  | 'library'
  /** Something that runs on a server. Shipped = deployed and reachable. */
  | 'service'
  /** A desktop app that is not an Xcode project. Shipped = signed and downloadable. */
  | 'desktop'
  /** Pages. Shipped = a URL. */
  | 'site'
  /** A store app. Shipped = a review queue. Already launchpad's home ground. */
  | 'app';

export interface Ecosystem {
  /** Stable id for tests and config. */
  id: string;
  /** What to call it to a human. */
  name: string;
  ships: Ships;
  /** Why detection believes this. */
  evidence: string;
  /** The public registry a stranger would install from, where there is one. */
  registry?: string;
}

const read = (repo: string, rel: string): string => {
  try { return readFileSync(join(repo, rel), 'utf8'); } catch { return ''; }
};
const has = (repo: string, rel: string): boolean => existsSync(join(repo, rel));
const ls = (repo: string, rel = ''): string[] => {
  try { return readdirSync(join(repo, rel)); } catch { return []; }
};

/**
 * Ordered most specific first, and the order is load-bearing.
 *
 * An Electron app has a `package.json` and would match a plain Node library; a
 * Rails app has a `Gemfile` that a bare Ruby gem also has; a Tauri app is an
 * Electron-shaped repo with a Rust crate inside it, so it matches both `Cargo.toml`
 * and `package.json`. Whichever rule runs first wins, so the specific ones do.
 */
const RULES: Array<{
  id: string; name: string; ships: Ships; registry?: string;
  detect: (repo: string) => string | null;
}> = [
  {
    id: 'tauri', name: 'Tauri desktop app', ships: 'desktop',
    detect: r => has(r, 'src-tauri/tauri.conf.json') ? 'src-tauri/tauri.conf.json'
      : /"@tauri-apps\/(cli|api)"\s*:/.test(read(r, 'package.json')) ? '@tauri-apps in package.json' : null,
  },
  {
    id: 'electron', name: 'Electron desktop app', ships: 'desktop',
    detect: r => {
      const pkg = read(r, 'package.json');
      if (/"electron"\s*:/.test(pkg)) return 'electron in package.json';
      if (/"electron-builder"\s*:|"@electron-forge\//.test(pkg)) return 'electron-builder in package.json';
      return has(r, 'electron-builder.yml') || has(r, 'forge.config.js') ? 'an Electron packaging config' : null;
    },
  },
  /**
   * A Swift package, which is the thing an Xcode *app* is not.
   *
   * Without this rule `detect` answered `ecosystem: null` for
   * `apple/swift-argument-parser` and the honest "this is a Swift package"
   * sentence — the entire reason this module exists — never appeared. It sits
   * above the generic rules and below the desktop ones: a Tauri or Electron app
   * has no `Package.swift`, and nothing else claims one.
   *
   * `ships: 'library'` even when the package also vends an executable, because
   * the questions that matter for a package are the library ones: a licence, a
   * README that reads as documentation, and a version tag somebody can depend
   * on. Whether it ALSO produces something to download is a surface question,
   * and surface detection answers it separately.
   */
  {
    id: 'swift-package', name: 'Swift package', ships: 'library',
    detect: r => has(r, 'Package.swift') ? 'Package.swift' : null,
  },
  {
    id: 'rails', name: 'Ruby on Rails app', ships: 'service',
    detect: r => /gem\s+['"]rails['"]/.test(read(r, 'Gemfile')) ? "rails in Gemfile"
      : has(r, 'config/application.rb') && has(r, 'config.ru') ? 'config/application.rb + config.ru' : null,
  },
  {
    id: 'django', name: 'Django app', ships: 'service',
    detect: r => {
      const deps = read(r, 'requirements.txt') + read(r, 'pyproject.toml') + read(r, 'Pipfile');
      if (has(r, 'manage.py') && /django/i.test(deps + read(r, 'manage.py'))) return 'manage.py + Django';
      return /^\s*django\b/im.test(deps) ? 'Django in the dependencies' : null;
    },
  },
  {
    id: 'python-service', name: 'Python web service', ships: 'service',
    detect: r => {
      const deps = read(r, 'requirements.txt') + read(r, 'pyproject.toml') + read(r, 'Pipfile');
      const m = /(fastapi|flask|litestar|sanic|aiohttp)/i.exec(deps);
      return m ? `${m[1]} in the dependencies` : null;
    },
  },
  {
    id: 'laravel', name: 'Laravel app', ships: 'service',
    detect: r => has(r, 'artisan') && /laravel\/framework/.test(read(r, 'composer.json'))
      ? 'artisan + laravel/framework' : null,
  },
  {
    id: 'phoenix', name: 'Phoenix app', ships: 'service',
    detect: r => /:phoenix\b/.test(read(r, 'mix.exs')) ? 'phoenix in mix.exs' : null,
  },
  {
    id: 'elixir', name: 'Elixir project', ships: 'library', registry: 'Hex',
    detect: r => has(r, 'mix.exs') ? 'mix.exs' : null,
  },
  {
    id: 'rust', name: 'Rust project', ships: 'cli', registry: 'crates.io',
    detect: r => has(r, 'Cargo.toml') ? 'Cargo.toml' : null,
  },
  {
    id: 'go', name: 'Go project', ships: 'cli', registry: 'the Go module proxy',
    detect: r => has(r, 'go.mod') ? 'go.mod' : null,
  },
  {
    id: 'python', name: 'Python package', ships: 'library', registry: 'PyPI',
    detect: r => has(r, 'pyproject.toml') ? 'pyproject.toml'
      : has(r, 'setup.py') ? 'setup.py'
      : has(r, 'requirements.txt') ? 'requirements.txt' : null,
  },
  {
    id: 'ruby-gem', name: 'Ruby gem', ships: 'library', registry: 'RubyGems',
    detect: r => ls(r).some(n => n.endsWith('.gemspec')) ? 'a .gemspec' : null,
  },
  {
    id: 'dotnet', name: '.NET project', ships: 'service', registry: 'NuGet',
    detect: r => ls(r).find(n => /\.(csproj|fsproj|sln)$/.test(n)) ?? null,
  },
  {
    id: 'jvm', name: 'JVM project', ships: 'service', registry: 'Maven Central',
    detect: r => has(r, 'pom.xml') ? 'pom.xml'
      : has(r, 'build.gradle') || has(r, 'build.gradle.kts') ? 'a Gradle build' : null,
  },
  {
    id: 'node-cli', name: 'Node CLI', ships: 'cli', registry: 'npm',
    detect: r => /"bin"\s*:/.test(read(r, 'package.json')) ? 'a bin entry in package.json' : null,
  },
  {
    id: 'node-lib', name: 'Node package', ships: 'library', registry: 'npm',
    detect: r => has(r, 'package.json') ? 'package.json' : null,
  },
  {
    id: 'docker', name: 'Containerised service', ships: 'service',
    detect: r => has(r, 'Dockerfile') || has(r, 'compose.yaml') || has(r, 'docker-compose.yml')
      ? 'a Dockerfile or compose file' : null,
  },
];

/**
 * Every ecosystem this file can name, without the detection closures.
 *
 * Exported so the platform registry (`platforms.ts`) can be checked against it
 * rather than transcribed from it. The failure mode being prevented is silent:
 * someone adds a rule here, the landing page never mentions it, and the product
 * recognises a stack the page says nothing about — or, worse, the reverse.
 */
export const ECOSYSTEM_CATALOGUE: ReadonlyArray<{
  id: string; name: string; ships: Ships; registry?: string;
}> = RULES.map(({ id, name, ships, registry }) => ({ id, name, ships, ...(registry ? { registry } : {}) }));

/**
 * The single best description of this repo, or null when nothing is recognised.
 *
 * One answer rather than a list, deliberately: the point is to say "Rust CLI"
 * with confidence, and a repo reported as five overlapping ecosystems is the
 * same unhelpful mush as reporting none. A monorepo's individual deployable
 * parts are already handled by surface detection, which does recurse.
 */
export function ecosystemOf(repo: string): Ecosystem | null {
  for (const rule of RULES) {
    const evidence = rule.detect(repo);
    if (evidence) {
      return { id: rule.id, name: rule.name, ships: rule.ships, evidence, ...(rule.registry ? { registry: rule.registry } : {}) };
    }
  }
  return null;
}

/**
 * Refine `cli` vs `library` for the ecosystems where the manifest says which.
 *
 * Worth the extra step because it changes the question that matters: a library
 * without a licence file is legally unusable by anyone, and a CLI nobody can
 * install is just a repository. Getting this backwards asks the wrong one.
 */
export function refine(repo: string, eco: Ecosystem): Ecosystem {
  if (eco.id === 'rust') {
    const cargo = read(repo, 'Cargo.toml');
    const isBin = /\[\[bin\]\]/.test(cargo) || has(repo, 'src/main.rs');
    const isLib = /\[lib\]/.test(cargo) || has(repo, 'src/lib.rs');
    if (isBin) return { ...eco, name: 'Rust CLI', ships: 'cli' };
    if (isLib) return { ...eco, name: 'Rust crate', ships: 'library' };
  }
  if (eco.id === 'go') {
    const isCmd = has(repo, 'main.go') || ls(repo, 'cmd').length > 0;
    return isCmd
      ? { ...eco, name: 'Go CLI', ships: 'cli' }
      : { ...eco, name: 'Go module', ships: 'library' };
  }
  if (eco.id === 'python') {
    const proj = read(repo, 'pyproject.toml');
    if (/\[project\.scripts\]|console_scripts/.test(proj + read(repo, 'setup.py'))) {
      return { ...eco, name: 'Python CLI', ships: 'cli' };
    }
  }
  return eco;
}

/** The detected ecosystem, refined. The one function callers want. */
export const detectEcosystem = (repo: string): Ecosystem | null => {
  const eco = ecosystemOf(repo);
  return eco ? refine(repo, eco) : null;
};

/** "a Rust CLI" but "an Electron desktop app". Cheap, and its absence reads as sloppiness. */
export const article = (name: string): string => (/^[aeiou]/i.test(name) ? 'an' : 'a');

/** How a stranger gets a copy — the sentence that makes `install-path` concrete. */
export function installPhrase(eco: Ecosystem): string {
  return eco.registry
    ? `published to ${eco.registry}, so \`install\` is one command for a stranger`
    : 'downloadable or deployable by somebody who is not you';
}
