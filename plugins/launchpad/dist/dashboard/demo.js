import { mkdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { writeState } from '../state.js';
import { writeRegistry } from '../registry.js';
import { writeConfirmations } from '../confirmations.js';
import { writeConfig, defaultConfig } from '../nightshift/config.js';
import { writeTask } from '../nightshift/backlog.js';
import { appIcon, featureGraphic, screenshot } from './icon.js';
/**
 * A fictional fleet, on disk, so the dashboard can be photographed.
 *
 * The problem this solves is narrow and was named by the sellability audit: the
 * real fleet it was measured on was five neglected repos, so the hero image of
 * the product was a wall of red and three stat tiles reading zero. That is an
 * accurate picture of those repos and a terrible advertisement, because an ad
 * sells the *after* and the product had no after state to photograph.
 *
 * The honest way to build one, and the only way that stays honest: **write real
 * repositories and let the real code read them.** Every number on the demo
 * screen is computed by the same `scorecard()`, the same `decisionsFor()` and
 * the same `dashboardData()` as a customer's own projects, from files that
 * genuinely exist. There is no demo renderer, no fixture payload and no branch
 * in the data layer — `serve({ demo: true })` is `serve()` pointed at a
 * different HOME.
 *
 * That property is worth more than the convenience. A hand-written payload
 * would drift from the checks the moment either changed, and the first time it
 * showed a green cell the scorecard would have graded red, the screenshot would
 * be a lie — which, for a product whose entire pitch is that a false pass is
 * worse than a false gap, is the one failure that cannot be allowed.
 *
 * It is never the default, it is labelled in the product, and it is written to
 * a temporary directory that is not `~/.launchpad`.
 */
/**
 * Written under the OS temp dir, never the user's home.
 *
 * Suffixed with the pid so two of these can run at once. They collide
 * otherwise, and the way they collide is silent and confusing: the second
 * server deletes and rewrites the fleet the first one is watching, and the
 * first goes blank mid-recording.
 */
export const demoRoot = (pid = process.pid) => join(tmpdir(), `launchpad-demo-${pid}`);
/** The HOME the dashboard is pointed at. Holds the registry and nothing else. */
export const demoHome = (root = demoRoot()) => join(root, 'home');
/** Where the fictional repos live. `Code/<name>` so the header reads like a real path. */
export const demoCode = (root = demoRoot()) => join(root, 'Code');
const w = (file, text) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text, 'utf8');
};
const wb = (file, buf) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, buf);
};
/**
 * Enough `.git` for launchpad to read, and nothing more.
 *
 * `git.ts` deliberately reads refs off disk rather than shelling out, so a repo
 * for these purposes is three text files. No subprocess, no `git` on PATH, and
 * the demo works identically on a machine that has never installed it.
 */
