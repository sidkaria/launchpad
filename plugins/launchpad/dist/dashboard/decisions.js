import { androidFramework } from '../archetypes/android.js';
import { isGradleFramework } from '../archetypes/androidgradle.js';
import { MACOS_ARM64_ONLY, macosRunsOn } from '../archetypes/macos.js';
const label = (s) => `${{ 'ios': 'iOS', 'android': 'Android', 'macos-dmg': 'macOS', 'web-app': 'Web', 'static-site': 'Site' }[s.archetype]} · ${s.id}`;
export function decisionsFor(st) {
    const out = [];
    const wired = st.surfaces.filter(s => s.status === 'wired');
    const kinds = new Set(st.surfaces.map(s => s.archetype));
    /** Nothing wired yet: everything below is what launchpad WOULD do, labelled as such. */
    const ahead = wired.length === 0;
    out.push({
        area: 'Continuous integration',
        choice: 'GitHub Actions',
        why: 'It runs where your code already lives — no second account, no separate bill, and the '
            + 'credentials are the ones you already have. This is the decision you did not have to research.',
        source: 'launchpad',
        cost: 'free for public repos; included minutes for private',
        money: { amount: 0, currency: 'USD', cadence: 'monthly', class: 'launchpads-choice' },
        proposed: ahead,
    });
    out.push({
        // "Your OS keychain" was false on every Windows machine and file vault.
        area: 'Credentials',
        choice: 'Your vault (the OS keychain, or an encrypted file), copied to GitHub by `launchpad secrets`',
        why: 'A key committed to git is public the moment the repo is, and deleting it later does not '
            + 'help — it stays in the history. Nothing is ever written into the repository.',
        source: 'launchpad',
        proposed: ahead,
    });
    /**
     * Decisions that hold whatever the project is written in.
     *
     * A Rust CLI or a Django service has no surface launchpad ships a pipeline
     * for, and used to see a completely empty Decisions screen — which reads as
     * "this tool has nothing for me" rather than "this tool does not wire your
     * build". These four apply to anything with a git repo, so the screen is
     * never blank and the reasoning is visible to every buyer.
     */
    out.push({
        area: 'Release identity',
        choice: 'Annotated git tags as the source of truth for versions',
        why: 'A version that lives only in a file gets bumped by hand and eventually ships twice. A tag '
            + 'is immutable, it is what every store and updater keys off, and it is the thing you can point '
            + 'a bug report at six months later.',
        source: 'launchpad',
        proposed: ahead,
    });
    if (!kinds.size) {
        out.push({
            area: 'Scope',
            choice: st.ecosystem
                ? `${st.ecosystem} — readiness, roadmap and the overnight worker, no build pipeline`
                : 'Readiness, roadmap and the overnight worker — no build pipeline',
            why: 'launchpad ships pipelines for iOS, Android, macOS, web apps and static sites, and this '
                + 'repo is none of those. Rather than writing a workflow that does not fit, it says so: the '
                + 'checks, the queue and the dashboard do not care what language you used, and all still apply.',
            source: 'launchpad',
        });
    }
    if (kinds.has('ios') || kinds.has('android')) {
        out.push({
            area: 'Test gate',
            choice: 'Analyze and test on ubuntu-latest, every push',
            why: 'macOS runners bill roughly 10× Linux. On a busy mobile repo, building everything on '
                + 'every push is around $100/month; the cheap lane catches most problems for about nothing, '
                + 'and the expensive one only runs when you ask for it.',
            source: 'launchpad',
            cost: '~$0 vs ~$100/mo',
            // The number in the ledger is what this decision costs as taken — about
            // nothing. The ~$100 is the bill it AVOIDS, and adding an avoided cost to
            // a total would be the ledger charging for a decision that saved money.
            money: { amount: 0, currency: 'USD', cadence: 'monthly', class: 'launchpads-choice' },
        });
    }
    // Every surface, not only the wired ones. The reasoning for a surface
    // launchpad has not touched yet is exactly what a buyer is deciding on.
    for (const s of st.surfaces) {
        const a = label(s);
        if (s.archetype === 'ios') {
            const c = (s.config ?? {});
            out.push(c.matchGitUrl
                ? {
                    area: a, source: 'launchpad',
                    choice: 'match signing, from a shared certificates repo',
                    why: 'Your certificates live in one encrypted repo that CI reads with a read-only deploy key. '
                        + 'Chosen over cloud signing because you already had a certs repo — a deploy key is scoped '
                        + 'to one repository and cannot write.',
                }
                : {
                    area: a, source: 'launchpad',
                    choice: 'Cloud signing — an App Store Connect key, nothing else',
                    why: 'Apple manages the certificates and profiles, so there is no certs repo to maintain, '
                        + 'nothing to rotate by hand, and no keychain on the runner. It also means you can ship '
                        + 'this iOS app to TestFlight without owning a Mac.',
                });
            if (c.distributeOn?.length) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: `Ships on: ${c.distributeOn.join(' + ')}`,
                    why: 'A build that ships should be something you asked for. Pushing to a branch runs the '
                        + 'cheap checks; a tag or a manual dispatch is what actually reaches TestFlight.',
                });
            }
            if (c.runsOn) {
                out.push({
                    area: a, source: c.runsOn === 'self-hosted' ? 'yours' : 'launchpad',
                    choice: `Builds on ${c.runsOn}`,
                    why: c.runsOn === 'self-hosted'
                        ? 'Your own Mac runs the builds, so macOS CI minutes cost nothing. The workflow creates a '
                            + 'throwaway keychain per run, because a launchd-managed runner cannot reach the login keychain.'
                        : 'GitHub\'s hosted macOS runners. A spare Mac as a self-hosted runner would take this to $0.',
                    cost: c.runsOn === 'self-hosted' ? '$0, unmetered' : 'billed per minute at the macOS rate',
                    money: c.runsOn === 'self-hosted'
                        ? { amount: 0, currency: 'USD', cadence: 'monthly', class: 'launchpads-choice' }
                        : { amount: null, currency: 'USD', cadence: 'per-minute', class: 'launchpads-choice' },
                });
            }
            if (c.flutterVersion) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: `Flutter pinned to ${c.flutterVersion}`,
                    why: 'A floating `stable` silently moves ahead of your machine and one day fails analyze on a '
                        + 'new deprecation in code that is clean locally. It reads as a lint problem and is a '
                        + 'version problem. Bump it deliberately.',
                });
            }
            if (c.testArgs) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: `Golden tests excluded from the cheap lane (${c.testArgs})`,
                    why: 'Baselines rasterised on macOS never match a Linux runner, so every golden fails for '
                        + 'reasons that say nothing about your change.',
                });
            }
        }
        if (s.archetype === 'android') {
            const c = (s.config ?? {});
            const framework = androidFramework(c, s);
            if (isGradleFramework(framework)) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: 'Gradle on Linux: Temurin JDK 17, `setup-gradle` for caching and wrapper checks',
                    why: 'Every Android Gradle Plugin from 8.0 to today names JDK 17 as its minimum, so that is '
                        + 'the floor rather than whatever the runner happens to ship — a toolchain that floats is '
                        + 'a build that breaks on a day you changed nothing. `gradle/actions/setup-gradle` '
                        + 'supersedes the archived build-action, caches the Gradle home by default, and validates '
                        + 'every wrapper JAR\'s checksum on each run, which is why there is no separate '
                        + 'wrapper-validation step to maintain.',
                    cost: 'free — Linux runners are free on public repos and the cheapest tier on private ones',
                });
                out.push({
                    area: a, source: 'launchpad',
                    choice: 'Both artifacts every build: the APK for testers, the AAB for Play',
                    why: 'Play requires an App Bundle from every new app, and Firebase App Distribution can only '
                        + 'take an AAB once the app is already published in Play and linked to it — which a '
                        + 'pre-launch app sending builds to testers is not. Building only one of the two would be '
                        + 'a pipeline that works for everybody except the person who needs it first. The AAB is '
                        + 'kept on the run, so the day the Play account is ready it is already there.',
                });
                out.push({
                    area: a, source: 'launchpad',
                    choice: 'A version code from the commit count, passed in by CI',
                    why: 'Play rejects an upload whose version code is not higher than the last, and testers '
                        + 'reading "version 1" on every build learn to ignore it. The number is the commit count, '
                        + 'so it climbs on its own and a re-run of the same commit produces the same value. Your '
                        + 'own version code stays in the file and stays authoritative everywhere except CI.',
                });
            }
            if (framework === 'expo') {
                out.push({
                    area: a, source: 'launchpad',
                    choice: '`expo prebuild --clean` on GitHub Actions, not EAS Build',
                    why: 'EAS is Expo\'s own service and it is good, but it needs an Expo account and an access '
                        + 'token before a single build can run, and its free tier is a monthly cliff that turns '
                        + 'into a subscription exactly when the project starts working. Prebuild in CI runs on the '
                        + 'GitHub account you already have. `--clean` is what makes it reliable: Expo warns that an '
                        + 'incremental prebuild layers changes and may not reproduce, and a fresh runner has '
                        + 'nothing to layer onto. EAS stays available if you ever want it.',
                    cost: 'free — versus an Expo plan once the free build quota runs out',
                });
            }
            out.push({
                area: a, source: 'launchpad',
                choice: 'Release signing with a real keystore, injected in CI',
                why: 'A stock Flutter or Android project signs its RELEASE build with the DEBUG keystore. The '
                    + 'output looks shippable, no store will accept it, and its identity changes per machine. '
                    + 'Back that keystore up somewhere that is not this machine — lose it and this app can never '
                    + 'be updated again.',
            });
            if (c.firebaseAppId) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: `Firebase App Distribution → ${c.testerGroup || 'testers'}`,
                    why: 'No-cost on Firebase\'s Spark plan, and it needs no Play Console account to get builds '
                        + 'in front of real testers. Play is $25 one-time whenever you want the public track — but '
                        + 'a personal Play account opened after 13 Nov 2023 must first run a closed test with 12 '
                        + 'testers opted in continuously for 14 days, plus identity verification. The fee is not '
                        + 'the barrier; the fortnight is, which is the real reason to start here.',
                    cost: 'free (Play: $25 one-time, after a 14-day testing gate)',
                    // Zero, because this decision is Firebase. Play's fee and its 14-day
                    // gate are a separate question with a separate answer, and they
                    // surface as their own store-gate item in `needs.ts`.
                    money: { amount: 0, currency: 'USD', cadence: 'monthly', class: 'launchpads-choice' },
                });
            }
            if (c.distributeOn?.includes('schedule')) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: `Batched nightly${c.schedule ? ` (${c.schedule})` : ''} rather than per-push`,
                    why: 'The scheduled run diffs a 26-hour window — overlapping the daily cadence so a commit '
                        + 'cannot fall between two runs — and no-ops on a quiet night, so it costs nothing.',
                });
            }
        }
        if (s.archetype === 'macos-dmg') {
            const c = (s.config ?? {});
            out.push({
                area: a, source: 'launchpad',
                choice: 'Developer ID signed, notarized, shipped as a DMG',
                why: 'An un-notarized Mac app shows a Gatekeeper warning most people will not click through. '
                    + 'It is invisible to a first-time shipper and it costs you most of your downloads.',
            });
            /**
             * Which Macs the DMG opens on — a default, so it has to be said.
             *
             * Unset is `arm64` (DECISIONS 2026-09-22): the build every state file
             * written before the knob existed produces, byte for byte. A shipped app's
             * site claimed Intel support for months over an arm64-only binary, and
             * nobody had decided that — it was a default nothing mentioned. So the
             * default is an entry here like any other choice, in the archetype's own
             * words (`MACOS_ARM64_ONLY`), and choosing `universal` is one too.
             *
             * No `money`. Neither answer has a fee, and the ledger adds decisions by
             * their `money`, so a choice that costs nothing must not carry one — a
             * `0` line would still be a line in "what this costs" about something
             * that is not a cost. An unknown value is not described here: `apply`
             * refuses it and says why, and there is no decision to show until it is
             * one of the two.
             */
            const arch = c.architectures ?? 'arm64';
            if (arch === 'arm64') {
                out.push({
                    area: a, source: 'launchpad',
                    choice: MACOS_ARM64_ONLY,
                    why: 'The DMG is built for Apple Silicon (arm64) alone, which is what every Mac Apple sells today '
                        + 'runs. An Intel Mac will not open it at all, so a download page or a listing that says '
                        + '"Intel" is wrong until this changes. It is the default because it is what an existing '
                        + 'pipeline already builds, and changing a shipped app\'s binary under its users is not a '
                        + 'thing to do silently. Reversible: `architectures: universal` on this surface in '
                        + '`.launchpad/state.yml`, re-run `apply`, and the next release is universal — same DMG '
                        + 'name, same appcast.',
                    cost: 'none · reversible at the next release',
                });
            }
            else if (arch === 'universal') {
                out.push({
                    area: a, source: 'launchpad',
                    choice: macosRunsOn(c),
                    why: 'One binary with both arm64 and x86_64 in it, so the same DMG opens on an Intel Mac and on '
                        + 'Apple Silicon. The release checks the built app for both slices and fails rather than ship '
                        + 'an Intel owner a binary that will not open. The DMG name and the appcast are the same either '
                        + 'way, so going back to Apple Silicon only is one line and the next release.',
                    cost: 'none, beyond a longer release build · reversible at the next release',
                });
            }
            if (c.appcastDomain) {
                out.push({
                    area: a, source: 'launchpad',
                    choice: `Sparkle auto-update, appcast on ${c.appcastDomain}`,
                    why: 'Ship a Mac app with no updater and every user is frozen on v1 forever. The signing key '
                        + 'is generated per app — whoever holds it can sign updates for that app, so it is never '
                        + 'shared between two of yours.',
                    cost: 'R2 storage, effectively $0',
                    money: { amount: 0, currency: 'USD', cadence: 'monthly', class: 'launchpads-choice' },
                });
            }
        }
        if (s.archetype === 'web-app') {
            const c = (s.config ?? {});
            out.push({
                area: a, source: 'launchpad',
                choice: `Vercel${c.rootDir ? `, root ${c.rootDir}` : ''}${c.prodDomain ? ` → ${c.prodDomain}` : ''}`,
                why: 'Preview per branch, production on main, via the native git integration — so there is no '
                    + 'deploy workflow to maintain and no token to rotate.',
                // Hobby is non-commercial use only, and every launchpad buyer is by
                // definition trying to monetise something. Telling them the free tier
                // covers it was advising a terms violation on the way to their first sale.
                cost: 'Hobby (free) while there is nothing to buy; Pro at $20/seat/mo once you charge — '
                    + 'Hobby is licensed for non-commercial use only',
                // The number is $20, and it is conditional. `onlyWhen` is what stops a
                // fleet ledger charging $20/month for a side project with no checkout —
                // and what lets `needs.ts` raise the same $20 as a decision to make the
                // moment a paywall appears in the repo, quoting this chip's own figure.
                money: {
                    amount: 20, currency: 'USD', cadence: 'monthly', class: 'unavoidable',
                    onlyWhen: 'once you charge for it — Hobby is licensed for non-commercial use only',
                },
            });
            out.push({
                area: a, source: 'launchpad',
                choice: 'Ignored Build Step, so unrelated commits do not rebuild this',
                why: 'In a monorepo every push would otherwise deploy every app. Exit 0 means SKIP in Vercel\'s '
                    + 'ignore step, so the clauses join with && rather than ||. Getting that backwards either '
                    + 'deploys always or never, with no error either way.',
            });
        }
        if (s.archetype === 'static-site') {
            const c = (s.config ?? {});
            out.push({
                area: a, source: 'launchpad',
                choice: `Cloudflare Pages${c.pagesProject ? ` (${c.pagesProject})` : ''}`,
                why: 'Trunk-based production with preview branches, on a free tier that does not meter '
                    + 'bandwidth — which is why the download PAGE lives here. The binaries themselves do not: '
                    + 'Pages refuses any single file over 25 MiB and the limit cannot be raised, so a DMG in '
                    + 'the published directory fails the deploy. Artifacts go to R2 and the page links to them.',
                cost: 'free',
                money: { amount: 0, currency: 'USD', cadence: 'monthly', class: 'launchpads-choice' },
            });
        }
    }
    /**
     * Mark everything about a surface launchpad has not wired yet.
     *
     * Done by area after the fact rather than inline on each push, so a decision
     * added to the loop later cannot forget to say whether it has happened — the
     * failure mode of the inline version is a proposal that presents itself as an
     * accomplished fact, which is the one thing this screen must never do.
     */
    const pendingAreas = new Set(st.surfaces.filter(s => s.status !== 'wired').map(label));
    for (const d of out) {
        if (d.source === 'launchpad' && pendingAreas.has(d.area))
            d.proposed = true;
    }
    for (const p of st.pipelines) {
        const d = p.disposition;
        if (!d)
            continue;
        out.push({
            area: `Existing: ${p.kind}`,
            source: 'yours',
            choice: { adopt: 'Adopted', migrate: 'Migrated to launchpad', 'leave-alone': 'Left alone' }[d],
            why: d === 'leave-alone'
                ? `${p.path} is yours and launchpad never writes to it. Most real repos already ship somehow, and `
                    + 'breaking the thing that works is the one unrecoverable mistake available here.'
                : d === 'adopt'
                    ? `${p.path} already worked, so it is used as-is rather than replaced.`
                    : `${p.path} was replaced, and the original is preserved alongside it so the old behaviour stays diffable.`,
        });
    }
    return out;
}
