#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { detect } from '../detect.js';
import { readState, readStateOrError, writeState, mergeState, fillDefaultBranch } from '../state.js';
import { defaultBranchWithSource, isRepo } from '../git.js';
import { upsertClaudeMd, writeDeploymentDoc } from '../context.js';
import { makeVault, detectBackend, requestedBackend, backendLabel, vaultReadCommand, VAULT_BACKEND_ENV, } from '../vault.js';
import { writeMacosFiles, MACOS_GLOBAL_SECRETS, MACOS_PER_APP_SECRETS } from '../archetypes/macos.js';
import { wireAutoupdate } from '../archetypes/autoupdate.js';
import { wireDevBuild, ensureXcodegenScheme } from '../archetypes/devbuild.js';
import { writeIosFiles, iosSecrets, isWireable, staleExpoFastfile, iosFastlaneDir } from '../archetypes/ios.js';
import { writeAndroidFiles, ANDROID_GLOBAL_SECRETS, androidFramework, androidIsWireable, androidRefusal, resolveAndroidConfig, } from '../archetypes/android.js';
import { isGradleFramework } from '../archetypes/androidgradle.js';
import { wireFlutterFlavors, writeFlavorIconConfig, flutterFlavorTargets, flavorDecision, planFlutterFlavors, } from '../archetypes/flavors.js';
import { writeFlutterValidateFiles } from '../archetypes/mobilevalidate.js';
import { wireAndroidReleaseSigning, appBuildFile, ownReleaseSigning } from '../archetypes/androidsigning.js';
import { writeSiteFiles, SITE_GLOBAL_SECRETS } from '../archetypes/site.js';
import { webWiringSteps, WEB_GLOBAL_SECRETS } from '../archetypes/web.js';
import { bumpXcodeVersion, bumpXcodegenVersion, bumpPubspecVersion, isSemver } from '../version.js';
import { matchDomain, zoneForDomain, plannedRecords } from '../domains.js';
import { nonLaunchpadWorkflows } from '../consolidation.js';
import { hostSupport } from '../platform.js';
import { scorecard, renderScorecard } from '../scorecard.js';
import { confirm, unconfirm } from '../confirmations.js';
import { readProgress, recordProgress, progressLine } from '../progress.js';
import { applyHomeOverride, localOverridePath } from '../home.js';
import { blockingPipeline, dispositionRefusal } from '../disposition.js';
import { detectEcosystem, article } from '../ecosystem.js';
import { surfaceSentence } from '../platforms.js';
import { addProject, removeProject, fleet, renderFleet, readRegistry } from '../registry.js';
import { readBacklog, addIdea, readInbox, removeFromInbox, summarize, nextTask, BACKLOG_DIR } from '../nightshift/backlog.js';
import { readConfig, writeConfig, defaultConfig, readiness } from '../nightshift/config.js';
import { groom } from '../nightshift/groom.js';
import { readGroomMemory, writeGroomMemory, recordRefusal, clearAttempt } from '../nightshift/groomstate.js';
import { makeHost } from '../nightshift/host.js';
import { installPlan, sleepAdvice } from '../nightshift/schedule.js';
import { requiredSecrets, requiredVaultKeys, vaultKeyFor, SECRET_CATALOGUE, PER_APP_SECRETS, } from '../secrets.js';
import { serve } from '../dashboard/server.js';
import { dashboardData } from '../dashboard/data.js';
import { renderNeeds } from '../needs.js';
import { findProjectRoot, looksLikeProject, tildify, remoteHosts, branchNames } from './project.js';
import { renderHelp, suggest } from './help.js';
import { runnable } from '../invocation.js';
import { missingConfig } from './config-check.js';
import { activate, deactivate, revalidate, refreshIfStale, readLicense, writeLicense, clearLicense, entitlement, isEntitled, refusal, realFetcher, providerLabel, humanReason, licenceWord, LICENSED_VERBS, } from '../license.js';
import { CHECKOUT_URL, SUPPORT_URL, PRICE, UPDATE_POLICY } from '../product.js';
import { provenance, provenanceNote, renderVersion } from '../provenance.js';
import { checkForUpdate, renderUpdate, realFetcher as updateFetcher } from '../update.js';
import { report } from '../report.js';
/**
 * How the verbs an agent reads (doctor, secrets) spell a command: the form
 * every skill uses. The human-facing lists (`needs`, the dashboard's cards)
 * print the machine's real path instead — see `invocation.ts`.
 */
const SKILL_CLI = 'node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js"';
/** Where this invocation is pointed. Set once, before any verb runs. */
let PROJECT;
/**
 * Read the project's state, refusing — loudly — when it exists and is broken.
 *
 * `readState` folds "absent" and "unparseable" into one `null`, and every verb
 * used to take that at its word: `score` graded a fresh detection as if nothing
 * had been set up, and `setup` wrote a brand-new file straight over the broken
 * one — discarding whatever per-surface settings had been gathered into it,
 * without a word. The dashboard has known the difference since it learned to
 * say "cannot be read"; the terminal now says the same thing and stops.
 */
function loadState(repo) {
    const r = readStateOrError(repo);
    if (r.error)
        stateUnreadable(r.error);
    return r.state;
}
function stateUnreadable(error) {
    console.error(`launchpad: .launchpad/state.yml cannot be read — ${error.replace(/:\s*$/, '')}.`);
    console.error('  It holds what launchpad learned about this project and any settings gathered for it,');
    console.error('  so nothing was overwritten. Fix that line, or put the last good copy back:');
    console.error('    git checkout -- .launchpad/state.yml');
    console.error('  Deleting it and running /launchpad:onboard again also works, but loses those settings.');
    process.exit(1);
}
/**
 * What is true about where this was run that the user needs to hear once.
 *
 * Neither is an error. A project with no git yet is a real project; one run
 * from a subdirectory is the whole repository. Both used to be silent, and the
 * second wrote workflows GitHub would never run.
 */
function projectNotes(repo) {
    const out = [];
    if (PROJECT?.cwd && PROJECT.cwd !== resolve(repo)) {
        out.push(`  (You ran this from ${tildify(PROJECT.cwd)}; launchpad works on the whole repository, ${tildify(repo)}.)`);
    }
    if (!existsSync(join(repo, '.git')) && !PROJECT?.gitRoot) {
        out.push('  ! Not a git repository yet. Everything launchpad wires runs on GitHub Actions, which needs one:');
        out.push('      git init && git add -A && git commit -m "first commit"');
        out.push('      gh repo create --source . --private --push');
        out.push('    The scorecard applies either way.');
    }
    else {
        const hosts = remoteHosts(repo);
        if (hosts.length && !hosts.some(isGitHub)) {
            out.push(`  ! This repository's remote is on ${hosts.join(', ')}. Every pipeline launchpad writes is a GitHub`);
            out.push('    Actions workflow, so it runs once the repository is on GitHub too (a mirror is enough).');
            out.push('    The scorecard and the dashboard work either way.');
        }
    }
    return out;
}
const isGitHub = (h) => h === 'github.com' || h.endsWith('.github.com') || h.startsWith('github.');
/**
 * The support bundle. Free, and it has to be: the moment someone needs this is
 * the moment the product is already failing them, and a paywall on the
 * diagnostic would turn a bad hour into a refund.
 */
