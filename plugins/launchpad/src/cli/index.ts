#!/usr/bin/env node
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { detect } from '../detect.js';
import { readState, writeState, mergeState } from '../state.js';
import { upsertClaudeMd, writeDeploymentDoc } from '../context.js';
import { makeVault, detectBackend, requestedBackend, backendLabel, vaultReadCommand, type VaultBackend } from '../vault.js';
import { writeMacosFiles, MACOS_GLOBAL_SECRETS, MACOS_PER_APP_SECRETS, type MacosConfig } from '../archetypes/macos.js';
import { wireAutoupdate } from '../archetypes/autoupdate.js';
import { wireDevBuild, ensureXcodegenScheme } from '../archetypes/devbuild.js';
import { writeIosFiles, iosSecrets, isWireable, type IosConfig } from '../archetypes/ios.js';
import {
  writeAndroidFiles, ANDROID_GLOBAL_SECRETS, androidFramework, androidIsWireable, androidRefusal,
  type AndroidConfig,
} from '../archetypes/android.js';
import { wireFlutterFlavors, writeFlavorIconConfig, flutterFlavorTargets } from '../archetypes/flavors.js';
import { writeFlutterValidateFiles, type MobileValidateConfig } from '../archetypes/mobilevalidate.js';
import { wireAndroidReleaseSigning } from '../archetypes/androidsigning.js';
import { writeSiteFiles, SITE_GLOBAL_SECRETS, type SiteConfig } from '../archetypes/site.js';
import { webWiringSteps, WEB_GLOBAL_SECRETS, type WebConfig } from '../archetypes/web.js';
import { bumpXcodeVersion, bumpXcodegenVersion, bumpPubspecVersion, isSemver } from '../version.js';
import { matchDomain, zoneForDomain, plannedRecords, type Zone } from '../domains.js';
import { nonLaunchpadWorkflows } from '../consolidation.js';
import { hostSupport } from '../platform.js';
import { scorecard, renderScorecard } from '../scorecard.js';
import { confirm, unconfirm } from '../confirmations.js';
import { readProgress, recordProgress, progressLine } from '../progress.js';
import { applyHomeOverride } from '../home.js';
import { blockingPipeline, dispositionRefusal } from '../disposition.js';
import { detectEcosystem, article } from '../ecosystem.js';
import { surfaceSentence } from '../platforms.js';
import { addProject, removeProject, fleet, renderFleet } from '../registry.js';
import { readBacklog, addIdea, readInbox, removeFromInbox, summarize, nextTask, BACKLOG_DIR } from '../nightshift/backlog.js';
import { readConfig, writeConfig, defaultConfig, readiness } from '../nightshift/config.js';
import { groom } from '../nightshift/groom.js';
import { readGroomMemory, writeGroomMemory, recordRefusal, clearAttempt } from '../nightshift/groomstate.js';
import { makeHost } from '../nightshift/host.js';
import { installPlan, sleepAdvice, DEFAULT_LABEL } from '../nightshift/schedule.js';
import {
  requiredSecrets, requiredVaultKeys, vaultKeyFor, SECRET_CATALOGUE, PER_APP_SECRETS,
} from '../secrets.js';
import { serve } from '../dashboard/server.js';
import {
  activate, deactivate, revalidate, refreshIfStale, readLicense, writeLicense, clearLicense,
  entitlement, isEntitled, refusal, realFetcher, providerLabel, LICENSED_VERBS,
} from '../license.js';
import { CHECKOUT_URL, SUPPORT_URL, PRICE, UPDATE_POLICY } from '../product.js';
import { provenance, provenanceNote, renderVersion } from '../provenance.js';
import { checkForUpdate, renderUpdate, realFetcher as updateFetcher } from '../update.js';
import { report } from '../report.js';
import type { WriteResult } from '../generated.js';

/**
 * The support bundle. Free, and it has to be: the moment someone needs this is
 * the moment the product is already failing them, and a paywall on the
 * diagnostic would turn a bad hour into a refund.
 */
function cmdReport(repo: string, outArg: string | undefined): void {
  const text = report({ repo, prov });
  if (!outArg) { console.log(text); return; }
  const dest = resolve(outArg);
  writeFileSync(dest, text, 'utf8');
  console.log(`launchpad: wrote ${dest}`);
  console.log('  Credentials are named, never valued. Paths are shortened to ~. Read it before you paste it.');
}

function cmdDetect(repo: string): void {
  console.log(JSON.stringify(detect(repo), null, 2));
}