function gitRepo(repo, opts) {
    const branch = opts.branch ?? 'main';
    const head = opts.head ?? '9f3c1ab7de5240c8b6e0114aa27d9f88c3a1b6e2';
    w(join(repo, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`);
    w(join(repo, '.git', 'refs', 'heads', branch), `${head}\n`);
    w(join(repo, '.git', 'refs', 'remotes', 'origin', 'HEAD'), `ref: refs/remotes/origin/${branch}\n`);
    for (const [tag, sha] of Object.entries(opts.tags ?? {})) {
        const p = join(repo, '.git', 'refs', 'tags', tag);
        w(p, `${sha}\n`);
    }
}
/** Date a ref so "last tagged" is a real mtime rather than whenever the demo was built. */
function dateTag(repo, tag, iso) {
    const t = new Date(iso);
    try {
        utimesSync(join(repo, '.git', 'refs', 'tags', tag), t, t);
    }
    catch { /* best effort */ }
}
const VALIDATE = (test) => `name: launchpad · validate
on:
  push:
    branches: ['**']
  pull_request:
jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: ${test}
`;
/** Shared spine: the files every plausible repo has, whatever it is written in. */
function base(repo, o) {
    w(join(repo, 'README.md'), [
        `# ${o.name}`, '', o.blurb, '',
        '## Install', '', '```bash', 'brew install --cask ' + o.name.toLowerCase(), '```', '',
        '## Support', '',
        `Found a problem? Open an issue: https://github.com/example/${o.name.toLowerCase()}/issues`,
        '', 'Licensed under the MIT licence. See LICENSE.', '',
    ].join('\n'));
    w(join(repo, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026\n');
    w(join(repo, '.gitignore'), ['node_modules/', 'build/', 'dist/', ...(o.gitignoreEnv === false ? [] : ['.env', '.env.*']), ''].join('\n'));
    if (o.changelog !== false) {
        w(join(repo, 'CHANGELOG.md'), '# Changelog\n\n## Unreleased\n\n## 1.0.0\n\n- First release.\n');
    }
    if (o.legal !== false) {
        w(join(repo, 'docs', 'privacy.md'), `# Privacy policy\n\n${o.name} collects nothing it does not need.\n`);
        w(join(repo, 'docs', 'terms.md'), `# Terms\n\nThe terms under which ${o.name} is provided.\n`);
    }
    w(join(repo, '.github', 'workflows', 'launchpad-validate.yml'), VALIDATE(o.test));
    if (o.deps)
        w(join(repo, 'package.json'), o.deps);
}
const pkg = (name, deps) => JSON.stringify({ name, private: true, version: '1.0.0', scripts: { test: 'vitest run' }, dependencies: deps }, null, 2) + '\n';
/** iOS/Android/macOS listing assets, in the places a store tool actually keeps them. */
function storeAssets(repo, name, o) {
    const meta = join(repo, 'fastlane', 'metadata', o.platform, 'en-US');
    w(join(meta, 'description.txt'), `${name} — the shortest path from your laptop to a store.\n`);
    w(join(meta, 'release_notes.txt'), 'Faster, quieter, and it remembers where you were.\n');
    w(join(meta, 'keywords.txt'), 'productivity, tools\n');
    for (let i = 1; i <= (o.shots ?? 3); i++) {
        wb(join(repo, 'fastlane', 'screenshots', o.platform, `${String(i).padStart(2, '0')}-home.png`), screenshot(name, i));
    }
    if (o.feature)
        wb(join(meta, 'images', 'featureGraphic.png'), featureGraphic(name));
}
/** The one image that makes a list of projects scannable. 1024, opaque — Apple's rule. */
const icon = (repo, name, rel = join('assets', 'icon.png')) => wb(join(repo, rel), appIcon(name, 1024));
const S = (id, archetype, evidence, config) => ({ id, archetype, status: 'wired', confidence: 'high', evidence, config: config });
export const DEMO_APPS = [
    {
        dir: 'harbormaster', name: 'Harbormaster',
        build: repo => {
            base(repo, {
                name: 'Harbormaster', test: 'npm test',
                blurb: 'A menu-bar window onto every container, tunnel and port on your Mac.',
                deps: pkg('harbormaster', { '@sentry/node': '^8.0.0', 'plausible-tracker': '^0.3.9', stripe: '^16.0.0' }),
            });
            // The notarization check looks for the COMMAND, wherever it lives — a
            // workflow, or a script the workflow calls. This is the second.
            w(join(repo, '.launchpad', 'macos', 'create-dmg.sh'), ['#!/usr/bin/env bash', 'set -euo pipefail', 'codesign --deep --options runtime --timestamp "$APP"',
                'xcrun notarytool submit "$DMG" --keychain-profile launchpad --wait',
                'xcrun stapler staple "$DMG"', ''].join('\n'));
            w(join(repo, '.github', 'workflows', 'launchpad-macos-release.yml'), ['name: launchpad · macOS release', 'on:', '  push:', "    tags: ['v*']", 'jobs:', '  release:',
                '    runs-on: macos-14', '    steps:', '      - uses: actions/checkout@v4',
                '      - run: ./.launchpad/macos/create-dmg.sh', ''].join('\n'));
            icon(repo, 'Harbormaster');
            storeAssets(repo, 'Harbormaster', { platform: 'mac', shots: 3 });
            gitRepo(repo, { tags: { 'v2.4.1': 'a1f9c3d77b204e8891c6b0ee42d3a7f51c0b9e64' }, head: 'c7d41e9ab8f2035c6a1d9e77b3042fa8cd51e6b0' });
            dateTag(repo, 'v2.4.1', '2026-09-16T10:12:00Z');
        },
        state: () => ({
            project: 'Harbormaster',
            surfaces: [
                S('app', 'macos-dmg', ['Package.swift declares a macOS executable target'], {
                    appName: 'Harbormaster', bundleId: 'studio.harbormaster.app', tagPrefix: 'v',
                    appcastDomain: 'updates.harbormaster.studio',
                    publicEdKey: 'kP2Qz0Yy8R1uQ3vN6mB4aE7dS9fH0jK2lM5nO8pT1rU=',
                    payments: 'lemonsqueezy',
                }),
                S('download', 'static-site', ['A Cloudflare Pages project with a download page'], {
                    pagesProject: 'harbormaster-site', publishDir: 'site/dist', prodDomain: 'harbormaster.studio',
                }),
            ],
            pipelines: [], credentialsRequired: [],
        }),
    },
    {
        dir: 'fernweh', name: 'Fernweh',
        build: repo => {
            base(repo, {
                name: 'Fernweh', test: 'flutter analyze && flutter test',
                blurb: 'One monorepo: the phone app, the web app, and the marketing site.',
                // A monorepo's root manifest is where the shared dependencies live, and
                // it is what the scorecard reads. No Sentry here on purpose — this app
                // is two things short of finished and crash reporting is one of them.
                deps: pkg('fernweh', { 'posthog-js': '^1.150.0', stripe: '^16.0.0' }),
            });
            w(join(repo, 'apps', 'mobile', 'pubspec.yaml'), ['name: fernweh', 'environment:', "  sdk: '>=3.4.0 <4.0.0'", 'dependencies:', '  flutter:',
                '    sdk: flutter', '  in_app_purchase: ^3.2.0', ''].join('\n'));
            // A stock Flutter project signs its RELEASE build with the DEBUG keystore.
            // This one does not, which is what the check is looking for.
            w(join(repo, 'apps', 'mobile', 'android', 'app', 'build.gradle.kts'), ['android {', '    signingConfigs {', '        create("release") {',
                '            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "upload.jks")',
                '        }', '    }', '    buildTypes {', '        release {',
                '            signingConfig = signingConfigs.getByName("release")', '        }', '    }', '}', ''].join('\n'));
            w(join(repo, '.github', 'workflows', 'launchpad-mobile-release.yml'), ['name: launchpad · mobile release', 'on:', '  push:', "    tags: ['v*']", '  workflow_dispatch:',
                'jobs:', '  ios:', '    runs-on: macos-14', '    steps:', '      - uses: actions/checkout@v4',
                '  android:', '    runs-on: ubuntu-latest', '    steps:', '      - uses: actions/checkout@v4', ''].join('\n'));
            icon(repo, 'Fernweh', join('apps', 'mobile', 'ios', 'Runner', 'Assets.xcassets', 'AppIcon.appiconset', 'icon.png'));
            // Screenshots and a metadata tree, but no 1024×500 feature graphic —
            // which is a hard block on publishing a Play listing, not a nag. It is
            // one of this project's two remaining things, and the better teaching
            // example of the two.
            storeAssets(repo, 'Fernweh', { platform: 'android', feature: false, shots: 4 });
            writeConfirmations(repo, { 'keystore-backup': { at: '2026-08-30', note: '1Password vault, shared with the co-founder' } });
            gitRepo(repo, { tags: { 'v1.8.0+214': 'b44e1c9f2a7d8036ee5c4a1b9d70f2c3a6b8e510' }, head: '3b9a7fe12d048c5e6a0b93fd7c214e8a95d0b6c1' });
            dateTag(repo, 'v1.8.0+214', '2026-09-19T21:40:00Z');
        },
        state: () => ({
            project: 'Fernweh',
            surfaces: [
                S('mobile-ios', 'ios', ['apps/mobile/ios/Runner.xcodeproj', 'pubspec.yaml declares flutter'], {
                    workdir: 'apps/mobile', scheme: 'Runner', bundleId: 'app.fernweh.mobile', tagPrefix: 'v',
                    flutterVersion: '3.41.9', runsOn: 'macos-latest', distributeOn: ['tag', 'manual'],
                    testArgs: '--exclude-tags golden',
                }),
                S('mobile-android', 'android', ['apps/mobile/android/app/build.gradle.kts'], {
                    workdir: 'apps/mobile', applicationId: 'app.fernweh.mobile', tagPrefix: 'v',
                    firebaseAppId: '1:482910375512:android:0e1f2a3b4c5d6e7f', testerGroup: 'insiders',
                    distributeOn: ['tag'],
                }),
                S('web', 'web-app', ['apps/web/next.config.mjs'], {
                    rootDir: 'apps/web', prodDomain: 'fernweh.app', framework: 'nextjs',
                }),
            ],
            pipelines: [{ kind: 'fastlane', path: 'apps/mobile/fastlane/Fastfile', disposition: 'leave-alone' }],
            credentialsRequired: [],
        }),
    },
    {
        dir: 'ketchbook', name: 'Ketchbook',
        build: repo => {
            base(repo, {
                name: 'Ketchbook', test: 'xcodebuild test -scheme Ketchbook -destination "platform=iOS Simulator,name=iPhone 16"',
                blurb: 'Recipes you actually cook, in the order you actually cook them.',
            });
            /**
             * A Fastfile the author wrote themselves, months before launchpad.
             *
             * The fleet had no repository in the state most real ones are in — already
             * shipping *somehow*, with a pipeline nobody has decided about yet. That
             * is the single most consequential question in onboarding (PLAYBOOK §5),
             * and with every demo pipeline pre-decided there was nowhere to photograph
             * it. Deliberately not launchpad-shaped: no generated stamp, a lane name
             * launchpad would not choose.
             */
            w(join(repo, 'fastlane', 'Fastfile'), ['default_platform(:ios)', '', 'platform :ios do',
                '  desc "Upload a build to TestFlight"', '  lane :beta do',
                '    build_app(scheme: "Ketchbook")', '    upload_to_testflight(skip_waiting_for_build_processing: true)',
                '  end', 'end', ''].join('\n'));
            w(join(repo, 'Package.swift'), ['// swift-tools-version:5.10', 'import PackageDescription', 'let package = Package(',
                '  name: "Ketchbook",', '  dependencies: [',
                '    .package(url: "https://github.com/getsentry/sentry-cocoa", from: "8.0.0"),',
                '    .package(url: "https://github.com/PostHog/posthog-ios", from: "3.0.0"),', '  ])', ''].join('\n'));
            w(join(repo, '.github', 'workflows', 'launchpad-ios-release.yml'), ['name: launchpad · iOS release', 'on:', '  push:', "    tags: ['v*']", '  workflow_dispatch:',
                'jobs:', '  testflight:', '    runs-on: macos-14', '    steps:', '      - uses: actions/checkout@v4', ''].join('\n'));
            icon(repo, 'Ketchbook', join('Ketchbook', 'Assets.xcassets', 'AppIcon.appiconset', 'icon.png'));
            storeAssets(repo, 'Ketchbook', { platform: 'ios', shots: 5 });
            // No tags: Ketchbook has never shipped. Every other project in the fleet
            // has, so without this there was no "first release on this channel" to
            // photograph — and that is the one confirmation the question bank says is
            // asked every single time, whatever the settings are.
            gitRepo(repo, { head: '81c4a0fe57b2396d8e1cb0a7f34d52698a1e7b3f' });
        },
        state: () => ({
            project: 'Ketchbook',
            surfaces: [
                // `pending`, not `wired`: the Fastfile below has no disposition yet, and
                // until that is answered launchpad has not written anything here. It is
                // also the only project in the fleet whose Decisions tab reads "would
                // choose" rather than "launchpad chose" — the state every buyer is in
                // when they are deciding whether to pay.
                {
                    id: 'ios', archetype: 'ios', status: 'pending', confidence: 'high',
                    evidence: ['Ketchbook.xcodeproj', 'Package.swift declares an iOS app target'],
                    config: {
                        scheme: 'Ketchbook', bundleId: 'com.ketchbook.app', tagPrefix: 'v',
                        runsOn: 'macos-latest', distributeOn: ['tag', 'manual'],
                    },
                },
            ],
            pipelines: [{ kind: 'fastlane', path: 'fastlane/Fastfile' }],
            credentialsRequired: [],
        }),
    },
    {
        dir: 'slatepad', name: 'Slatepad',
        build: repo => {
            base(repo, {
                name: 'Slatepad', test: './gradlew test',
                blurb: 'A notebook for people who think on paper but cannot carry paper.',
                // No analytics dependency: Slatepad's one remaining thing is that
                // nobody can tell whether anyone is using it.
                deps: pkg('slatepad-site', { '@sentry/react': '^8.0.0', stripe: '^16.0.0' }),
            });
            w(join(repo, 'android', 'app', 'build.gradle.kts'), ['android {', '    signingConfigs {', '        create("release") {',
                '            storeFile = file(System.getenv("ANDROID_KEYSTORE_PATH") ?: "upload.jks")',
                '        }', '    }', '    buildTypes { release { signingConfig = signingConfigs.getByName("release") } }',
                '}', ''].join('\n'));
            // No launchpad release workflow, on purpose: this app is native Gradle and
            // `apply` refuses it (DECISIONS.md, 2026-09-21 — "Android native is
            // `recognised`… `apply` refuses it by framework"). Writing one here would
            // photograph a pipeline the product declines to produce.
            icon(repo, 'Slatepad', join('android', 'app', 'src', 'main', 'res', 'mipmap-xxxhdpi', 'ic_launcher.png'));
            storeAssets(repo, 'Slatepad', { platform: 'android', feature: true, shots: 4 });
            writeConfirmations(repo, { 'keystore-backup': { at: '2026-07-04', note: 'Encrypted backup drive + offsite copy' } });
            gitRepo(repo, { tags: { 'v3.1.0': 'ef7a2c4d90b158e6a3c7b1d0e924f5a8c36b70d2' }, head: '5a2e9c17b0d436fa8e15c9d20b74e3a61f08c5d9' });
            dateTag(repo, 'v3.1.0', '2026-09-08T17:22:00Z');
        },
        state: () => ({
            project: 'Slatepad',
            surfaces: [
                /**
                 * Native Gradle, and therefore refused — which is what this repository's
                 * own files always said. There is no `pubspec.yaml` anywhere in it, its
                 * gate is `./gradlew test`, and its build file is Kotlin DSL. The state
                 * used to leave `framework` unset, which every reader defaults to
                 * `flutter`, so the demo quietly claimed a Flutter pipeline for a Gradle
                 * app — the exact mismatch `apply` exists to refuse.
                 *
                 * It is the most valuable row in the fleet for a buyer with an Android
                 * app: it shows the product declining to write something that would have
                 * looked right and failed in CI, and saying what they still get.
                 */
                {
                    id: 'android', archetype: 'android', status: 'pending', confidence: 'high',
                    framework: 'native',
                    evidence: ['android/app/build.gradle.kts', 'no pubspec.yaml — this is not a Flutter app'],
                    config: { applicationId: 'ink.slatepad', tagPrefix: 'v', framework: 'native' },
                },
                S('site', 'static-site', ['site/ is an Astro project deployed to Pages'], {
                    pagesProject: 'slatepad-site', publishDir: 'site/dist', prodDomain: 'slatepad.ink',
                }),
            ],
            pipelines: [], credentialsRequired: [],
        }),
    },
    {
        dir: 'northbeam', name: 'Northbeam',
        build: repo => {
            base(repo, {
                name: 'Northbeam', test: 'npm test',
                blurb: 'Shift handover for small teams. Web only, and deliberately so.',
                deps: pkg('northbeam', {
                    next: '^15.0.0', '@sentry/nextjs': '^8.0.0', 'posthog-js': '^1.150.0', stripe: '^16.0.0',
                }),
            });
            wb(join(repo, 'public', 'favicon.png'), appIcon('Northbeam', 512));
            icon(repo, 'Northbeam', join('public', 'icon.png'));
            gitRepo(repo, { tags: { 'v4.2.0': '7c1b93a0e5d248f6b0a3c8e17d926f4b5a0c8e31' }, head: 'e94b70a2c61d58f3b7a0e2c94d1f6835ab07c2de' });
            dateTag(repo, 'v4.2.0', '2026-09-20T13:48:00Z');
        },
        state: () => ({
            project: 'Northbeam',
            surfaces: [
                S('web', 'web-app', ['next.config.mjs', 'package.json declares next'], {
                    rootDir: '.', prodDomain: 'northbeam.team', framework: 'nextjs',
                }),
            ],
            pipelines: [{ kind: 'vercel', path: 'vercel.json', disposition: 'adopt' }],
            credentialsRequired: [],
        }),
    },
    {
        dir: 'coastline', name: 'Coastline',
        build: repo => {
            base(repo, {
                name: 'Coastline', test: 'npm test',
                blurb: 'The documentation and download site for a small studio.',
                // Sells something, reports its own crashes, and still cannot tell you
                // whether anybody reads it. That is Coastline's one remaining thing.
                deps: pkg('coastline', {
                    astro: '^5.0.0', '@sentry/astro': '^8.0.0', stripe: '^16.0.0',
                }),
            });
            wb(join(repo, 'public', 'favicon.png'), appIcon('Coastline', 512));
            gitRepo(repo, { tags: { 'v1.12.0': '2f8e0a71c94b356d8e1a0c7b93d45f628a1c0e97' }, head: '0b6d29c4a71e38f50c9b2a6e14d3f8792c5a0bde' });
            dateTag(repo, 'v1.12.0', '2026-09-21T06:30:00Z');
        },
        state: () => ({
            project: 'Coastline',
            surfaces: [
                S('site', 'static-site', ['astro.config.mjs', 'wrangler.toml names a Pages project'], {
                    pagesProject: 'coastline-site', publishDir: 'dist', prodDomain: 'coastline.studio',
                }),
            ],
            pipelines: [], credentialsRequired: [],
        }),
    },
    {
        dir: 'whetstone', name: 'Whetstone',
        build: repo => {
            // The honest "before". Onboarded three days ago, nothing wired, and the
            // list it has just been shown is the whole point of the product. A demo
            // fleet with nothing left to do would be a worse advertisement than this
            // one: it would have nothing to sell.
            w(join(repo, 'README.md'), [
                '# Whetstone', '',
                'A command-line tool for reshaping large CSV exports without loading them into memory.',
                '', 'Still early. The interface will change.', '',
                'Issues: https://github.com/example/whetstone/issues', '',
            ].join('\n'));
            w(join(repo, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026\n');
            w(join(repo, 'Cargo.toml'), ['[package]', 'name = "whetstone"', 'version = "0.1.0"', 'edition = "2021"', 'license = "MIT"',
                '', '[[bin]]', 'name = "whetstone"', 'path = "src/main.rs"', ''].join('\n'));
            w(join(repo, 'src', 'main.rs'), 'fn main() { println!("whetstone"); }\n');
            w(join(repo, '.gitignore'), '/target\n');
            w(join(repo, '.github', 'workflows', 'ci.yml'), VALIDATE('cargo test --all'));
            gitRepo(repo, { branch: 'master', head: 'aa03f7c1b95e284d6c0b7a3e15f9d248c07b6e31' });
        },
        state: () => ({
            // No surfaces: launchpad ships no pipeline for a Rust CLI and says so
            // rather than mis-wiring one. The checks and the roadmap still apply.
            project: 'Whetstone', surfaces: [], pipelines: [], credentialsRequired: [],
        }),
    },
];
/**
 * Queues, overnight settings and last night's rows — for two projects only.
 *
 * Not every project in a real fleet has an overnight worker, and a demo in
 * which all seven do would misrepresent the default. Nightshift is an opt-in
 * beta and it is shown as one: configured on two, switched on for one.
 */
function nightshift(repos) {
    const fernweh = repos.fernweh;
    writeConfig(fernweh, {
        ...defaultConfig('flutter analyze && flutter test', fernweh),
        enabled: true, window: '23:00-06:30', mode: 'pr', maxTasksPerNight: 3, groom: true,
    });
    writeTask(fernweh, {
        id: 'T041', title: 'Feature graphic for the Play listing', status: 'ready', priority: 0,
        body: 'Play will not publish the listing without a 1024×500 feature graphic. Produce one and put it in\n'
            + '`fastlane/metadata/android/en-US/images/featureGraphic.png`.\n',
    });
    writeTask(fernweh, {
        id: 'T042', title: 'Wire crash reporting into the mobile app', status: 'ready', priority: 1,
        body: 'Right now a crash reaches us as a one-star review or not at all.\n',
    });
    writeTask(fernweh, {
        id: 'T043', title: 'Offline cache for the trip timeline', status: 'ready', priority: 2, body: 'Timeline should survive a tunnel.\n',
    });
    writeTask(fernweh, {
        id: 'T038', title: 'Deep links from the web app into the phone app', status: 'blocked',
        reason: 'needs an apple-app-site-association file served from the web app\'s domain',
        body: 'Universal links need the association file at a known path.\n',
    });
    writeTask(fernweh, { id: 'T031', title: 'Move the settings sheet to the new navigation', status: 'done', body: '' });
    writeTask(fernweh, { id: 'T033', title: 'Retry uploads on a flaky connection', status: 'done', body: '' });
    w(join(fernweh, '.launchpad', 'nightshift', 'inbox.md'), ['- A widget that shows the next leg of the trip', '- Dark map tiles', ''].join('\n'));
    w(join(fernweh, '.launchpad', 'nightshift', 'events.jsonl'), [
        JSON.stringify({ ts: '2026-09-21T01:12:00Z', project: 'Fernweh', taskId: 'T031', title: 'Move the settings sheet to the new navigation', outcome: 'pushed', commit: '3b9a7fe', durationS: 1420 }),
        JSON.stringify({ ts: '2026-09-21T01:41:00Z', project: 'Fernweh', taskId: 'T033', title: 'Retry uploads on a flaky connection', outcome: 'pushed', commit: '9c2e41b', durationS: 980 }),
        JSON.stringify({ ts: '2026-09-21T02:03:00Z', project: 'Fernweh', taskId: 'T038', title: 'Deep links from the web app into the phone app', outcome: 'blocked', durationS: 610 }),
    ].join('\n') + '\n');
    const harbor = repos.harbormaster;
    // Configured, deliberately off. The default a stranger gets, shown as the
    // default: an agent that writes code overnight never switches itself on.
    writeConfig(harbor, { ...defaultConfig('npm test', harbor), enabled: false, window: '01:00-06:00' });
    writeTask(harbor, {
        id: 'T007', title: 'Group tunnels by the project that opened them', status: 'scoped', priority: 1,
        body: 'Flat list gets unreadable past about twenty.\n',
    });
    writeTask(harbor, { id: 'T004', title: 'Remember window position per display', status: 'done', body: '' });
}
/**
 * Build the whole thing, from scratch, every time.
 *
 * Rebuilt rather than reused because the replay sequence mutates these repos,
 * and a demo that opened in whatever state the last recording left it in would
 * be neither reproducible nor honest.
 */
export function materializeDemo(root = demoRoot()) {
    rmSync(root, { recursive: true, force: true });
    const code = demoCode(root);
    const home = demoHome(root);
    mkdirSync(home, { recursive: true });
    const repos = {};
    for (const app of DEMO_APPS) {
        const repo = join(code, app.dir);
        mkdirSync(repo, { recursive: true });
        app.build(repo);
        writeState(repo, app.state(repo));
        repos[app.dir] = repo;
    }
    nightshift(repos);
    w(join(home, '.launchpad', 'nightshift', 'last-night.md'), [
        '# Nightshift — 2026-09-21', '',
        'Two tasks landed as pull requests; one stopped and said why.', '',
        '| Project | Task | Outcome |', '|---|---|---|',
        '| Fernweh | T031 Move the settings sheet to the new navigation | pushed |',
        '| Fernweh | T033 Retry uploads on a flaky connection | pushed |',
        '| Fernweh | T038 Deep links from the web app into the phone app | blocked |', '',
    ].join('\n'));
    // Sorted by path, because that is what `addProject` does — an unsorted demo
    // registry would put the fleet in an order no real fleet is ever in, and the
    // replay (which re-adds through the sorted path) would end somewhere else.
    writeRegistry({
        projects: DEMO_APPS
            .map(a => ({ path: join(code, a.dir), added: '2026-09-18T09:00:00Z' }))
            .sort((x, y) => x.path.localeCompare(y.path)),
    }, home);
    return home;
}