function cmdReport(repo, outArg) {
    const text = report({ repo, prov });
    if (!outArg) {
        console.log(text);
        return;
    }
    const dest = resolve(outArg);
    /**
     * The moment someone runs `report --out` is the moment something is already
     * wrong, and a stack trace from `writeFileSync` there was the product
     * failing twice. A path that cannot be written is said plainly, and the
     * report still reaches them: printed, so it can be copied instead.
     */
    try {
        writeFileSync(dest, text, 'utf8');
    }
    catch (e) {
        const err = e;
        const why = err.code === 'ENOENT' ? 'that folder does not exist'
            : err.code === 'EACCES' || err.code === 'EPERM' ? 'you do not have permission to write there'
                : err.code === 'EISDIR' ? 'that is a folder, not a file name'
                    : err.code === 'EROFS' ? 'that disk is read-only'
                        : (err.message ?? String(e)).split('\n')[0];
        console.error(`launchpad: could not write ${tildify(dest)} — ${why}.`);
        console.error('  Here is the report instead; copy it from here, or pass --out= a path you can write to.\n');
        console.log(text);
        process.exitCode = 1;
        return;
    }
    console.log(`launchpad: wrote ${tildify(dest)}`);
    console.log('  Credentials are named, never valued. Paths are shortened to ~. Read it before you paste it.');
}
function cmdDetect(repo) {
    console.log(JSON.stringify(detect(repo), null, 2));
}
function cmdSetup(repo) {
    const det = detect(repo);
    const prev = loadState(repo);
    const state = mergeState(prev, det, basename(repo));
    // Every surface deploys from the repository's own trunk unless its settings
    // say otherwise — never from a guessed `main`.
    const trunk = isRepo(repo) ? defaultBranchWithSource(repo) : null;
    if (trunk)
        fillDefaultBranch(state.surfaces, trunk.branch);
    writeState(repo, state);
    // The sync contract is only written when there is actually a backlog to keep
    // in sync — a block describing a task system this repo does not have would be
    // the same drift problem in the other direction.
    const nsCfg = readConfig(repo);
    upsertClaudeMd(repo, state, nsCfg
        ? { backlogDir: nsCfg.backlogDir ?? BACKLOG_DIR, gate: nsCfg.gate || '(no gate set)', protectedPaths: nsCfg.protectedPaths }
        : undefined);
    writeDeploymentDoc(repo, state);
    console.log(`launchpad: detected ${state.surfaces.length} surface(s), ${state.pipelines.length} existing pipeline(s).`);
    for (const s of state.surfaces) {
        console.log(`  - ${s.id} (${s.archetype}${s.framework ? `, ${s.framework}` : ''}) [${s.confidence}] — ${s.evidence.join('; ')}`);
        // CI still builds every surface — only local development is host-limited.
        const host = hostSupport(s.archetype);
        if (!host.local)
            console.log(`      ! not buildable on this machine: ${host.note}`);
        for (const step of host.macOnlySetup)
            console.log(`      ! needs a Mac once: ${step}`);
    }
    for (const p of state.pipelines) {
        // The disposition is load-bearing now, so it is shown rather than left in
        // a file: `leave-alone` means `apply` will skip whatever surface it owns.
        console.log(`  ~ existing: ${p.kind} (${p.path})${p.disposition ? ` [${p.disposition}]` : ''}`);
    }
    /**
     * What was considered and refused.
     *
     * A Flutter monorepo used to lose ten of its twelve packages without a word,
     * and a Tauri app's frontend became a Vercel deployment because nothing
     * connected it to the desktop binary. Both decisions are defensible; being
     * silent about them is not, because the reader cannot tell a decision from a
     * blind spot — and "and N directories I could not read" never appeared
     * anywhere.
     */
    for (const s of det.skipped ?? []) {
        console.log(`  · skipped ${s.path} (${s.what}) — ${s.why}`);
    }
    if (trunk && state.surfaces.length) {
        const how = { remote: 'what origin says', current: 'the branch checked out', mainline: 'the mainline branch here', only: 'the only branch here', guess: 'a guess — no branch exists yet' }[trunk.source];
        console.log(`  Default branch: \`${trunk.branch}\` (${how}). Surfaces deploy from it unless their settings name another.`);
    }
    console.log('Wrote .launchpad/state.yml, .launchpad/DEPLOYMENT.md, and updated CLAUDE.md.');
    /**
     * On the fleet from the moment it is set up.
     *
     * `needs` and the dashboard read the registry, and nothing in onboarding
     * ever put the project there — so the last step of `/launchpad:onboard`,
     * "read `needs`", answered "Nothing needs you" about a project with eleven
     * things waiting. Registering holds a path and nothing else; it is idempotent
     * and removing it loses nothing.
     */
    const known = readRegistry().projects.some(p => p.path === resolve(repo));
    try {
        addProject(repo);
        if (!known)
            console.log('Added to Mission Control — /launchpad:dashboard shows it beside everything else.');
    }
    catch { /* an unwritable home must not fail the setup that already happened */ }
    for (const line of projectNotes(repo))
        console.log(line);
    /**
     * The dead end, made honest.
     *
     * A Python API or a Go CLI genuinely has no surface launchpad ships a
     * pipeline for, and the old message said "detected 0 surface(s)" and then
     * cheerfully told you to run `apply` — which would do nothing. For someone
     * who just paid, that is indistinguishable from the product being broken.
     *
     * It is also not true that there is nothing here. Most of the scorecard is
     * archetype-agnostic, and the whole roadmap and overnight worker are. Saying
     * which half works is worth far more than pretending the other half might.
     */
    if (!state.surfaces.length) {
        const st = readState(repo);
        const applicable = st ? scorecard(repo, st).applicable : 0;
        const eco = detectEcosystem(repo);
        console.log('');
        /**
         * Name it. "No build surface" was honest but said nothing about the repo,
         * and a tool that cannot say what it is looking at has no standing to
         * explain what is missing from it — which is why Rails and Rust used to
         * produce identical output.
         */
        if (eco) {
            console.log(`  This is ${article(eco.name)} ${eco.name} (${eco.evidence}).`);
            console.log('');
            if (eco.ships === 'desktop') {
                console.log('  That IS a desktop app, and launchpad has no pipeline for it: its macOS lane is');
                console.log('  Xcode-based, and yours is packaged by its own toolchain. What still applies is the');
                console.log('  part that catches people out — signing, notarization and an updater — and those');
                console.log('  are checked below rather than assumed.');
            }
            else {
                console.log(`  launchpad ships pipelines for ${surfaceSentence()} —`);
                console.log(`  and ${article(eco.name)} ${eco.name} is none of those, so there is nothing for`);
                console.log('  `apply` to write. That is a real limit, not a detection failure.');
            }
        }
        else {
            console.log(`  No build surface here. launchpad ships pipelines for ${surfaceSentence()}`);
            console.log('  — this repo is none of those, so there is nothing for `apply` to write.');
            console.log('  That is a real limit, not a detection failure.');
        }
        console.log('');
        console.log('  What still works, and is most of the value:');
        // Slash commands, not `launchpad <verb>`: there is no launchpad on anybody's
        // PATH, and an instruction the reader cannot type is worse than none.
        console.log(`    /launchpad:status      ${applicable} checks apply here, in the terms of this project`);
        console.log('    /launchpad:nightshift  the overnight worker runs on any repo with a gate command');
        console.log('    /launchpad:dashboard   this project on the same screen as the rest');
        console.log('');
        console.log('  If you think a surface WAS missed, `detect` shows exactly what was looked for.');
        return;
    }
    console.log('Next: /launchpad:setup gathers the few settings each surface needs (its name, its branch),');
    console.log('then `apply` writes the pipelines. /launchpad:onboard does both, and asks before anything costs money.');
}
/**
 * What launchpad thinks this repo is.
 *
 * Falls back to live detection rather than dead-ending on "not set up". A
 * one-line refusal that names another command is the shape of first contact
 * nobody recovers from — and it made the README's promise that a first look
 * changes nothing false, because the only way past it was a command that writes.
 */
function cmdStatus(repo) {
    const st = loadState(repo);
    if (!st) {
        const detected = mergeState(null, detect(repo), basename(repo));
        console.log(JSON.stringify({ ...detected, setUp: false }, null, 2));
        return;
    }
    console.log(JSON.stringify({ ...st, setUp: true }, null, 2));
}
/**
 * Inside a wired repo, check exactly the credentials THIS project needs.
 * Outside one, walk the whole catalogue grouped by what needs it. The old
 * version checked a hardcoded six regardless, so it happily reported all-✓ on
 * a machine that could not notarize a Mac app or build an Android release —
 * the single worst failure mode for a command whose entire job is telling you
 * what is missing.
 */
function cmdDoctor(repo) {
    const backend = detectBackend(process.platform);
    const v = makeVault(undefined, { backend });
    // A broken state file must not cost the diagnostic its whole answer: doctor
    // says so and falls back to the full catalogue rather than refusing.
    const read = readStateOrError(repo);
    const st = read.state;
    console.log(`launchpad doctor — credential vault: ${backendLabel(backend)}`);
    if (read.error) {
        console.log(`  ! .launchpad/state.yml cannot be read (${read.error.replace(/:\s*$/, '')}), so this is the full list,`);
        console.log('    not this project\'s. `launchpad status` says how to recover the file.');
    }
    /**
     * Why this vault, and whether it can be opened — both stated as facts.
     *
     * It used to print "this platform has no usable OS keychain" whenever the
     * backend was a file, which on a Mac with `LAUNCHPAD_VAULT_BACKEND=file` is
     * false twice: the platform has one, and the user chose not to use it. And
     * "set LAUNCHPAD_VAULT_PASSPHRASE to unlock" was printed with the passphrase
     * already set.
     */
    if (backend === 'dpapi' || backend === 'file') {
        const pinned = Boolean(process.env[VAULT_BACKEND_ENV]?.trim());
        console.log(pinned
            ? `  (chosen with ${VAULT_BACKEND_ENV}=${process.env[VAULT_BACKEND_ENV].trim()})`
            : '  (this machine has no OS keychain launchpad can use, so credentials go in an encrypted file)');
        if (!process.env.LAUNCHPAD_VAULT_PASSPHRASE) {
            console.log('  ! LAUNCHPAD_VAULT_PASSPHRASE is not set, so the vault cannot be opened — everything below reads');
            console.log('    as missing until it is. Set it to a long random string you keep in your password manager.');
        }
    }
    if (st) {
        const keys = requiredVaultKeys(st);
        const surfaces = st.surfaces.map(s => `${s.id} (${s.archetype})`).join(', ') || 'none detected';
        console.log(`  scope: ${st.project} — ${surfaces}\n`);
        if (!keys.length)
            console.log('  no credentials required for this project.');
        for (const k of keys)
            console.log(`  ${v.has(k) ? '✓' : '✗ MISSING'}  ${k}`);
        const { perApp } = requiredSecrets(st);
        if (perApp.length) {
            console.log(`\n  per-app (stored as <app-slug>_<name>, set during that surface's wiring):`);
            for (const s of perApp)
                console.log(`      ${s}`);
        }
        const missing = keys.filter(k => !v.has(k));
        if (missing.length) {
            // The old line said "run /launchpad:doctor to store them" — to someone
            // who was, as often as not, reading it inside /launchpad:doctor.
            console.log(`\n  ${missing.length} missing. Store each one from a terminal — the value is typed or piped, never shown:`);
            for (const k of missing.slice(0, 3))
                console.log(`    ${SKILL_CLI} secret set ${k}`);
            if (missing.length > 3)
                console.log(`    … and the same for the other ${missing.length - 3}. \`launchpad needs\` says where to get each one.`);
            console.log('  Then `launchpad secrets` pushes them into this repository\'s GitHub secrets.');
        }
        else if (keys.length) {
            console.log('\n  All stored. `launchpad secrets` pushes them into this repository\'s GitHub secrets.');
        }
        printVaultContract(backend, keys[0]);
        return;
    }
    console.log('  scope: no .launchpad/state.yml here — showing everything launchpad knows.');
    console.log('  Run this inside a set-up repo to check only what that project needs.\n');
    for (const group of SECRET_CATALOGUE) {
        console.log(`  ${group.label}`);
        for (const name of group.secrets) {
            const k = vaultKeyFor(name);
            console.log(`    ${v.has(k) ? '✓' : '·'}  ${k}`);
        }
    }
    console.log(`\n  ✓ = in the vault, · = absent (only needed if you ship that surface).`);
    console.log(`  Per-app, set during wiring: ${PER_APP_SECRETS.join(', ')}`);
    printVaultContract(backend, vaultKeyFor(SECRET_CATALOGUE[0]?.secrets[0] ?? 'cloudflare_token'));
}
/**
 * The vault-access contract, printed wherever credentials are discussed. This
 * is the fix for the failure that recurs on every new project: a session
 * working *inside the target repo* — not this one — hits "I need a token",
 * doesn't know the creds already live in the vault, and reaches for `.env`. A
 * DNS/deploy token in `.env` then syncs into CI and every deploy. Stating the
 * read command, and "never .env", at the exact moment creds come up is what
 * stops that. `exampleKey` makes the command copy-pasteable, not abstract.
 */
function printVaultContract(backend, exampleKey = 'cloudflare_token') {
    console.log(`\n  Credentials live in the vault, never in .env or source.`);
    console.log(`  Read one when a tool needs it (works in $( … )): ${vaultReadCommand(exampleKey, backend)}`);
}
/**
 * The scorecard, with or without setup.
 *
 * This used to refuse until `setup` had run — which meant the one free verb
 * that IS the argument for buying could not be seen until launchpad had written
 * files into the buyer's repository. Exactly the wrong order: a stranger has to
 * be allowed to look before they are asked to let anything be written, and
 * "run this other command first" is where a first look ends.
 *
 * So with no state, detect on the fly and score that. Nothing is written, and
 * the output says so.
 */