function cmdSetup(repo: string): void {
  const det = detect(repo);
  const prev = readState(repo);
  const state = mergeState(prev, det, basename(repo));
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
    if (!host.local) console.log(`      ! not buildable on this machine: ${host.note}`);
    for (const step of host.macOnlySetup) console.log(`      ! needs a Mac once: ${step}`);
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
  console.log('Wrote .launchpad/state.yml, .launchpad/DEPLOYMENT.md, and updated CLAUDE.md.');

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
      } else {
        console.log(`  launchpad ships pipelines for ${surfaceSentence()} —`);
        console.log(`  and ${article(eco.name)} ${eco.name} is none of those, so there is nothing for`);
        console.log('  `apply` to write. That is a real limit, not a detection failure.');
      }
    } else {
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

  console.log('Next: the skill gathers each surface\'s config, then `launchpad apply` writes the pipelines.');
}

/**
 * What launchpad thinks this repo is.
 *
 * Falls back to live detection rather than dead-ending on "not set up". A
 * one-line refusal that names another command is the shape of first contact
 * nobody recovers from — and it made the README's promise that a first look
 * changes nothing false, because the only way past it was a command that writes.
 */
function cmdStatus(repo: string): void {
  const st = readState(repo);
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
function cmdDoctor(repo: string): void {
  const backend = detectBackend(process.platform);
  const v = makeVault(undefined, { backend });
  const st = readState(repo);
  console.log(`launchpad doctor — credential vault: ${backendLabel(backend)}`);
  if (backend === 'dpapi' || backend === 'file') {
    console.log('  (this platform has no usable OS keychain — set LAUNCHPAD_VAULT_PASSPHRASE to unlock)');
  }

  if (st) {
    const keys = requiredVaultKeys(st);
    const surfaces = st.surfaces.map(s => `${s.id} (${s.archetype})`).join(', ') || 'none detected';
    console.log(`  scope: ${st.project} — ${surfaces}\n`);
    if (!keys.length) console.log('  no credentials required for this project.');
    for (const k of keys) console.log(`  ${v.has(k) ? '✓' : '✗ MISSING'}  ${k}`);
    const { perApp } = requiredSecrets(st);
    if (perApp.length) {
      console.log(`\n  per-app (stored as <app-slug>_<name>, set during that surface's wiring):`);
      for (const s of perApp) console.log(`      ${s}`);
    }
    const missing = keys.filter(k => !v.has(k));
    if (missing.length) console.log(`\n  ${missing.length} missing — run /launchpad:doctor to store them, then \`launchpad secrets\`.`);
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
function printVaultContract(backend: VaultBackend, exampleKey = 'cloudflare_token'): void {
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
function cmdScore(repo: string): void {
  const st = readState(repo);
  const ephemeral = st ?? mergeState(null, detect(repo), basename(repo));
  const card = scorecard(repo, ephemeral);
  const obs = { remaining: card.remaining, passed: card.passed, unconfirmed: card.unconfirmed };
  // Read the history BEFORE recording, or the comparison is always against now.
  const line = progressLine(readProgress(repo), obs);
  console.log(renderScorecard(card));
  // Momentum, where there is any. `~/.launchpad`, never the repo — `score` has
  // to stay a command a stranger can run without anything being written to
  // their project.
  if (line) console.log(`\n  ${line}`);
  recordProgress(repo, obs);
  if (!st) {
    console.log('');
    console.log('  (Nothing was written to this repo. `/launchpad:setup` records what was detected');
    console.log('   so the dashboard and the overnight worker can use it.)');
  }
}

function cmdProjects(): void {
  console.log(renderFleet(fleet()));
}

/**
 * Answer one of the questions launchpad cannot answer for itself.
 *
 * Free, deliberately. It is the counterpart to a `?`, and putting the ability to
 * clear a permanent critical warning behind a paywall would be indefensible.
 */
function cmdConfirm(repo: string, id: string | undefined, note: string | undefined, undo: boolean): void {
  const st = readState(repo) ?? mergeState(null, detect(repo), basename(repo));
  const card = scorecard(repo, st);
  const answerable = card.checks.filter(c => c.answerable || c.confirmedAt);
  if (!id) {
    console.log('launchpad: which one? These are the questions only you can answer:');
    for (const c of answerable) {
      console.log(`  ${c.confirmedAt ? '✓' : '?'} ${c.id.padEnd(18)} ${c.title}`
        + (c.confirmedAt ? `   (you confirmed this ${c.confirmedAt})` : ''));
    }
    if (!answerable.length) console.log('  (none right now — nothing is waiting on you)');
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

function cmdAdd(repo: string, arg: string | undefined): void {
  const target = arg ? resolve(arg) : repo;
  if (!readState(target)) {
    console.error(`launchpad: ${target} is not set up — run /launchpad:onboard there first.`);
    process.exit(1); return;
  }
  addProject(target);
  console.log(`launchpad: registered ${target}. See everything with \`launchpad projects\`.`);
}

function cmdRemove(repo: string, arg: string | undefined): void {
  const target = arg ? resolve(arg) : repo;
  removeProject(target);
  console.log(`launchpad: unregistered ${target} (the repo itself is untouched).`);
}

function cmdNightshift(repo: string, sub: string | undefined, rest: string[]): void {
  if (sub === 'idea') {
    const text = rest.join(' ').trim();
    if (!text) { console.error('launchpad: nightshift idea "<what to build>"'); process.exit(1); return; }
    addIdea(repo, text);
    console.log(`launchpad: added to the inbox (${readInbox(repo).length} pending). It is triaged at the next grooming.`);
    return;
  }
  if (sub === 'init') {
    if (readConfig(repo)) { console.log('launchpad: nightshift is already set up here.'); return; }
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
    for (const r of g.refused) memory = recordRefusal(memory, r.id, r.hash, r.why, now);
    for (const id of g.succeeded) memory = clearAttempt(memory, id);
    writeGroomMemory(repo, memory);
    console.log(`launchpad: captured ${g.captured.length} · scoped ${g.scoped.length} · left alone ${g.skipped.length}`);
    for (const s of g.scoped) console.log(`  ${s.id}: ${s.from} → ${s.to}`);
    for (const s of g.skipped) console.log(`  ! ${s.id}: ${s.why}`);
    if (g.exhausted.length) {
      console.log(`\n  ${g.exhausted.length} task(s) skipped — grooming already gave up on these:`);
      for (const e of g.exhausted) console.log(`    ${e.id}: ${e.why}`);
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
    for (const [path, body] of Object.entries(plan.files)) console.log(`  ${path}\n${body.split('\n').map(l => '    ' + l).join('\n')}`);
    for (const c of plan.commands) console.log(`  $ ${c}`);
    console.log(`\n  Undo: ${plan.uninstall.join(' && ')}`);
    console.log(`\n  ${sleepAdvice(process.platform)}`);
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
  for (const p of r.problems) console.log(`    ! ${p}`);
  if (cfg) console.log(`  window ${cfg.window} · mode ${cfg.mode} · gate ${cfg.gate || '(none)'} · max ${cfg.maxTasksPerNight}/night`);
  if (cfg?.backlogDir) console.log(`  backlog dir: ${cfg.backlogDir} (adopted)`);
  console.log(`  backlog: ${s.ready} ready · ${s.scoped} scoped · ${s.idea} idea · ${s.in_progress} in progress · ${s.blocked} blocked · ${s.done} done`);
  const next = nextTask(tasks);
  console.log(next ? `  tonight starts with: ${next.id} — ${next.title}` : '  nothing ready — the queue is empty.');
  const inbox = readInbox(repo);
  if (inbox.length) console.log(`  inbox: ${inbox.length} un-triaged idea(s)`);
}

/**
 * Mission Control. Local-first by default and by design: no account, no
 * tenancy, no uptime obligation, and no customer's repo data ever leaving
 * their machine.
 */
async function cmdDashboard(args: string[]): Promise<void> {
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
    .catch(async (e: NodeJS.ErrnoException) => {
      // Falling back silently to a random port would print a URL that works
      // while something else answers on the one the user expected.
      if (e.code !== 'EADDRINUSE') throw e;
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
    for (const sig of ['SIGINT', 'SIGTERM'] as const) {
      process.once(sig, () => { void running.close().finally(() => process.exit(0)); });
    }
  } else {
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
function reportUnverified(id: string, paths: string[]): void {
  console.log(`  ⚠ ${id}: ${paths.join(', ')} was generated by an older launchpad and has no edit stamp — KEPT your version, not overwritten.`);
  console.log('      launchpad cannot tell an older template apart from a fix you made by hand, so it changed nothing.');
  console.log('      To take the current template instead: delete that file and re-run `launchpad apply`.');
}

function cmdApply(repo: string): void {
  const st = readState(repo);
  if (!st) { console.error('launchpad: run setup first'); process.exit(1); return; }
  let wired = 0;
  // Flutter dev/prod flavours are wired once per app dir — an ios + android
  // surface sharing `apps/mobile` is one Flutter app, not two.
  const flavorTargets = flutterFlavorTargets(repo, st.surfaces);
  const flavoredWorkdirs = new Set<string>();
  // The cheap analyze/test workflow belongs to the Flutter APP, not the surface:
  // ios + android surfaces sharing `apps/mobile` must produce ONE file.
  const validatedWorkdirs = new Set<string>();
  for (const s of st.surfaces) {
    /**
     * A pipeline the user (or the default) said to leave alone owns this
     * surface. Said before the config check, because "this already ships and I
     * am not touching it" is the useful answer and "no config in state" is not.
     */
    const blocked = blockingPipeline(s, st.pipelines);
    if (blocked) {
      for (const line of dispositionRefusal(s, blocked)) console.log(line);
      continue;
    }
    if (!s.config) {
      if (['macos-dmg', 'ios', 'android', 'static-site', 'web-app'].includes(s.archetype)) {
        console.log(`  ! ${s.id}: no config in state (skill must gather it first)`);
      }
      continue;
    }
    if (s.archetype === 'web-app') {
      const steps = webWiringSteps(s.config as WebConfig);
      console.log(`  ~ ${s.id} (web-app): Vercel native git integration — run these once:`);
      for (const step of steps) console.log(`      ${step}`);
      s.status = 'wired';
      wired++;
      continue;
    }
    let res: WriteResult;
    if (s.archetype === 'macos-dmg') {
      const cfg = s.config as MacosConfig;
      res = writeMacosFiles(repo, cfg);
      const auto = wireAutoupdate(repo, cfg);
      if (auto.length) console.log(`  + ${s.id} auto-update: wrote/updated ${auto.join(', ')}`);
      else if (!cfg.publicEdKey && existsSync(join(repo, 'project.yml'))) console.log(`  ! ${s.id}: in-app auto-update pending — setup generates the per-app Sparkle key + hooks the app entry point`);
      const dev = wireDevBuild(repo, { scheme: cfg.scheme, appName: cfg.appName, appSourceDir: cfg.appSourceDir });
      if (dev.length) console.log(`  + ${s.id} dev-build: updated ${dev.join(', ')}`);
    } else if (s.archetype === 'ios') {
      const cfg = s.config as IosConfig;
      // Refuse rather than emit a pipeline that builds the wrong way. A
      // 'native' Fastfile for a React Native app looks right and fails in CI.
      if (!isWireable(cfg.framework)) {
        console.log(`  ! ${s.id}: ${cfg.framework} is detected but not yet wireable — launchpad would emit a native pipeline that fails in CI. Skipped.`);
        continue;
      }
      res = writeIosFiles(repo, cfg);
      if (cfg.framework === 'native') {
        const scheme = ensureXcodegenScheme(repo, cfg.scheme);
        if (scheme.length) console.log(`  + ${s.id} scheme: added shared "${cfg.scheme}" scheme to ${scheme.join(', ')}`);
        const dev = wireDevBuild(repo, { scheme: cfg.scheme, appName: cfg.appName, appSourceDir: cfg.appSourceDir });
        if (dev.length) console.log(`  + ${s.id} dev-build: updated ${dev.join(', ')}`);
      }
    }
    else if (s.archetype === 'android') {
      const cfg = s.config as AndroidConfig;
      // Refuse rather than emit a pipeline that builds the wrong way — the same
      // gate iOS has had. Everything below writes `flutter build apk`.
      const framework = androidFramework(cfg, s);
      if (!androidIsWireable(framework)) {
        for (const line of androidRefusal(s.id, framework)) console.log(line);
        continue;
      }
      res = writeAndroidFiles(repo, cfg);
      // The workflow materializes the keystore + android/key.properties; this
      // makes the Gradle release buildType actually USE it instead of the debug keys.
      const signing = wireAndroidReleaseSigning(repo, cfg);
      if (signing.length) console.log(`  + ${s.id} release signing: updated ${signing.join(', ')}`);
    }
    else if (s.archetype === 'static-site') res = writeSiteFiles(repo, s.config as SiteConfig);
    else continue;
    if (s.archetype === 'ios' || s.archetype === 'android') {
      const mv = s.config as MobileValidateConfig;
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
        if (val.unverified?.length) reportUnverified(s.id, val.unverified);
      }
    }
    const target = flavorTargets.find(t => t.surfaceId === s.id);
    if (target && !flavoredWorkdirs.has(target.config.workdir)) {
      flavoredWorkdirs.add(target.config.workdir);
      const changed = [
        ...wireFlutterFlavors(repo, target.config),
        ...writeFlavorIconConfig(repo, target.config),
      ];
      if (changed.length) console.log(`  + ${s.id} flavors: updated ${changed.join(', ')}`);
    }
    s.status = 'wired';
    wired++;
    if (res.written.length) console.log(`  + ${s.id} (${s.archetype}): wrote ${res.written.map(f => f.path).join(', ')}`);
    if (res.edited?.length) {
      console.log(`  ⚠ ${s.id}: you have edited ${res.edited.join(', ')} — KEPT your version, not overwritten.`);
      console.log('      If that edit fixes something launchpad gets wrong, please say so:');
      console.log(`      ${SUPPORT_URL} — a fix in the generator helps every other buyer too.`);
    }
    if (res.preserved.length) {
      console.log(`  ⚠ ${s.id}: PRESERVED your existing ${res.preserved.join(', ')} — launchpad did not overwrite it.`);
      console.log(`      A local script may depend on it (e.g. \`./hb deploy\` calling a hand-written lane). Migrate it deliberately, then re-run apply.`);
    }
    if (res.unverified?.length) reportUnverified(s.id, res.unverified);
  }
  writeState(repo, st);
  upsertClaudeMd(repo, st);
  writeDeploymentDoc(repo, st);
  console.log(`launchpad apply: wired ${wired} surface(s).`);
  const conflicts = nonLaunchpadWorkflows(st.pipelines);
  if (wired > 0 && conflicts.length) {
    console.log(`  ⚠ consolidation: existing non-launchpad workflow(s) ${conflicts.join(', ')} — if these release on the same trigger they will DOUBLE-RUN. Migrate (remove/disable) them; launchpad never deletes your files.`);
  }
  const kinds = new Set(st.surfaces.map(s => s.archetype));
  if (kinds.has('macos-dmg')) console.log(`macOS secrets: ${MACOS_GLOBAL_SECRETS.join(', ')} + ${MACOS_PER_APP_SECRETS.join(', ')}`);
  if (kinds.has('ios')) {
    const secrets = new Set<string>();
    for (const s of st.surfaces) {
      if (s.archetype === 'ios' && s.config) for (const sec of iosSecrets(s.config as IosConfig)) secrets.add(sec);
    }
    console.log(`iOS secrets: ${[...secrets].join(', ')}`);
  }
  if (kinds.has('android')) console.log(`Android secrets: ${ANDROID_GLOBAL_SECRETS.join(', ')}`);
  if (kinds.has('static-site')) console.log(`Cloudflare Pages secrets: ${SITE_GLOBAL_SECRETS.join(', ')}`);
  if (kinds.has('web-app')) console.log(`Vercel secret: ${WEB_GLOBAL_SECRETS.join(', ')}`);
  if (wired > 0) console.log('Next: `launchpad secrets` injects these into the repo from your Keychain vault (no hand-typing).');
}

function cmdRelease(repo: string, version: string, pbxprojRel: string, tagPrefix: string): void {
  if (!isSemver(version)) { console.error(`launchpad: version must be semver (got "${version}")`); process.exit(1); return; }
  const pbx = join(repo, pbxprojRel);
  if (!existsSync(pbx)) { console.error(`launchpad: ${pbxprojRel} not found`); process.exit(1); return; }
  const original = readFileSync(pbx, 'utf8');
  // pubspec.yaml is ALSO yaml, so the extension alone cannot discriminate —
  // the filename does. A Flutter app bumped as if it were an xcodegen
  // project.yml would come out with no version change at all.
  const isPubspec = basename(pbxprojRel) === 'pubspec.yaml';
  const isYaml = pbxprojRel.endsWith('.yml') || pbxprojRel.endsWith('.yaml');
  let bumped: string;
  try {
    bumped = isPubspec ? bumpPubspecVersion(original, version)
      : isYaml ? bumpXcodegenVersion(original, version)
      : bumpXcodeVersion(original, version);
  } catch (e) {
    console.error(`launchpad: ${(e as Error).message}`);
    process.exit(1);
    return;
  }
  writeFileSync(pbx, bumped, 'utf8');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'inherit' });
  git('add', pbxprojRel);
  git('commit', '-m', `Release ${version}`);
  git('push');
  console.log(`launchpad: bumped ${pbxprojRel} to ${version}, committed, pushed.`);
  console.log('Next: create an annotated tag to trigger CI, e.g.');
  console.log(`  git tag -a ${tagPrefix}${version} -m "<release notes, one per line>" && git push origin ${tagPrefix}${version}`);
}

// Inject each surface's required GitHub secrets from the Keychain vault, so a
// new repo is provisioned without hand-typing any secret value. --dry-run shows
// what would be set (and what's missing) without touching the repo.
function cmdSecrets(repo: string, dryRun: boolean): void {
  const st = readState(repo);
  if (!st) { console.error('launchpad: run setup first'); process.exit(1); return; }
  const v = makeVault();
  const { global, perApp } = requiredSecrets(st);
  const set: string[] = [], missing: string[] = [], failed: string[] = [];
  for (const name of global) {
    const key = vaultKeyFor(name);
    const val = v.get(key);
    if (val == null) { missing.push(`${name} (vault key: ${key})`); continue; }
    if (dryRun) { set.push(name); continue; }
    try {
      execFileSync('gh', ['secret', 'set', name], { cwd: repo, input: val, stdio: ['pipe', 'ignore', 'pipe'] });
      set.push(name);
    } catch (e) {
      failed.push(`${name} (${String((e as Error).message).split('\n')[0]})`);
    }
  }
  console.log(dryRun ? 'launchpad secrets — dry run (nothing written):' : 'launchpad secrets:');
  if (set.length) console.log(`  ${dryRun ? 'would set' : '✓ set'} from vault: ${set.join(', ')}`);
  if (failed.length) console.log(`  ✗ failed (is gh authed + a repo remote set?): ${failed.join('; ')}`);
  if (missing.length) {
    console.log('  ! not in the vault — store via /launchpad:doctor, then re-run (never hand-set them as .env or GitHub secrets):');
    for (const m of missing) console.log(`      ${m}`);
  }
  if (perApp.length) console.log(`  · per-app (set during the surface's own wiring): ${perApp.join(', ')}`);
  if (!global.length && !perApp.length) console.log('  no secrets required for this project.');
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
function cmdSecret(key: string | undefined): void {
  if (!key) { console.error('usage: launchpad secret <vault-key>   (e.g. cloudflare_token)'); process.exit(2); return; }
  const val = makeVault().get(key);
  if (val == null) {
    console.error(`launchpad: ${key} not in the vault — store it with /launchpad:doctor. Credentials live in the vault, never in .env.`);
    process.exit(1);
    return;
  }
  process.stdout.write(val);
}

/** One existing Cloudflare DNS record, from the list endpoint. */
interface CfRecord { id: string; type: string; name: string; content: string; proxied?: boolean; }

async function cfGet(token: string, path: string): Promise<any> {
  const res = await fetch(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function cfPost(token: string, path: string, payload: unknown): Promise<any> {
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
function vercelAddDomain(vtok: string, project: string, domain: string, repo: string): { ok: boolean; note: string } {
  try {
    execFileSync('vercel', ['domains', 'add', domain, project, '--token', vtok], { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, note: 'attached to Vercel project' };
  } catch (e) {
    const msg = String((e as { stderr?: Buffer }).stderr ?? (e as Error).message ?? '');
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, note: 'vercel CLI not found — `npm i -g vercel`, then re-run' };
    if (/already|assigned|exists/i.test(msg)) return { ok: true, note: 'already on the Vercel project' };
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
async function cmdDomains(repo: string, opts: { wire: boolean; domain?: string }): Promise<void> {
  const backend = detectBackend(process.platform);
  const token = makeVault().get('cloudflare_token');
  if (!token) {
    console.error('launchpad: cloudflare_token not in the vault — store it with /launchpad:doctor.');
    console.error(`  Credentials live in the launchpad vault, never in .env. Read one with: ${vaultReadCommand('cloudflare_token', backend)}`);
    process.exit(1);
    return;
  }
  const body = await cfGet(token, '/zones?per_page=50') as { success: boolean; result?: Zone[]; errors?: unknown };
  if (!body.success) { console.error('launchpad: Cloudflare zones lookup failed:', JSON.stringify(body.errors)); process.exit(1); return; }
  const zones = body.result ?? [];
  const st = readState(repo);
  const project = st?.project ?? basename(repo);
  const match = matchDomain(project, zones);

  if (!opts.wire) {
    console.log(`launchpad domains — project "${project}", ${zones.length} Cloudflare zone(s):`);
    for (const z of zones) console.log(`  - ${z.name} (${z.status})`);
    if (match) {
      console.log(`\nMatch: ${match} -> wire it as the custom domain with:  launchpad domains --wire ${match}`);
      console.log(`(Changes live DNS — confirm with the user first. Preview only until then.)`);
    } else {
      console.log(`\nNo match. Use the default deploy domains (<project>.pages.dev / <project>.vercel.app) for now.`);
      console.log(`Buy the domain on Cloudflare, then: launchpad domains --wire <domain>.`);
    }
    return;
  }

  // ── --wire: the executor ──────────────────────────────────────────────────
  const domain = (opts.domain ?? match)?.toLowerCase().replace(/\.$/, '');
  if (!domain) {
    console.error('launchpad: no domain to wire. Pass one: launchpad domains --wire <domain>');
    process.exit(1); return;
  }
  const zone = zoneForDomain(domain, zones);
  if (!zone) {
    console.error(`launchpad: ${domain} is not in this Cloudflare account's zones — buy it on Cloudflare (or add the zone) first.`);
    process.exit(1); return;
  }
  const web = st?.surfaces.find(s => s.archetype === 'web-app');
  if (!web) {
    console.error('launchpad: no web-app (Vercel) surface in this repo — `domains --wire` binds a Vercel custom domain. Run /launchpad:setup first.');
    process.exit(1); return;
  }
  const vtok = makeVault().get('vercel_token');
  if (!vtok) {
    console.error('launchpad: vercel_token not in the vault — store it with /launchpad:doctor.');
    process.exit(1); return;
  }
  const vProject = (web.config as WebConfig).project;
  const records = plannedRecords(domain, zone);

  console.log(`launchpad domains --wire ${domain}`);
  console.log(`  Vercel project: ${vProject}   Cloudflare zone: ${zone.name}`);
  console.log(`  DNS records to create (DNS-only, never proxied):`);
  for (const r of records) console.log(`    ${r.type.padEnd(5)} ${r.name}  ->  ${r.content}`);

  // 1) Attach the domain to the Vercel project.
  const v = vercelAddDomain(vtok, vProject, domain, repo);
  console.log(`  Vercel: ${v.ok ? '✓' : '✗'} ${v.note}`);
  if (!v.ok) { process.exit(1); return; }

  // 2) Create each record in Cloudflare, idempotently — skip a match, never
  //    clobber a conflicting one (that would be someone else's record).
  let failures = 0;
  for (const r of records) {
    const listed = await cfGet(token, `/zones/${zone.id}/dns_records?type=${r.type}&name=${encodeURIComponent(r.name)}`) as { success: boolean; result?: CfRecord[] };
    const existing = (listed.result ?? [])[0];
    if (existing) {
      if (existing.content === r.content && existing.proxied === false) {
        console.log(`  Cloudflare: ✓ ${r.type} ${r.name} already correct`);
      } else {
        console.log(`  Cloudflare: ! ${r.type} ${r.name} exists as -> ${existing.content}${existing.proxied ? ' (proxied)' : ''}; left as-is. Fix it in the dashboard if this is stale.`);
        failures++;
      }
      continue;
    }
    const created = await cfPost(token, `/zones/${zone.id}/dns_records`, { type: r.type, name: r.name, content: r.content, proxied: false, ttl: 1 }) as { success: boolean; errors?: unknown };
    if (created.success) {
      console.log(`  Cloudflare: ✓ created ${r.type} ${r.name} -> ${r.content}`);
    } else {
      console.log(`  Cloudflare: ✗ ${r.type} ${r.name} — ${JSON.stringify(created.errors)}`);
      failures++;
    }
  }

  console.log(`\n  Next: cert + verification can take a few minutes. Check with:`);
  console.log(`    vercel domains inspect ${domain} --token "$(${vaultReadCommand('vercel_token', backend)})"`);
  console.log(`    curl -sI https://${domain} | head -1`);
  if (failures) process.exit(1);
}

async function cmdLicense(sub: string | undefined, key: string | undefined): Promise<void> {
  const rec = readLicense();
  if (sub === 'activate') {
    if (!key) { console.error('launchpad: license activate <key>'); process.exit(1); return; }
    const r = await activate(key, realFetcher);
    if (!r.ok) { console.error(`launchpad: ${r.message}`); process.exit(1); return; }
    writeLicense(r.record!);
    console.log(`launchpad: ${r.message} Thank you.`);
    return;
  }
  if (sub === 'deactivate') {
    if (!rec) { console.log('launchpad: no licence stored on this machine.'); return; }
    const r = await deactivate(rec, realFetcher);
    if (r.ok) clearLicense();
    console.log(`launchpad: ${r.message}`);
    return;
  }
  if (!rec) {
    console.log('launchpad: no licence on this machine.');
    console.log(`  Everything that reads your projects works anyway — score, doctor, dashboard.`);
    console.log(`  To wire pipelines: ${CHECKOUT_URL}`);
    console.log(`  ${PRICE}, once — ${UPDATE_POLICY}.`);
    return;
  }
  // Refresh on an explicit check; this is the one command where waiting on the
  // network is what the user asked for.
  const { record, reachable } = await revalidate(rec, realFetcher);
  writeLicense(record);
  const e = entitlement(record, new Date());
  const who = providerLabel(record.provider ?? 'lemonsqueezy');
  console.log(`launchpad licence — ${e.state}`);
  console.log(`  key:       ...${record.key.slice(-6)}`);
  console.log(`  provider:  ${who}`);
  console.log(`  validated: ${record.validatedAt.slice(0, 16).replace('T', ' ')}`);
  if (!reachable) {
    console.log(`  note:      could not reach ${who} just now — nothing changes, this key keeps working`);
  }
  if (e.state === 'stale') {
    console.log(`  note:      last confirmed ${e.offlineDays} day(s) ago (${e.why}) — still fully licensed`);
  }
  if (e.state === 'lapsed') {
    console.log(`  ! ${e.why}`);
    console.log(`  ! If you bought this, that is ours to fix: ${SUPPORT_URL}`);
  }
}

const cmd = process.argv[2];
const repo = process.cwd();

// Resolve where launchpad's own state lives, once, before any verb runs. A
// no-op unless LAUNCHPAD_HOME is set; when it is, this also points $HOME /
// %USERPROFILE% at it so the modules still defaulting to `os.homedir()` agree
// rather than splitting one machine's state across two directories. See home.ts.
applyHomeOverride();

// Provenance is announced before anything runs. A source checkout doing real
// work is fine; a source checkout doing real work SILENTLY is how "it works on
// my machine" gets mistaken for "it works".
const prov = provenance();
if (!prov.isProduct && !['version', 'license', 'update'].includes(cmd ?? '')) {
  const note = provenanceNote(prov);
  if (note) console.error(note);
}

// The gate. Reading your own projects is always free; doing the work is not.
if ((LICENSED_VERBS as readonly string[]).includes(cmd ?? '')) {
  // Opportunistic and silent: at most once a day, at most two seconds, and a
  // failure of any kind leaves entitlement exactly as it was. This is the only
  // thing that keeps a stored key current, so it belongs here rather than in
  // the one command a customer runs when they already suspect a problem.
  await refreshIfStale();
  const rec = readLicense();
  const e = entitlement(rec, new Date());
  if (!isEntitled(e)) {
    console.error(refusal(cmd!, e, CHECKOUT_URL, SUPPORT_URL, providerLabel(rec?.provider ?? 'lemonsqueezy'), PRICE));
    process.exit(2);
  }
}
// A vault backend pinned by hand is validated ONCE, here, so a typo is one
// clear line rather than a stack trace from wherever the vault is first
// touched. An unknown value is an error and never a silent fall back to the OS
// default — that would reach for the very store the user asked launchpad to
// leave alone.
try { requestedBackend(); } catch (e) { console.error((e as Error).message); process.exit(1); }
switch (cmd) {
  case 'detect': cmdDetect(repo); break;
  case 'setup': cmdSetup(repo); break;
  case 'status': cmdStatus(repo); break;
  case 'doctor': cmdDoctor(repo); break;
  case 'apply': cmdApply(repo); break;
  case 'score': cmdScore(repo); break;
  case 'projects': cmdProjects(); break;
  case 'confirm':
    cmdConfirm(repo, process.argv[3], process.argv.slice(4).filter(a => a !== '--undo').join(' ') || undefined,
      process.argv.includes('--undo'));
    break;
  case 'dashboard': cmdDashboard(process.argv.slice(3)).catch((e) => { console.error(e); process.exit(1); }); break;
  case 'version': console.log(renderVersion(prov)); break;
  case 'report': cmdReport(repo, process.argv.slice(3).find(a => a.startsWith('--out='))?.slice(6)); break;
  case 'update':
    checkForUpdate(prov.version, updateFetcher)
      .then(c => console.log(renderUpdate(c)))
      .catch(() => console.log('launchpad: could not check for updates.'));
    break;
  case 'license': cmdLicense(process.argv[3], process.argv[4]).catch((e) => { console.error(e); process.exit(1); }); break;
  case 'nightshift': cmdNightshift(repo, process.argv[3], process.argv.slice(4)); break;
  case 'add': cmdAdd(repo, process.argv[3]); break;
  case 'remove': cmdRemove(repo, process.argv[3]); break;
  case 'secrets': cmdSecrets(repo, process.argv.includes('--dry-run')); break;
  case 'secret': cmdSecret(process.argv[3]); break;
  case 'release': cmdRelease(repo, process.argv[3] ?? '', process.argv[4] ?? '', process.argv[5] ?? 'v'); break;
  case 'domains': {
    const wire = process.argv.includes('--wire');
    const domain = process.argv.slice(3).find(a => !a.startsWith('--'));
    cmdDomains(repo, { wire, domain }).catch((e) => { console.error(e); process.exit(1); });
    break;
  }
  default:
    console.error('usage: launchpad <detect|setup|status|doctor|apply|score|confirm|projects|dashboard|add|remove|nightshift|secrets|secret|release|domains|license|report|version|update>');
    process.exit(1);
}