function cmdScore(repo, json = false) {
    const st = loadState(repo);
    const ephemeral = st ?? mergeState(null, detect(repo), basename(repo));
    const card = scorecard(repo, ephemeral);
    const obs = { remaining: card.remaining, passed: card.passed, unconfirmed: card.unconfirmed };
    // Read the history BEFORE recording, or the comparison is always against now.
    const line = progressLine(readProgress(repo), obs);
    if (json) {
        // The same object the dashboard renders, so an agent never has to parse prose.
        console.log(JSON.stringify({ ...card, setUp: Boolean(st), progress: line }, null, 2));
        recordProgress(repo, obs);
        return;
    }
    console.log(renderScorecard(card));
    // Momentum, where there is any. `~/.launchpad`, never the repo — `score` has
    // to stay a command a stranger can run without anything being written to
    // their project.
    if (line)
        console.log(`\n  ${line}`);
    recordProgress(repo, obs);
    if (!st) {
        console.log('');
        console.log('  (Nothing was written to this repo. `/launchpad:setup` records what was detected');
        console.log('   so the dashboard and the overnight worker can use it.)');
    }
    const notes = projectNotes(repo);
    if (notes.length)
        console.log(['', ...notes].join('\n'));
}
function cmdProjects(json = false) {
    const rows = fleet();
    if (json) {
        console.log(JSON.stringify(rows.map(r => ({
            path: r.path, name: r.name, dir: r.dir, problem: r.problem, problemKind: r.problemKind,
            archetypes: r.archetypes, wired: r.wired, surfaces: r.surfaces,
            remaining: r.score?.remaining, passed: r.score?.passed, unconfirmed: r.score?.unconfirmed,
        })), null, 2));
        return;
    }
    console.log(renderFleet(rows));
}
/**
 * Answer one of the questions launchpad cannot answer for itself.
 *
 * Free, deliberately. It is the counterpart to a `?`, and putting the ability to
 * clear a permanent critical warning behind a paywall would be indefensible.
 */
function cmdConfirm(repo, id, note, undo) {
    const st = loadState(repo) ?? mergeState(null, detect(repo), basename(repo));
    const card = scorecard(repo, st);
    const answerable = card.checks.filter(c => c.answerable || c.confirmedAt);
    if (!id) {
        console.log('launchpad: which one? These are the questions only you can answer:');
        for (const c of answerable) {
            console.log(`  ${c.confirmedAt ? '✓' : '?'} ${c.id.padEnd(18)} ${c.title}`
                + (c.confirmedAt ? `   (you confirmed this ${c.confirmedAt})` : ''));
        }
        if (!answerable.length)
            console.log('  (none right now — nothing is waiting on you)');
        console.log('');
        console.log('  launchpad confirm <id> ["where the backup lives, or any note"]');
        console.log('  launchpad confirm <id> --undo');
        return;
    }
    const target = card.checks.find(c => c.id === id);
    if (!target) {
        console.error(`launchpad: no check called \`${id}\`. Run \`launchpad confirm\` to list them.`);
        process.exit(1);
        return;
    }
    if (undo) {
        unconfirm(repo, id);
        console.log(`launchpad: ${id} is back to unanswered.`);
        return;
    }
    /**
     * The rule that keeps this from being a self-certification loophole: only a
     * `?` can be answered. A gap is something launchpad actually observed, and
     * letting anyone assert it away would rebuild the false-pass problem the
     * scorecard exists to prevent — with the user's own hand on the lever.
     */
    if (!target.answerable && !target.confirmedAt) {
        console.error(`launchpad: \`${id}\` is not yours to confirm — launchpad can see this one, and it says:`);
        console.error(`  ${target.grade === 'ok' ? 'already done.' : target.detail}`);
        process.exit(1);
        return;
    }
    confirm(repo, id, note);
    console.log(`launchpad: noted — ${target.title.toLowerCase()}.`);
    console.log('  Recorded in .launchpad/confirmed.yml, as your answer rather than as a verified fact.');
    console.log('  It will not be asked again unless you remove it.');
}
function cmdAdd(repo, arg) {
    const target = arg ? findProjectRoot(resolve(arg)).root : repo;
    if (arg && !existsSync(resolve(arg))) {
        console.error(`launchpad: there is nothing at ${tildify(resolve(arg))}.`);
        process.exit(1);
        return;
    }
    const read = readStateOrError(target);
    if (read.error) {
        console.error(`launchpad: ${tildify(target)}/.launchpad/state.yml cannot be read — ${read.error}`);
        console.error('  Fix that line first; adding it now would put a row on the dashboard that can only say so.');
        process.exit(1);
        return;
    }
    if (!read.state) {
        console.error(`launchpad: ${tildify(target)} is not set up yet — run /launchpad:onboard there first.`);
        process.exit(1);
        return;
    }
    addProject(target);
    console.log(`launchpad: added ${tildify(target)}. /launchpad:dashboard shows it beside everything else.`);
}
function cmdRemove(repo, arg) {
    const target = arg ? resolve(arg) : repo;
    removeProject(target);
    console.log(`launchpad: took ${tildify(target)} off Mission Control (the repo itself is untouched).`);
}
function cmdNightshift(repo, sub, rest) {
    if (sub === 'idea') {
        const text = rest.join(' ').trim();
        if (!text) {
            console.error('launchpad: nightshift idea "<what to build>"');
            process.exit(1);
            return;
        }
        addIdea(repo, text);
        console.log(`launchpad: added to the inbox (${readInbox(repo).length} pending). It is triaged at the next grooming.`);
        return;
    }
    if (sub === 'init') {
        if (readConfig(repo)) {
            console.log('launchpad: nightshift is already set up here.');
            return;
        }
        writeConfig(repo, defaultConfig('', repo));
        console.log('launchpad: wrote .launchpad/nightshift/config.yml — DISABLED, PR mode, no gate yet.');
        console.log('Set a gate command and enable it before it will run. See /launchpad:nightshift.');
        return;
    }
    if (sub === 'groom') {
        const cfg = readConfig(repo) ?? defaultConfig('', repo);
        const host = makeHost({ repo, config: cfg });
        const before = readInbox(repo);
        // `--retry` gives up on giving up: a hand-run groom is someone deciding to
        // look again, which is exactly the case the memory should not veto.
        const retry = rest.includes('--retry');
        let memory = retry ? {} : readGroomMemory(repo);
        const g = groom(host, {
            config: { ...cfg, groom: true },
            tasks: readBacklog(repo, cfg.backlogDir),
            inbox: before,
            memory,
            // A hand-run groom is someone sitting there waiting; the nightly window
            // has nothing to do with it.
            deadline: new Date(Date.now() + 3600_000),
        });
        removeFromInbox(repo, g.captured.map(c => c.source));
        const now = new Date();
        for (const r of g.refused)
            memory = recordRefusal(memory, r.id, r.hash, r.why, now);
        for (const id of g.succeeded)
            memory = clearAttempt(memory, id);
        writeGroomMemory(repo, memory);
        console.log(`launchpad: captured ${g.captured.length} · scoped ${g.scoped.length} · left alone ${g.skipped.length}`);
        for (const s of g.scoped)
            console.log(`  ${s.id}: ${s.from} → ${s.to}`);
        for (const s of g.skipped)
            console.log(`  ! ${s.id}: ${s.why}`);
        if (g.exhausted.length) {
            console.log(`\n  ${g.exhausted.length} task(s) skipped — grooming already gave up on these:`);
            for (const e of g.exhausted)
                console.log(`    ${e.id}: ${e.why}`);
            console.log('  Edit the task to answer the question, or re-run with --retry.');
        }
        return;
    }
    if (sub === 'schedule') {
        const plan = installPlan(process.platform, {
            startHour: 23, startMinute: 0, intervalMinutes: 30,
            node: process.execPath,
            // The plugin's own entry point. This previously pointed at a per-repo
            // path that is never created, so every generated schedule was inert.
            script: fileURLToPath(new URL('../nightshift/cli.js', import.meta.url)),
            logDir: join(repo, '.launchpad', 'nightshift'),
        }, process.env.HOME ?? '~');
        console.log(`launchpad: ${plan.scheduler} — write these files, then run the commands:\n`);
        for (const [path, body] of Object.entries(plan.files))
            console.log(`  ${path}\n${body.split('\n').map(l => '    ' + l).join('\n')}`);
        for (const c of plan.commands)
            console.log(`  $ ${c}`);
        console.log(`\n  Undo: ${plan.uninstall.join(' && ')}`);
        console.log(`\n  ${sleepAdvice(process.platform)}`);
        return;
    }
    if (sub && sub !== 'status') {
        console.error(`launchpad: \`nightshift ${sub}\` is not something nightshift does.`);
        console.error('  nightshift                 is it ready to run tonight, and what is queued');
        console.error('  nightshift init            set it up here (disabled until you give it a gate)');
        console.error('  nightshift idea "<text>"   drop an idea in the inbox');
        console.error('  nightshift groom           shape the inbox into tasks now');
        console.error('  nightshift schedule        the scheduler files to run it overnight');
        process.exit(1);
        return;
    }
    const cfg = readConfig(repo);
    // Honour an adopted backlog: without this a project pointing at its own
    // existing directory reports an empty queue while holding 300 tasks.
    const tasks = readBacklog(repo, cfg?.backlogDir);
    const s = summarize(tasks);
    const r = readiness(cfg);
    console.log(`nightshift — ${basename(repo)}`);
    console.log(`  ${r.ok ? 'ready to run tonight' : 'will NOT run tonight:'}`);
    for (const p of r.problems)
        console.log(`    ! ${p}`);
    if (cfg)
        console.log(`  window ${cfg.window} · mode ${cfg.mode} · gate ${cfg.gate || '(none)'} · max ${cfg.maxTasksPerNight}/night`);
    if (cfg?.backlogDir)
        console.log(`  backlog dir: ${cfg.backlogDir} (adopted)`);
    console.log(`  backlog: ${s.ready} ready · ${s.scoped} scoped · ${s.idea} idea · ${s.in_progress} in progress · ${s.blocked} blocked · ${s.done} done`);
    const next = nextTask(tasks);
    console.log(next ? `  tonight starts with: ${next.id} — ${next.title}` : '  nothing ready — the queue is empty.');
    const inbox = readInbox(repo);
    if (inbox.length)
        console.log(`  inbox: ${inbox.length} un-triaged idea(s)`);
}
/**
 * Mission Control. Local-first by default and by design: no account, no
 * tenancy, no uptime obligation, and no customer's repo data ever leaving
 * their machine.
 */
async function cmdDashboard(args) {
    const portArg = args.find(a => a.startsWith('--port='));
    /**
     * `--demo` serves a fictional fleet instead of the user's own.
     *
     * It exists for one reason: the dashboard is the thing that sells this, and
     * it cannot be photographed against a fleet of neglected repositories. It is
     * never the default, it reads and writes nothing under `~/.launchpad`, and
     * the page it serves says "demo data" in three places — because a screenshot
     * that could be mistaken for somebody's real fleet is exactly the kind of
     * small lie this product does not get to tell.
     */
    const demo = args.includes('--demo');
    const replay = demo && args.includes('--replay');
    const msArg = args.find(a => a.startsWith('--replay-ms='));
    const leadArg = args.find(a => a.startsWith('--replay-lead-ms='));
    const opts = {
        demo, replay,
        ...(msArg ? { replayMs: Number(msArg.slice(12)) } : {}),
        ...(leadArg ? { replayLeadMs: Number(leadArg.slice(17)) } : {}),
    };
    const running = await serve({ port: portArg ? Number(portArg.slice(7)) : 4747, ...opts })
        .catch(async (e) => {
        // Falling back silently to a random port would print a URL that works
        // while something else answers on the one the user expected.
        if (e.code !== 'EADDRINUSE')
            throw e;
        console.log(`launchpad: port in use, taking another one.`);
        return serve({ port: 0, ...opts });
    });
    console.log(`\n  Mission Control  →  ${running.url}\n`);
    if (demo) {
        console.log('  DEMO DATA — a fictional fleet, for screenshots and video.');
        console.log(`  Seven invented apps written to ${running.home.replace(/\/home$/, '')}.`);
        console.log('  Your own projects are untouched; nothing here was read from ~/.launchpad.');
        if (replay) {
            console.log('  Replay: the fleet resolves one check at a time over the live channel.');
            console.log('  --replay-ms= sets the pace; --replay-lead-ms= the still frame before it starts.');
        }
        console.log('');
        /**
         * Ctrl-C is how this is always stopped, and a signal skips `close()` — so
         * the cleanup that lives there never ran and each recording session left
         * another seven-repo fleet in the temp directory. Tidying up on the way
         * out is the least a tool can do with a directory it created.
         */
        for (const sig of ['SIGINT', 'SIGTERM']) {
            process.once(sig, () => { void running.close().finally(() => process.exit(0)); });
        }
    }
    else {
        console.log(`  ${fleet().length} project(s). Ctrl-C to stop.\n`);
    }
    if (!args.includes('--no-open')) {
        const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        spawnSync(opener, [running.url], { stdio: 'ignore', shell: process.platform === 'win32' });
    }
}
/**
 * A file launchpad generated before it stamped its output, whose bytes are not
 * the ones this version renders. It cannot be told apart from a fix made in the
 * field, so nothing was changed — and the way back is one `rm` away.
 */
function reportUnverified(id, paths) {
    console.log(`  ⚠ ${id}: ${paths.join(', ')} was generated by an older launchpad and has no edit stamp — KEPT your version, not overwritten.`);
    console.log('      launchpad cannot tell an older template apart from a fix you made by hand, so it changed nothing.');
    console.log('      To take the current template instead: delete that file and re-run `launchpad apply`.');
}
/**
 * A template variable, back into the config field a person would recognise:
 * `{{PAGES_PROJECT}}` → `pagesProject`. The render error names the variable;
 * the buyer (and the skill) edit the field.
 */
function fieldOf(message) {
    const m = /\{\{(\w+)\}\}/.exec(message);
    if (!m)
        return null;
    return m[1].toLowerCase().replace(/_([a-z0-9])/g, (_x, c) => c.toUpperCase());
}
/**
 * What `apply` can see about where the pipelines will run, said before anyone
 * pushes and waits for a build that cannot happen. Every one of these used to
 * be silent: the workflows were written, `apply` said "wired", and nothing
 * would ever run them.
 */
function whereItRuns(repo, st) {
    const out = [];
    const hosts = remoteHosts(repo);
    if (PROJECT?.gitRoot && resolve(PROJECT.gitRoot) !== resolve(repo)) {
        out.push(`  ⚠ This project lives in a subdirectory of its git repository (${tildify(PROJECT.gitRoot)}).`);
        out.push('      GitHub only runs workflows from .github/ at the top of the repository, so the ones written');
        out.push('      here will never run. Move .launchpad/ to the repository root and run /launchpad:onboard there.');
    }
    if (!existsSync(join(repo, '.git')) && !PROJECT?.gitRoot) {
        out.push('  ⚠ Not a git repository yet, so nothing here can run. `git init`, commit, then');
        out.push('      `gh repo create --source . --private --push` — and every workflow above starts working.');
    }
    else if (!hosts.length) {
        out.push('  ⚠ This repository has no remote yet. The workflows run on GitHub, and `launchpad secrets`');
        out.push('      pushes to a GitHub repository, so create one first: gh repo create --source . --private --push');
    }
    else if (!hosts.some(isGitHub)) {
        out.push(`  ⚠ This repository's remote is on ${hosts.join(', ')}, not GitHub. Every pipeline launchpad writes`);
        out.push(`      is a GitHub Actions workflow, and ${hosts[0]} will not run it. Mirror the repository to GitHub`);
        out.push('      (or move it there) for these to run — launchpad has no pipeline for other CI systems yet.');
    }
    /**
     * A deploy that never fires is indistinguishable from a correct skip
     * (PLAYBOOK §4). A branch launchpad was told to deploy from, which this
     * repository does not have, is exactly that — `main` in a repository whose
     * only branch is `master` or `develop`.
     */
    const branches = branchNames(repo);
    if (branches.length) {
        for (const surf of st.surfaces) {
            if (surf.status !== 'wired' || !surf.config)
                continue;
            const c = surf.config;
            for (const field of ['productionBranch', 'testBranch']) {
                const b = c[field];
                if (typeof b === 'string' && b && !branches.includes(b)) {
                    const have = branches.slice(0, 3).map(x => `\`${x}\``).join(', ');
                    // Two different failures. A test branch that does not exist means the
                    // distribution workflow never triggers; a production branch that does
                    // not exist means every push deploys — as a preview — and production
                    // is never updated.
                    out.push(field === 'testBranch'
                        ? `  ⚠ ${surf.id}: ships a build on pushes to \`${b}\`, but this repository has no \`${b}\` branch (it has ${have}).`
                        : `  ⚠ ${surf.id}: treats \`${b}\` as production, but this repository has no \`${b}\` branch (it has ${have}).`);
                    out.push(field === 'testBranch'
                        ? '      So no build will ever go out.'
                        : '      So every push deploys as a preview, and production never changes.');
                    const trunk = defaultBranchWithSource(repo).branch;
                    out.push(`      Set ${field}: ${branches.includes(trunk) ? trunk : branches.includes('main') ? 'main' : branches[0]} on that surface in .launchpad/state.yml and run apply again.`);
                }
            }
        }
    }
    return out;
}
function cmdApply(repo) {
    const st = loadState(repo);
    if (!st) {
        console.error('launchpad: nothing is set up here yet. /launchpad:onboard does it — it detects what this repo');
        console.error('  ships, asks the few things a pipeline needs, and then runs apply.');
        process.exit(1);
        return;
    }
    let wired = 0;
    let failed = 0;
    // Flutter dev/prod flavours are wired once per app dir — an ios + android
    // surface sharing `apps/mobile` is one Flutter app, not two.
    const flavorTargets = flutterFlavorTargets(repo, st.surfaces);
    const flavoredWorkdirs = new Set();
    // The cheap analyze/test workflow belongs to the Flutter APP, not the surface:
    // ios + android surfaces sharing `apps/mobile` must produce ONE file.
    const validatedWorkdirs = new Set();
    /**
     * A surface whose settings name no branch deploys from the repository's own
     * default branch, and is told so once. Never `main` by assumption: on a
     * `master` or `develop` repository that meant every push deployed as a
     * preview and production never changed.
     */
    const trunk = isRepo(repo) ? defaultBranchWithSource(repo).branch : null;
    if (trunk) {
        for (const f of fillDefaultBranch(st.surfaces, trunk)) {
            const [id, field] = f.split('.');
            console.log(`  · ${id}: ${field} was not set — using \`${trunk}\`, this repository's default branch.`);
        }
    }
    for (const s of st.surfaces) {
        try {
            /**
             * A pipeline the user (or the default) said to leave alone owns this
             * surface. Said before the config check, because "this already ships and I
             * am not touching it" is the useful answer and "no config in state" is not.
             */
            const blocked = blockingPipeline(s, st.pipelines);
            if (blocked) {
                for (const line of dispositionRefusal(s, blocked))
                    console.log(line);
                continue;
            }
            if (!s.config) {
                if (['macos-dmg', 'ios', 'android', 'static-site', 'web-app'].includes(s.archetype)) {
                    console.log(`  · ${s.id}: not wired yet — it needs its settings first (its name, its branch).`);
                    console.log('      /launchpad:setup gathers them into .launchpad/state.yml; then run apply again.');
                }
                continue;
            }
            const absent = missingConfig(s.archetype, s.config);
            if (absent.length) {
                failed++;
                console.log(`  ! ${s.id}: NOT wired — its settings in .launchpad/state.yml are missing ${absent.map(f => `\`${f}\``).join(', ')}.`);
                console.log('      Nothing was written for it. /launchpad:setup fills those in; then run apply again.');
                continue;
            }
            if (s.archetype === 'web-app') {
                const steps = webWiringSteps(s.config);
                console.log(`  ~ ${s.id} (web-app): Vercel native git integration — run these once:`);
                for (const step of steps)
                    console.log(`      ${step}`);
                s.status = 'wired';
                wired++;
                continue;
            }
            let res;
            if (s.archetype === 'macos-dmg') {
                const cfg = s.config;
                res = writeMacosFiles(repo, cfg);
                const auto = wireAutoupdate(repo, cfg);
                if (auto.length)
                    console.log(`  + ${s.id} auto-update: wrote/updated ${auto.join(', ')}`);
                else if (!cfg.publicEdKey && existsSync(join(repo, 'project.yml')))
                    console.log(`  ! ${s.id}: in-app auto-update pending — setup generates the per-app Sparkle key + hooks the app entry point`);
                const dev = wireDevBuild(repo, { scheme: cfg.scheme, appName: cfg.appName, appSourceDir: cfg.appSourceDir });
                if (dev.length)
                    console.log(`  + ${s.id} dev-build: updated ${dev.join(', ')}`);
            }
            else if (s.archetype === 'ios') {
                const cfg = s.config;
                // Refuse rather than emit a pipeline that builds the wrong way. A
                // 'native' Fastfile for a React Native app looks right and fails in CI.
                if (!isWireable(cfg.framework)) {
                    console.log(`  ! ${s.id}: ${cfg.framework} is detected but not yet wireable — launchpad would emit a native pipeline that fails in CI. Skipped.`);
                    continue;
                }
                res = writeIosFiles(repo, cfg);
                const stale = staleExpoFastfile(repo, cfg);
                if (stale) {
                    console.log(`  ⚠ ${s.id}: ${stale} is an older launchpad lane inside ios/, which \`expo prebuild --clean\` deletes`);
                    console.log(`      on every run. The lane now lives in ${iosFastlaneDir(cfg) === '.' ? '' : `${iosFastlaneDir(cfg)}/`}fastlane/Fastfile; delete the old one (launchpad never deletes your files).`);
                }
                if (cfg.framework === 'native') {
                    const scheme = ensureXcodegenScheme(repo, cfg.scheme);
                    if (scheme.length)
                        console.log(`  + ${s.id} scheme: added shared "${cfg.scheme}" scheme to ${scheme.join(', ')}`);
                    const dev = wireDevBuild(repo, { scheme: cfg.scheme, appName: cfg.appName, appSourceDir: cfg.appSourceDir });
                    if (dev.length)
                        console.log(`  + ${s.id} dev-build: updated ${dev.join(', ')}`);
                }
            }
            else if (s.archetype === 'android') {
                // The framework decides which of two pipelines gets written: Flutter's
                // fastlane lane, or the Gradle one. It is also still the gate — nothing
                // reaches it today, and the day detection learns a fourth framework it
                // will, which is why the check stays rather than being deleted with the
                // list it reads.
                const framework = androidFramework(s.config, s);
                if (!androidIsWireable(framework)) {
                    for (const line of androidRefusal(s.id, framework))
                        console.log(line);
                    continue;
                }
                // Resolved once, so the same values reach the workflow and the Gradle
                // edit below. They are answers about the repo — which module is the app,
                // which package manager installs the JS — never questions for the user.
                const cfg = resolveAndroidConfig(repo, { ...s.config, framework });
                res = writeAndroidFiles(repo, cfg);
                if (isGradleFramework(framework)) {
                    console.log(`  ~ ${s.id}: Gradle build in ${cfg.gradleDir}, app module \`${cfg.appModule || 'the root project'}\``
                        + (cfg.packageManager ? `, JS installed with ${cfg.packageManager}` : ''));
                }
                // The workflow materializes the keystore + key.properties; this makes the
                // Gradle release buildType actually USE it instead of the debug keys (or,
                // on a native app, instead of shipping unsigned).
                const ownSigning = ownReleaseSigning(repo, cfg);
                const signing = wireAndroidReleaseSigning(repo, cfg);
                if (signing.length)
                    console.log(`  + ${s.id} release signing: updated ${signing.join(', ')}`);
                if (ownSigning) {
                    console.log(`  ⚠ ${s.id}: ${ownSigning.path} already declares its own release signing config, so`);
                    console.log('      launchpad did not touch it. The workflow still decodes your keystore into');
                    console.log('      `key.properties` — but that only signs anything if YOUR config reads it.');
                    if (ownSigning.verdict === 'declared') {
                        /**
                         * Observed, not predicted. A real React Native repo declares
                         * `signingConfigs { release {} }` with nothing in it and points the
                         * release buildType at it, and a release build spent twenty-six
                         * minutes compiling every native module before dying at
                         * `:app:packageRelease` with `SigningConfig "release" is missing
                         * required property "storeFile"`. That is not an unsigned artifact,
                         * it is a hard failure at the very end of the most expensive step —
                         * and the difference is worth a sentence here rather than a wasted
                         * build.
                         */
                        console.log('      It is EMPTY, so a release build will not merely be unsigned — it will FAIL at');
                        console.log('      `:app:packageRelease` with `SigningConfig "release" is missing required');
                        console.log('      property "storeFile"`, after paying for the whole build.');
                    }
                    console.log('      Point it at key.properties, or delete the config and re-run `apply`.');
                }
                else if (!signing.length && isGradleFramework(framework) && !appBuildFile(repo, cfg)) {
                    /**
                     * Two very different reasons the build file is missing, and telling
                     * them apart is the whole point.
                     *
                     * An Expo project using Continuous Native Generation has no `android/`
                     * in the repository at all — prebuild makes one on the runner and
                     * would overwrite anything written here on the next run. That is
                     * working as designed, and "set appModule" would be nonsense advice.
                     * The consequence is real and has to be said anyway: nothing signs the
                     * release build, so the APK will be unsigned and testers cannot
                     * install it until the signing config arrives through a config plugin,
                     * which is Expo's own mechanism for surviving prebuild.
                     *
                     * Any other framework reaching here means the module genuinely was not
                     * found, and naming where it looked is the useful answer.
                     */
                    if (framework === 'expo' && !existsSync(join(repo, cfg.gradleDir ?? 'android'))) {
                        console.log(`  ⚠ ${s.id}: no \`${cfg.gradleDir}\` in this repo, which is normal for Expo — \`expo prebuild\``);
                        console.log('      generates it on the runner. Nothing was written there, because the next');
                        console.log('      prebuild would overwrite it.');
                        console.log('      The consequence: the release build will be UNSIGNED, and Firebase testers');
                        console.log('      cannot install an unsigned APK. Add an Expo config plugin that sets the');
                        console.log('      release signingConfig (that is the mechanism that survives prebuild), or');
                        console.log('      commit `android/` and re-run `apply` to have launchpad wire it directly.');
                    }
                    else {
                        console.log(`  ! ${s.id}: no build file found for the app module — release signing was NOT wired.`);
                        console.log(`      Looked under ${cfg.gradleDir}. Set \`appModule\` on this surface in .launchpad/state.yml if it lives elsewhere.`);
                    }
                }
            }
            else if (s.archetype === 'static-site')
                res = writeSiteFiles(repo, s.config);
            else
                continue;
            if (s.archetype === 'ios' || s.archetype === 'android') {
                const mv = s.config;
                if (mv.validate && !validatedWorkdirs.has(mv.workdir)) {
                    const val = writeFlutterValidateFiles(repo, mv);
                    // Only claim the workdir once a file actually landed — a native iOS
                    // surface emits nothing, and must not shadow its Flutter sibling.
                    if (val.written.length) {
                        validatedWorkdirs.add(mv.workdir);
                        console.log(`  + ${s.id} validate: wrote ${val.written.map(f => f.path).join(', ')}`);
                    }
                    if (val.edited?.length) {
                        console.log(`  ⚠ ${s.id}: you have edited ${val.edited.join(', ')} — KEPT your version, not overwritten.`);
                        console.log('      If that edit fixes something launchpad gets wrong, please say so:');
                        console.log(`      ${SUPPORT_URL} — a fix in the generator helps every other buyer too.`);
                    }
                    if (val.preserved.length) {
                        console.log(`  ⚠ ${s.id}: PRESERVED your existing ${val.preserved.join(', ')} — launchpad did not overwrite it.`);
                    }
                    if (val.unverified?.length)
                        reportUnverified(s.id, val.unverified);
                }
            }
            const target = flavorTargets.find(t => t.surfaceId === s.id);
            if (target && !flavoredWorkdirs.has(target.config.workdir)) {
                flavoredWorkdirs.add(target.config.workdir);
                /**
                 * Dev/prod flavours edit native files the user wrote — the Xcode project
                 * and schemes, Info.plist, the Podfile, the Android build file and
                 * manifest — so whether to is decided from evidence, written back, and
                 * the files are NAMED before a byte of them changes.
                 */
                const app = st.surfaces.filter(x => target.surfaceIds.includes(x.id));
                const decision = flavorDecision(repo, target.config.workdir, app);
                if (decision.why === 'fresh' || decision.why === 'own-flavors') {
                    for (const x of app)
                        if (x.config)
                            x.config.flavors = decision.wire;
                }
                if (!decision.wire) {
                    if (decision.why === 'own-flavors') {
                        console.log(`  · ${s.id}: this app already has flavours of its own (${decision.evidence[0]}${decision.evidence.length > 1 ? `; +${decision.evidence.length - 1} more` : ''}),`);
                        console.log('      so launchpad did not add dev/prod ones — recorded as `flavors: false`. Set `flavor:` to the one');
                        console.log('      CI should build; `flavors: true` on the surface wires launchpad\'s anyway.');
                    }
                }
                else {
                    const plan = planFlutterFlavors(repo, target.config);
                    if (plan.length) {
                        const verb = (p) => (existsSync(join(repo, p)) ? 'edit' : 'add');
                        console.log(`  ~ ${s.id} flavors: wiring dev/prod flavours (\`flavors: false\` on the surface turns this off). About to change:`);
                        for (const p of plan)
                            console.log(`      ${verb(p)} ${p}`);
                    }
                    const changed = [
                        ...wireFlutterFlavors(repo, target.config),
                        ...writeFlavorIconConfig(repo, target.config),
                    ];
                    if (changed.length)
                        console.log(`  + ${s.id} flavors: updated ${changed.join(', ')}`);
                }
            }
            s.status = 'wired';
            wired++;
            if (res.written.length)
                console.log(`  + ${s.id} (${s.archetype}): wrote ${res.written.map(f => f.path).join(', ')}`);
            if (res.edited?.length) {
                console.log(`  ⚠ ${s.id}: you have edited ${res.edited.join(', ')} — KEPT your version, not overwritten.`);
                console.log('      If that edit fixes something launchpad gets wrong, please say so:');
                console.log(`      ${SUPPORT_URL} — a fix in the generator helps every other buyer too.`);
            }
            if (res.preserved.length) {
                console.log(`  ⚠ ${s.id}: PRESERVED your existing ${res.preserved.join(', ')} — launchpad did not overwrite it.`);
                console.log(`      A local script may depend on it (e.g. \`./hb deploy\` calling a hand-written lane). Migrate it deliberately, then re-run apply.`);
            }
            if (res.unverified?.length)
                reportUnverified(s.id, res.unverified);
        }
        catch (e) {
            /**
             * One surface's incomplete settings must not take down the rest, and must
             * not be written as a file named `launchpad-undefined-site.yml` either —
             * which is what an absent `appName` used to produce, reported as wired.
             */
            // A filesystem refusal is the machine's, not this surface's: let the
            // top-level handler say "permission denied" and stop.
            if (e.code)
                throw e;
            const msg = (e.message ?? String(e)).replace(/^\w+: /, '');
            const field = fieldOf(msg);
            failed++;
            /**
             * A generator refusing its config — `match signing requires matchGitUrl` —
             * is a missing setting, not a crash. It used to escape as a stack trace
             * (later: "a bug in launchpad") and abort the whole run, so the Android
             * surface beside a half-configured iOS one was never wired either.
             */
            console.log(field
                ? `  ! ${s.id}: NOT wired — its settings in .launchpad/state.yml are missing \`${field}\`.`
                : `  ! ${s.id}: NOT wired — ${msg}.`);
            console.log('      Nothing was written for it. /launchpad:setup fills that in; then run apply again.');
        }
    }
    writeState(repo, st);
    upsertClaudeMd(repo, st);
    writeDeploymentDoc(repo, st);
    console.log(`launchpad apply: wired ${wired} surface(s)${failed ? `, ${failed} could not be` : ''}.`);
    for (const line of whereItRuns(repo, st))
        console.log(line);
    const conflicts = nonLaunchpadWorkflows(st.pipelines);
    if (wired > 0 && conflicts.length) {
        console.log(`  ⚠ consolidation: existing non-launchpad workflow(s) ${conflicts.join(', ')} — if these release on the same trigger they will DOUBLE-RUN. Migrate (remove/disable) them; launchpad never deletes your files.`);
    }
    // The GitHub secrets each wired surface reads — only for what was actually
    // wired. Listing Cloudflare's two after "wired 0 surface(s)" read as a to-do
    // for a pipeline that does not exist yet.
    const kinds = new Set(st.surfaces.filter(s => s.status === 'wired').map(s => s.archetype));
    if (kinds.has('macos-dmg'))
        console.log(`macOS secrets: ${MACOS_GLOBAL_SECRETS.join(', ')} + ${MACOS_PER_APP_SECRETS.join(', ')}`);
    if (kinds.has('ios')) {
        const secrets = new Set();
        for (const s of st.surfaces) {
            if (s.archetype === 'ios' && s.config)
                for (const sec of iosSecrets(s.config))
                    secrets.add(sec);
        }
        // Empty means no iOS surface has a config yet, so which secrets it needs is
        // not known (the signing mode decides). Printing "iOS secrets:" with
        // nothing after it reads as "none required", which is the opposite.
        if (secrets.size)
            console.log(`iOS secrets: ${[...secrets].join(', ')}`);
    }
    if (kinds.has('android'))
        console.log(`Android secrets: ${ANDROID_GLOBAL_SECRETS.join(', ')}`);
    if (kinds.has('static-site'))
        console.log(`Cloudflare Pages secrets: ${SITE_GLOBAL_SECRETS.join(', ')}`);
    if (kinds.has('web-app'))
        console.log(`Vercel secret: ${WEB_GLOBAL_SECRETS.join(', ')}`);
    if (wired > 0)
        console.log('Next: `launchpad secrets` copies these from your vault into the repository\'s GitHub secrets (no hand-typing).');
    if (failed)
        process.exitCode = 1;
}
function cmdRelease(repo, version, pbxprojRel, tagPrefix) {
    if (!isSemver(version)) {
        console.error(`launchpad: version must be semver (got "${version}")`);
        process.exit(1);
        return;
    }
    const pbx = join(repo, pbxprojRel);
    if (!existsSync(pbx)) {
        console.error(`launchpad: ${pbxprojRel} not found`);
        process.exit(1);
        return;
    }
    const original = readFileSync(pbx, 'utf8');
    // pubspec.yaml is ALSO yaml, so the extension alone cannot discriminate —
    // the filename does. A Flutter app bumped as if it were an xcodegen
    // project.yml would come out with no version change at all.
    const isPubspec = basename(pbxprojRel) === 'pubspec.yaml';
    const isYaml = pbxprojRel.endsWith('.yml') || pbxprojRel.endsWith('.yaml');
    let bumped;
    try {
        bumped = isPubspec ? bumpPubspecVersion(original, version)
            : isYaml ? bumpXcodegenVersion(original, version)
                : bumpXcodeVersion(original, version);
    }
    catch (e) {
        console.error(`launchpad: ${e.message}`);
        process.exit(1);
        return;
    }
    writeFileSync(pbx, bumped, 'utf8');
    const git = (...args) => execFileSync('git', args, { cwd: repo, stdio: 'inherit' });
    git('add', pbxprojRel);
    git('commit', '-m', `Release ${version}`);
    git('push');
    console.log(`launchpad: bumped ${pbxprojRel} to ${version}, committed, pushed.`);
    console.log('Next: create an annotated tag to trigger CI, e.g.');
    console.log(`  git tag -a ${tagPrefix}${version} -m "<release notes, one per line>" && git push origin ${tagPrefix}${version}`);
}
// Inject each surface's required GitHub secrets from the vault, so a
// new repo is provisioned without hand-typing any secret value. --dry-run shows
// what would be set (and what's missing) without touching the repo.
function cmdSecrets(repo, dryRun) {
    const st = loadState(repo);
    if (!st) {
        console.error('launchpad: nothing is set up here yet, so there is no list of credentials to push.');
        console.error('  /launchpad:onboard first.');
        process.exit(1);
        return;
    }
    const v = makeVault();
    const { global, perApp } = requiredSecrets(st);
    const set = [], missing = [], failed = [];
    for (const name of global) {
        const key = vaultKeyFor(name);
        const val = v.get(key);
        if (val == null) {
            missing.push(`${name} (vault key: ${key})`);
            continue;
        }
        if (dryRun) {
            set.push(name);
            continue;
        }
        try {
            execFileSync('gh', ['secret', 'set', name], { cwd: repo, input: val, stdio: ['pipe', 'ignore', 'pipe'] });
            set.push(name);
        }
        catch (e) {
            failed.push(`${name} (${String(e.message).split('\n')[0]})`);
        }
    }
    console.log(dryRun ? 'launchpad secrets — dry run (nothing written):' : 'launchpad secrets:');
    if (set.length)
        console.log(`  ${dryRun ? 'would set' : '✓ set'} from vault: ${set.join(', ')}`);
    if (failed.length)
        console.log(`  ✗ failed (is gh authed + a repo remote set?): ${failed.join('; ')}`);
    if (missing.length) {
        console.log('  ! not in the vault yet — store each one, then run this again (never as .env, never by hand in GitHub):');
        for (const m of missing)
            console.log(`      ${m}`);
        const first = /vault key: ([\w-]+)/.exec(missing[0])?.[1];
        if (first)
            console.log(`    e.g. ${SKILL_CLI} secret set ${first}`);
    }
    if (perApp.length)
        console.log(`  · per-app (set during the surface's own wiring): ${perApp.join(', ')}`);
    if (!global.length && !perApp.length)
        console.log('  no secrets required for this project.');
}
/**
 * Read one credential from the vault to stdout, backend-agnostic. This is the
 * generic answer to "how does a project-side tool get a credential" — the same
 * on macOS, Linux and the encrypted-file fallback — so a session that needs a
 * token uses `$(launchpad secret cloudflare_token)` instead of pasting it into
 * `.env`. It prints the raw value and nothing else, so command substitution
 * works; that is the same exposure `security … -w` already has, and the reason
 * the value must never be echoed into chat.
 */
function cmdSecret(key) {
    if (!key) {
        console.error('usage: launchpad secret <name>        print one credential (for $( … ) in a script)');
        console.error('       launchpad secret set <name>    store one — typed or piped, never shown');
        process.exit(2);
        return;
    }
    const val = makeVault().get(key);
    if (val == null) {
        console.error(`launchpad: ${key} is not in the vault. Store it with: ${SKILL_CLI} secret set ${key}`);
        console.error('  Credentials live in the vault, never in .env.');
        process.exit(1);
        return;
    }
    process.stdout.write(val);
}
/** Every name the vault is expected to hold, for catching a typo before it is stored. */
function knownVaultKeys() {
    return [...new Set(SECRET_CATALOGUE.flatMap(g => g.secrets.map(n => vaultKeyFor(n))))];
}
/**
 * Read a value without echoing it. Piped input is read whole (a `.p8`, a
 * service-account JSON, a base64 keystore — anything multi-line has to come
 * this way); a terminal gets a prompt that shows nothing as you paste.
 */
async function readSecretValue(key) {
    if (!process.stdin.isTTY) {
        const chunks = [];
        for await (const c of process.stdin)
            chunks.push(c);
        // One trailing newline is the file's, not the credential's.
        return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
    }
    process.stderr.write(`Paste the value for ${key} and press Enter. Nothing will show as you paste.\n`);
    process.stderr.write('(A file — a .p8, a JSON key, a keystore — is better piped: … secret set ' + key + ' < file)\n> ');
    return new Promise((resolveValue, reject) => {
        const stdin = process.stdin;
        let buf = '';
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');
        const done = (v) => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
            process.stderr.write('\n');
            if (v === null)
                reject(Object.assign(new Error('cancelled'), { code: 'CANCELLED' }));
            else
                resolveValue(v);
        };
        const onData = (chunk) => {
            for (const ch of chunk) {
                if (ch === '\r' || ch === '\n')
                    return done(buf);
                if (ch === '\u0003')
                    return done(null); // Ctrl-C
                if (ch === '\u007f' || ch === '\b') {
                    buf = buf.slice(0, -1);
                    continue;
                }
                buf += ch;
            }
        };
        stdin.on('data', onData);
    });
}
/**
 * `launchpad secret set <name>` — the one way a credential goes into the vault.
 *
 * It did not exist. The dashboard's credential cards and `launchpad needs`
 * told people to run `launchpad secret <name>`, which READS; the doctor skill
 * told them `security add-generic-password`, which is macOS-only and puts the
 * value on the command line. On the file vault — every Windows machine, every
 * container — there was no documented way to store anything at all.
 *
 * The value never goes on argv (it would be in `ps` and shell history), is
 * never printed, and an unknown name is refused with a suggestion: a typo
 * stored under the wrong name reads as "missing" forever.
 */
async function cmdSecretSet(key, force) {
    if (!key) {
        console.error('usage: launchpad secret set <name>   (e.g. asc_key_id) — the value is typed or piped, never an argument');
        process.exit(2);
        return;
    }
    const known = knownVaultKeys();
    const perApp = PER_APP_SECRETS.map(n => n.toLowerCase());
    if (!force && !known.includes(key) && !perApp.some(p => key.endsWith(`_${p}`))) {
        const near = suggest(key, known);
        console.error(`launchpad: \`${key}\` is not a credential launchpad uses${near ? ` — did you mean \`${near}\`?` : '.'}`);
        console.error('  A value stored under the wrong name is never read. `launchpad doctor` lists the names;');
        console.error('  add --force if this one is yours on purpose.');
        process.exit(1);
        return;
    }
    let value;
    try {
        value = await readSecretValue(key);
    }
    catch {
        console.error('launchpad: cancelled — nothing was stored.');
        process.exit(130);
        return;
    }
    if (!value.trim()) {
        console.error('launchpad: that was empty — nothing was stored.');
        process.exit(1);
        return;
    }
    const backend = detectBackend(process.platform);
    makeVault(undefined, { backend }).set(key, value);
    console.log(`launchpad: stored ${key} in ${backendLabel(backend)}. The value was not printed.`);
}
async function cfGet(token, path) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
    return res.json();
}
async function cfPost(token, path, payload) {
    const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    return res.json();
}
/**
 * Attach the domain to its Vercel project through the Vercel CLI rather than the
 * REST API on purpose: the CLI resolves team scope and the project link from the
 * repo's own `.vercel/`, which the raw API would make us reconstruct (teamId,
 * projectId) and get wrong for team-owned projects. "already exists" is success,
 * not failure — this command has to be safe to re-run.
 */
function vercelAddDomain(vtok, project, domain, repo) {
    try {
        execFileSync('vercel', ['domains', 'add', domain, project, '--token', vtok], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
        return { ok: true, note: 'attached to Vercel project' };
    }
    catch (e) {
        const msg = String(e.stderr ?? e.message ?? '');
        if (e.code === 'ENOENT')
            return { ok: false, note: 'vercel CLI not found — `npm i -g vercel`, then re-run' };
        if (/already|assigned|exists/i.test(msg))
            return { ok: true, note: 'already on the Vercel project' };
        return { ok: false, note: msg.split('\n').find(Boolean) ?? 'vercel domains add failed' };
    }
}
/**
 * `domains` is advisory by default (list zones, show the match). `--wire` is the
 * executor Gap 1 was missing: attach the domain to Vercel and create the exact
 * DNS records in Cloudflare — the two write steps that used to be manual. It is
 * opt-in and prints the plan first because it changes live DNS; the onboard
 * skill still requires a human tap before invoking it.
 */
async function cmdDomains(repo, opts) {
    const backend = detectBackend(process.platform);
    const token = makeVault().get('cloudflare_token');
    if (!token) {
        console.error('launchpad: cloudflare_token not in the vault — store it with /launchpad:doctor.');
        console.error(`  Credentials live in the launchpad vault, never in .env. Read one with: ${vaultReadCommand('cloudflare_token', backend)}`);
        process.exit(1);
        return;
    }
    const body = await cfGet(token, '/zones?per_page=50');
    if (!body.success) {
        console.error('launchpad: Cloudflare zones lookup failed:', JSON.stringify(body.errors));
        process.exit(1);
        return;
    }
    const zones = body.result ?? [];
    const st = readState(repo);
    const project = st?.project ?? basename(repo);
    const match = matchDomain(project, zones);
    if (!opts.wire) {
        console.log(`launchpad domains — project "${project}", ${zones.length} Cloudflare zone(s):`);
        for (const z of zones)
            console.log(`  - ${z.name} (${z.status})`);
        if (match) {
            console.log(`\nMatch: ${match} -> wire it as the custom domain with:  launchpad domains --wire ${match}`);
            console.log(`(Changes live DNS — confirm with the user first. Preview only until then.)`);
        }
        else {
            console.log(`\nNo match. Use the default deploy domains (<project>.pages.dev / <project>.vercel.app) for now.`);
            console.log(`Buy the domain on Cloudflare, then: launchpad domains --wire <domain>.`);
        }
        return;
    }
    // ── --wire: the executor ──────────────────────────────────────────────────
    const domain = (opts.domain ?? match)?.toLowerCase().replace(/\.$/, '');
    if (!domain) {
        console.error('launchpad: no domain to wire. Pass one: launchpad domains --wire <domain>');
        process.exit(1);
        return;
    }
    const zone = zoneForDomain(domain, zones);
    if (!zone) {
        console.error(`launchpad: ${domain} is not in this Cloudflare account's zones — buy it on Cloudflare (or add the zone) first.`);
        process.exit(1);
        return;
    }
    const web = st?.surfaces.find(s => s.archetype === 'web-app');
    if (!web) {
        console.error('launchpad: no web-app (Vercel) surface in this repo — `domains --wire` binds a Vercel custom domain. Run /launchpad:setup first.');
        process.exit(1);
        return;
    }
    const vtok = makeVault().get('vercel_token');
    if (!vtok) {
        console.error('launchpad: vercel_token not in the vault — store it with /launchpad:doctor.');
        process.exit(1);
        return;
    }
    const vProject = web.config.project;
    const records = plannedRecords(domain, zone);
    console.log(`launchpad domains --wire ${domain}`);
    console.log(`  Vercel project: ${vProject}   Cloudflare zone: ${zone.name}`);
    console.log(`  DNS records to create (DNS-only, never proxied):`);
    for (const r of records)
        console.log(`    ${r.type.padEnd(5)} ${r.name}  ->  ${r.content}`);
    // 1) Attach the domain to the Vercel project.
    const v = vercelAddDomain(vtok, vProject, domain, repo);
    console.log(`  Vercel: ${v.ok ? '✓' : '✗'} ${v.note}`);
    if (!v.ok) {
        process.exit(1);
        return;
    }
    // 2) Create each record in Cloudflare, idempotently — skip a match, never
    //    clobber a conflicting one (that would be someone else's record).
    let failures = 0;
    for (const r of records) {
        const listed = await cfGet(token, `/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`);
        const existing = (listed.result ?? [])[0];
        if (existing) {
            if (existing.content === r.content && existing.proxied === false) {
                console.log(`  Cloudflare: ✓ ${r.type} ${r.name} already correct`);
            }
            else {
                console.log(`  Cloudflare: ! ${r.type} ${r.name} exists as -> ${existing.content}${existing.proxied ? ' (proxied)' : ''}; left as-is. Fix it in the dashboard if this is stale.`);
                failures++;
            }
            continue;
        }
        const created = await cfPost(token, `/zones/${zone.id}/dns_records`, { type: r.type, name: r.name, content: r.content, proxied: false, ttl: 1 });
        if (created.success) {
            console.log(`  Cloudflare: ✓ created ${r.type} ${r.name} -> ${r.content}`);
        }
        else {
            console.log(`  Cloudflare: ✗ ${r.type} ${r.name} — ${JSON.stringify(created.errors)}`);
            failures++;
        }
    }
    console.log(`\n  Next: cert + verification can take a few minutes. Check with:`);
    console.log(`    vercel domains inspect ${domain} --token "$(${vaultReadCommand('vercel_token', backend)})"`);
    console.log(`    curl -sI https://${domain} | head -1`);
    if (failures)
        process.exit(1);
}
/**
 * The licence server is asked with a deadline.
 *
 * Neither `activate` nor `license` had one: against a server that accepts the
 * connection and never answers, both sat there for as long as the socket
 * lived, which to a buyer is a hang on the one command they run straight
 * after paying. Fifteen seconds for the act of binding a seat, eight for a
 * status check that decides nothing — entitlement never waits on this answer.
 */
const withDeadline = (ms) => (url, init) => realFetcher(url, { ...init, signal: init.signal ?? AbortSignal.timeout(ms) });
/** Keys are long and dash-separated; subcommands are short words. */
const looksLikeKey = (s) => Boolean(s && s.length >= 12 && !/\s/.test(s) && /[0-9]/.test(s));
const last4 = (key) => `…${key.slice(-4)}`;
async function cmdLicense(sub, key) {
    const rec = readLicense();
    /**
     * `license <key>` activates.
     *
     * The refusal tells a buyer to "activate the key you were sent", and
     * `license <key>` is what anybody who has used another licensed tool types.
     * It used to print "no licence on this machine" and throw the key away — the
     * buyer's very first paid act, answered with a false statement about the
     * thing they had just typed.
     */
    if (sub && sub !== 'activate' && sub !== 'deactivate' && sub !== 'status') {
        if (!looksLikeKey(sub)) {
            console.error(`launchpad: \`license ${sub}\` is not something license does.`);
            console.error('  license               what is on this machine');
            console.error('  license <key>         activate the key from your receipt email');
            console.error('  license deactivate    release this machine, so the key can move to another');
            process.exit(1);
            return;
        }
        key = sub;
        sub = 'activate';
    }
    if (sub === 'activate') {
        if (!key) {
            console.error('launchpad: which key? Paste the one from your receipt email: license <key>');
            process.exit(1);
            return;
        }
        const trimmed = key.trim();
        /**
         * Activating the same key twice on one machine used to take a second
         * seat — Lemon Squeezy counts every activate call as a new machine — so a
         * buyer unsure it had worked, or re-running onboarding, burned through five
         * activations on one laptop. Ask first whether this machine already holds it.
         */
        if (rec?.key === trimmed && rec.instanceId) {
            const { record, reachable } = await revalidate(rec, withDeadline(8_000));
            if (!reachable || record.lastError !== 'revoked') {
                writeLicense(record);
                console.log(`launchpad: that key (${last4(trimmed)}) is already active on this machine — nothing to do.`);
                console.log('  (Activating it again would have used a second of its seats.)');
                return;
            }
        }
        const r = await activate(trimmed, withDeadline(15_000));
        if (!r.ok) {
            console.error(`launchpad: ${r.message}`);
            process.exit(1);
            return;
        }
        // A different key was here: give its seat back rather than leave it counted
        // against a machine that no longer uses it. Best effort, and said.
        if (rec?.key && rec.key !== trimmed && rec.instanceId) {
            const d = await deactivate(rec, withDeadline(8_000)).catch(() => ({ ok: false, message: '' }));
            console.log(d.ok
                ? `launchpad: released the key that was here before (${last4(rec.key)}), so its seat is free.`
                : `launchpad: replaced the key that was here (${last4(rec.key)}); its seat on this machine could not be released just now.`);
        }
        writeLicense(r.record);
        console.log(`launchpad: ${r.message} Thank you.`);
        console.log(`  apply, secrets, release and domains now work on this machine (key ${last4(trimmed)}).`);
        console.log('  Next: /launchpad:onboard in the repo you want to ship.');
        return;
    }
    if (sub === 'deactivate') {
        if (!rec) {
            console.log('launchpad: no licence stored on this machine — nothing to release.');
            return;
        }
        const r = await deactivate(rec, withDeadline(15_000));
        if (r.ok) {
            clearLicense();
            console.log(`launchpad: ${r.message}`);
            console.log('  To use launchpad here again: license <key>.');
        }
        else {
            console.error(`launchpad: ${r.message}`);
            process.exitCode = 1;
        }
        return;
    }
    if (!rec) {
        console.log('launchpad: no licence on this machine.');
        console.log(`  Everything that reads your projects works anyway — score, doctor, dashboard.`);
        console.log(`  To wire pipelines: ${CHECKOUT_URL}`);
        console.log(`  ${PRICE}, once — ${UPDATE_POLICY}.`);
        console.log('  Bought one? Paste the key from your receipt email: license <key>');
        return;
    }
    // Refresh on an explicit check; this is the one command where waiting on the
    // network is what the user asked for — up to a point.
    const { record, reachable } = await revalidate(rec, withDeadline(8_000));
    writeLicense(record);
    const e = entitlement(record, new Date());
    const who = providerLabel(record.provider ?? 'lemonsqueezy');
    console.log(`launchpad licence — ${licenceWord(e.state)}`);
    // The last four, as `report` prints it and as the README tells a buyer to
    // quote. Two different truncations of one key read as two keys.
    console.log(`  key:       ${last4(record.key)}`);
    console.log(`  provider:  ${who}`);
    console.log(`  validated: ${record.validatedAt.slice(0, 16).replace('T', ' ')} UTC`);
    if (!reachable) {
        const why = record.lastError?.replace(/^offline: /, '') ?? '';
        console.log(`  note:      could not reach ${who} just now (${humanReason(why)}) — nothing changes, this key keeps working`);
    }
    if (e.state === 'stale') {
        console.log(`  note:      last confirmed ${e.offlineDays} day(s) ago — still fully licensed`);
    }
    if (e.state === 'lapsed') {
        console.log(`  ! ${e.why}`);
        console.log(`  ! If you bought this, that is ours to fix: ${SUPPORT_URL}`);
    }
}
/**
 * The last line of defence against a stack trace.
 *
 * A stack trace is the product admitting it did not anticipate this machine,
 * and the buyer who sees one cannot tell a bug from their own mistake. Every
 * error that escapes a verb lands here and becomes one or two sentences: what
 * could not be done, to which path, and what to do next. A filesystem refusal
 * — a read-only checkout, a full disk, a folder they cannot write — is named
 * as such, because it is theirs to fix; anything else is said to be ours.
 * `LAUNCHPAD_DEBUG=1` prints the trace for whoever is fixing it.
 */
function fail(e) {
    const err = (e ?? {});
    if (process.env.LAUNCHPAD_DEBUG)
        console.error(err.stack ?? err);
    const message = String(err.message ?? e).split('\n')[0];
    const fsWhy = {
        EACCES: 'permission denied', EPERM: 'not permitted', EROFS: 'the disk is read-only',
        ENOSPC: 'the disk is full', EISDIR: 'it is a folder', ENOTDIR: 'part of that path is a file',
        ENOENT: 'it does not exist', EBUSY: 'it is in use',
    };
    if (err.code && fsWhy[err.code]) {
        const what = err.syscall === 'open' || err.syscall === 'write' || err.syscall === 'mkdir' ? 'write' : 'use';
        console.error(`launchpad: could not ${what} ${err.path ? tildify(err.path) : 'a file'} — ${fsWhy[err.code]}.`);
        console.error('  launchpad stopped there, and wrote nothing after that point. Fix the permission (or run it in a');
        console.error('  checkout you can write to) and run the same command again.');
    }
    else if (/^launchpad/.test(message)) {
        // Already a sentence written for a person (the vault's own errors are).
        console.error(String(err.message ?? e));
    }
    else {
        console.error(`launchpad hit something it did not expect: ${message}`);
        console.error('  That is a bug in launchpad, not something you did. `launchpad report` prints a redacted');
        console.error(`  summary that is safe to paste — please send it to ${SUPPORT_URL}`);
        console.error('  (LAUNCHPAD_DEBUG=1 shows the full trace.)');
    }
    process.exit(1);
}
process.on('uncaughtException', fail);
process.on('unhandledRejection', fail);
const argv = process.argv.slice(2);
let cmd = argv[0];
// Resolve where launchpad's own state lives, once, before any verb runs. A
// no-op unless LAUNCHPAD_HOME is set; when it is, this also points $HOME /
// %USERPROFILE% at it so the modules still defaulting to `os.homedir()` agree
// rather than splitting one machine's state across two directories. See home.ts.
applyHomeOverride();
/**
 * Help, version and typos — before anything else, and exit 0 when asked for.
 *
 * `--help` used to be answered with the same one-line usage string as a typo,
 * with exit 1, and `--version` was a typo too.
 */
if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    console.log(renderHelp(PRICE));
    process.exit(cmd ? 0 : 1);
}
if (cmd === '--version' || cmd === '-v' || cmd === '-V')
    cmd = 'version';
// Provenance is announced before anything runs. A source checkout doing real
// work is fine; a source checkout doing real work SILENTLY is how "it works on
// my machine" gets mistaken for "it works".
const prov = provenance();
if (!prov.isProduct && !['version', 'license', 'update'].includes(cmd ?? '')) {
    const note = provenanceNote(prov);
    if (note)
        console.error(note);
}
/**
 * A `.launchpad/local.json` that does not parse is ignored by design — a stray
 * comma must not break every command — but ignoring it SILENTLY sent
 * launchpad's state to the real home directory of someone who had written that
 * file precisely to keep it elsewhere. So it is still ignored, and said.
 */
{
    const lp = localOverridePath();
    if (lp) {
        try {
            JSON.parse(readFileSync(lp, 'utf8'));
        }
        catch (e) {
            console.error(`launchpad: ${tildify(lp)} is not valid JSON (${String(e.message).split('\n')[0]}) —`);
            console.error('  ignoring it, so its "home" and "vaultBackend" settings are NOT in effect for this command.');
        }
    }
}
/**
 * Which project this is about. Verbs that act on a project are refused outside
 * one, rather than writing `.launchpad/` into a home directory or scoring an
 * empty folder as if it were an app.
 */
const PROJECT_VERBS = ['detect', 'setup', 'status', 'apply', 'score', 'confirm', 'secrets', 'release', 'domains', 'nightshift'];
PROJECT = findProjectRoot();
const repo = PROJECT.root;
const needsProject = PROJECT_VERBS.includes(cmd) || (['add', 'remove'].includes(cmd) && !argv[1]);
if (needsProject && PROJECT.via === 'cwd' && !looksLikeProject(repo)) {
    console.error(`launchpad: ${tildify(repo)} is not a project.`);
    console.error('  There is no git repository here or above it, and nothing launchpad recognises — no');
    console.error('  package.json, pubspec.yaml, Xcode project or index.html. Nothing was written.');
    console.error('  cd into the app you want to ship and run it there. /launchpad:dashboard lists what you have added.');
    process.exit(1);
}
// The gate. Reading your own projects is always free; doing the work is not.
if (LICENSED_VERBS.includes(cmd ?? '')) {
    // Opportunistic and silent: at most once a day, at most two seconds, and a
    // failure of any kind leaves entitlement exactly as it was. This is the only
    // thing that keeps a stored key current, so it belongs here rather than in
    // the one command a customer runs when they already suspect a problem.
    await refreshIfStale();
    const rec = readLicense();
    const e = entitlement(rec, new Date());
    if (!isEntitled(e)) {
        console.error(refusal(cmd, e, CHECKOUT_URL, SUPPORT_URL, providerLabel(rec?.provider ?? 'lemonsqueezy'), PRICE));
        process.exit(2);
    }
}
// A vault backend pinned by hand is validated ONCE, here, so a typo is one
// clear line rather than a stack trace from wherever the vault is first
// touched. An unknown value is an error and never a silent fall back to the OS
// default — that would reach for the very store the user asked launchpad to
// leave alone.
try {
    requestedBackend();
}
catch (e) {
    console.error(e.message);
    process.exit(1);
}
/**
 * Ctrl-C never leaves a file half-written.
 *
 * Every verb that writes does so synchronously, and a signal handler cannot
 * run until synchronous work returns — so with one installed, an interrupt
 * lets the write in progress (the whole `apply`, a few hundred milliseconds)
 * finish, and then exits. Without it, the default action could kill the
 * process between `open(O_TRUNC)` and `write()` and leave a user's own
 * CLAUDE.md empty. The dashboard has its own handlers and is left alone.
 */
if (cmd !== 'dashboard') {
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.once(sig, () => {
            console.error('\nlaunchpad: interrupted — the write in progress was finished first, so nothing is half-written.');
            process.exit(130);
        });
    }
}
const has = (flag) => argv.includes(flag);
switch (cmd) {
    case 'detect':
        cmdDetect(repo);
        break;
    case 'setup':
        cmdSetup(repo);
        break;
    case 'status':
        cmdStatus(repo);
        break;
    case 'doctor':
        cmdDoctor(repo);
        break;
    case 'apply':
        cmdApply(repo);
        break;
    case 'score':
        cmdScore(repo, has('--json'));
        break;
    case 'projects':
        cmdProjects(has('--json'));
        break;
    /**
     * `needs` — everything across the fleet that is waiting on a person.
     *
     * Free, like every verb that only reads your own projects. It is deliberately
     * fleet-wide rather than repo-scoped: a credential six projects want is ONE
     * thing to do, and a per-repo version would print it six times and teach
     * people that the list is noise. The onboard skill reads this at the end of
     * an interview instead of composing its own list of questions, so the CLI,
     * the dashboard strip and the agent can never disagree about what is left.
     */
    case 'needs': {
        const d = dashboardData();
        const result = { items: d.needs, ledger: d.ledger };
        if (has('--json')) {
            console.log(JSON.stringify(result, null, 2));
            break;
        }
        /**
         * An empty list is only good news if something was looked at. With no
         * project added it used to say "Every credential launchpad requires is in
         * your vault" — about a fleet of zero, to someone who had just onboarded a
         * project that was never added to it.
         */
        if (!d.projects.length) {
            console.log('No projects added yet, so there is nothing to check.');
            console.log('  Run /launchpad:onboard in the repo you want to ship — it adds the project, and this list');
            console.log('  fills in with what it needs from you.');
            break;
        }
        const here = resolve(repo);
        const inHere = existsSync(join(here, '.launchpad', 'state.yml'))
            && !d.projects.some((p) => resolve(p.path) === here);
        process.stdout.write(renderNeeds(result, { runnable }));
        if (inHere) {
            console.log(`  (This project, ${tildify(here)}, is not on the list yet — \`launchpad add\` puts it there.)`);
        }
        break;
    }
    case 'confirm':
        cmdConfirm(repo, argv[1], argv.slice(2).filter(a => a !== '--undo').join(' ') || undefined, has('--undo'));
        break;
    case 'dashboard':
        cmdDashboard(argv.slice(1)).catch(fail);
        break;
    case 'version':
        console.log(renderVersion(prov));
        break;
    case 'report':
        cmdReport(repo, argv.slice(1).find(a => a.startsWith('--out='))?.slice(6));
        break;
    case 'update':
        checkForUpdate(prov.version, updateFetcher)
            .then(c => console.log(renderUpdate(c)))
            .catch(() => console.log('launchpad: could not check for updates — nothing is wrong with your install.'));
        break;
    case 'license':
        cmdLicense(argv[1], argv[2]).catch(fail);
        break;
    case 'nightshift':
        cmdNightshift(repo, argv[1], argv.slice(2));
        break;
    case 'add':
        cmdAdd(repo, argv[1]);
        break;
    case 'remove':
        cmdRemove(repo, argv[1]);
        break;
    case 'secrets':
        cmdSecrets(repo, has('--dry-run'));
        break;
    case 'secret':
        if (argv[1] === 'set')
            cmdSecretSet(argv[2], has('--force')).catch(fail);
        else
            cmdSecret(argv[1]);
        break;
    case 'release': {
        if (!argv[1] || !argv[2]) {
            console.error('usage: launchpad release <version> <project-file> [tag-prefix]');
            console.error('  e.g. launchpad release 1.2.0 pubspec.yaml   (or project.yml, or the .pbxproj)');
            console.error('  It bumps the version in that file, commits and pushes; the tag you push next ships it.');
            process.exit(1);
        }
        cmdRelease(repo, argv[1], argv[2], argv[3] ?? 'v');
        break;
    }
    case 'domains': {
        const wire = has('--wire');
        const domain = argv.slice(1).find(a => !a.startsWith('--'));
        cmdDomains(repo, { wire, domain }).catch(fail);
        break;
    }
    default: {
        const near = suggest(cmd);
        console.error(`launchpad: \`${cmd}\` is not a command${near ? ` — did you mean \`${near}\`?` : '.'}`);
        console.error('  `launchpad --help` lists them. In Claude Code, /launchpad:onboard is where to start.');
        process.exit(1);
    }
}
