import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { LaunchpadState } from './types.js';
import { signingMode, iosWorkflowSlug, type IosConfig } from './archetypes/ios.js';

const START = '<!-- launchpad:start -->';
const END = '<!-- launchpad:end -->';

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export type Eol = '\n' | '\r\n';

/**
 * The line ending a file already uses.
 *
 * Git for Windows defaults to `core.autocrlf=true`, so a Windows checkout of
 * any repository has a CRLF working tree. `CLAUDE.md` is the FIRST file every
 * customer watches launchpad touch, and it was written LF-only into those
 * repositories: the buyer's next `git diff` showed changes to their own house
 * rules that they did not make, from a tool they had just installed.
 *
 * Decided by majority rather than by the first match, so one stray ending in
 * an otherwise-uniform file cannot flip the whole convention. A file with no
 * newline at all answers `'\n'` — nothing to preserve, and LF is the default
 * everywhere the choice is free.
 */
export function detectEol(text: string): Eol {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

/** Re-render text (authored with LF) in `eol`, without doubling an existing \r. */
export function toEol(text: string, eol: Eol): string {
  const lf = text.replace(/\r\n/g, '\n');
  return eol === '\n' ? lf : lf.replace(/\n/g, '\r\n');
}

/** A UTF-8 BOM is part of the file, not part of its first line. Notepad writes one. */
const BOM = '﻿';

/**
 * The managed CLAUDE.md block: the contract every Claude session in this repo
 * has to honour.
 *
 * This is load-bearing, not documentation. Mission Control has no database and
 * caches nothing — every number it shows is re-derived from the files below on
 * each read. That is the right design (one copy of the truth, deletable,
 * diffable, travels with the repo) but it has exactly one failure mode: a
 * session that does work and does not write it down. Finish a task without
 * moving its status and the dashboard shows it as still queued, tonight's
 * worker picks it up again, and the roadmap quietly stops matching reality.
 *
 * So the rules are stated where the agent will actually read them, and they are
 * stated as consequences rather than instructions — an agent that knows *why*
 * a file matters will keep it right in situations this text never anticipated.
 *
 * Written from `state` rather than hardcoded, and each section appears only
 * when that capability is actually present, so the block stays true as
 * launchpad grows and never describes a feature this repo does not have.
 */
export function renderBlock(state: LaunchpadState, opts: { nightshift?: NightshiftFacts } = {}): string {
  const surfaces = state.surfaces.map(s => `- **${s.id}** (${s.archetype}) — ${s.status}`);
  const ns = opts.nightshift;

  const lines = [
    START,
    '## Deployment (managed by launchpad)',
    '',
    'This project is launchpad-managed. Ship with `/launchpad:release`.',
    'Full runbook: `.launchpad/DEPLOYMENT.md`. Machine state: `.launchpad/state.yml`.',
    '',
    '**Surfaces:**',
    ...(surfaces.length ? surfaces : ['- (none detected yet)']),
    '',
    '### Credentials — the vault, never `.env`',
    '',
    'Build, signing, deploy and DNS credentials for this project are **not in this repo**',
    'and **not in `.env`**. They live in the launchpad vault (the OS keychain, service',
    '`launchpad`), shared across every launchpad-managed project on this machine. A `.env`',
    'here is for app *runtime* config only (database URLs, OAuth client ids) — never a',
    'deploy or DNS token, which would sync into CI and every deploy the moment it landed.',
    '',
    '- **Need a token (Cloudflare, Vercel, an API key)?** It is already in the vault. Read it',
    '  when a tool needs it — do not copy it anywhere:',
    '  `launchpad secret <key>` (portable), or on macOS `security find-generic-password -a <key> -s launchpad -w`.',
    '- **A tool says a credential is missing?** Store it once with `/launchpad:doctor`, not in `.env`.',
    '- **CI** gets these via `launchpad secrets` (→ GitHub Actions secrets). Never hand-set them.',
    '',
    '### Keeping the dashboard true',
    '',
    'Mission Control derives everything from the files below, live, with no database and',
    'no cache. They are the only record — if one is stale, the dashboard is wrong, and so',
    'is whatever runs next.',
    '',
    '| File | Owns | Rule |',
    '|---|---|---|',
    '| `.launchpad/state.yml` | surfaces, configs, credentials | **Never hand-edit.** Re-run `/launchpad:setup` — it merges and preserves gathered config. |',
    '| `.launchpad/DEPLOYMENT.md` | the runbook | Generated. Re-run `setup`; edits are overwritten. |',
    '| `.github/workflows/launchpad-*.yml` | the pipelines | Generated by `/launchpad:apply`. Fix the generator in launchpad, never the output here. |',
  ];

  if (ns) {
    lines.push(
      `| \`${ns.backlogDir}/*.md\` | the roadmap | One file per task. **Update \`status:\` the moment it changes.** |`,
      '| `.launchpad/nightshift/inbox.md` | un-triaged ideas | Append-only; grooming drains it. |',
      '| `.launchpad/nightshift/run.json` | what is running now | Written by the worker. Do not touch. |',
      '',
      '**If you work on a task from the backlog, you own its status.**',
      '',
      `- Starting it → \`status: in_progress\`. A crash then leaves a trail instead of losing the work.`,
      `- Finished and \`${ns.gate}\` passes → \`status: done\`.`,
      `- Cannot finish it → \`status: blocked\` **with a \`reason:\`**. A blocked task with no reason is`,
      '  indistinguishable from one the overnight worker killed by accident, and it will sit there forever.',
      '- Not actually started → leave it alone. `ready` is not a lie you need to tell.',
      '',
      'A task finished without its status moved gets picked up and built a second time tonight.',
      '',
      `The gate is \`${ns.gate}\`. It must exit 0 before anything is committed, and **it is never**`,
      '**edited to make it pass** — it is the only thing standing between unattended work and',
      'code nobody checked.',
    );
    if (ns.protectedPaths.length) {
      lines.push('', `Never modify: ${ns.protectedPaths.map(p => `\`${p}\``).join(', ')}.`);
    }
  }

  lines.push(
    '',
    'After changing what this project *is* — a new surface, a renamed app, a new platform —',
    're-run `/launchpad:setup`. Detection is re-run and the scorecard re-derives; nothing else',
    'needs telling.',
    '',
    END,
  );
  return lines.join('\n');
}

/** The Nightshift facts the block needs. Passed in so `context` stays unaware of that module. */
export interface NightshiftFacts {
  backlogDir: string;
  gate: string;
  protectedPaths: string[];
}

/**
 * Upsert the managed block into `CLAUDE.md`, changing nothing else.
 *
 * Two promises, and the README makes the second one to the buyer in as many
 * words ("Anything you wrote by hand is preserved byte for byte"):
 *
 * 1. The block is written in the line ending the file already uses.
 * 2. Not one byte outside the block moves — not the user's endings, not their
 *    trailing whitespace, not a BOM.
 *
 * Both were broken in a CRLF repository. `existing.trimEnd() + '\n\n' + …`
 * ate the final `\r\n` and put back half of it, so the buyer's last line
 * silently lost its `\r` and everything below was LF in a file that had been
 * uniformly CRLF — a diff against their own house rules, made by a tool they
 * had just installed.
 */
export function upsertClaudeMd(repo: string, state: LaunchpadState, nightshift?: NightshiftFacts): void {
  const p = join(repo, 'CLAUDE.md');
  const existing = existsSync(p) ? readFileSync(p, 'utf8') : '';
  const re = new RegExp(`${escapeRegExp(START)}[\\s\\S]*?${escapeRegExp(END)}`);
  const hasBlock = existing.includes(START) && existing.includes(END);

  // The convention to match is the USER's, so measure it outside the managed
  // block. Measuring the whole file would let a big LF block outvote the
  // user's CRLF lines and keep a repo that is already wrong wrong forever.
  const outside = hasBlock ? existing.replace(re, '') : existing;
  const eol = detectEol(outside.includes('\n') ? outside : existing);
  // `replace` with a function: a `$&` or `$1` inside the rendered block is
  // then literal text, not a replacement pattern.
  const block = toEol(renderBlock(state, { nightshift }), eol);

  let next: string;
  if (hasBlock) {
    next = existing.replace(re, () => block);
  } else {
    const bom = existing.startsWith(BOM) ? BOM : '';
    const body = existing.slice(bom.length);
    if (body.trim() === '') {
      next = bom + block + eol;
    } else {
      // Append after the user's bytes verbatim. One separator if their file
      // already ends in a newline, two if it does not — never a trim.
      next = bom + body + (/\r?\n$/.test(body) ? eol : eol + eol) + block + eol;
    }
  }
  writeFileSync(p, next, 'utf8');
}

export function renderDeployment(state: LaunchpadState): string {
  const out: string[] = [
    `# ${state.project} — deployment runbook`,
    '',
    '> Auto-generated by launchpad on every `setup`/`apply`. Do not hand-edit; re-run to refresh.',
    '',
    '## Surfaces',
  ];
  for (const s of state.surfaces) {
    const c = s.config as Record<string, any> | undefined;
    out.push('', `### ${s.id} (${s.archetype}) — ${s.status}`);
    if (s.archetype === 'macos-dmg' && c) {
      out.push(`- App: ${c.appName} (xcodebuild scheme \`${c.scheme}\`)`);
      out.push(`- Ship a version: \`git tag -a ${c.tagPrefix}X.Y.Z -m "notes" && git push origin ${c.tagPrefix}X.Y.Z\`  (or \`/launchpad:release\`)`);
      out.push(`- Pipeline: \`.github/workflows/launchpad-${c.scheme}-macos.yml\` (build → Developer ID sign → notarize → DMG)`);
      out.push(`- DMG + appcast → Cloudflare R2 bucket \`${c.r2Bucket}\`, served at https://${c.appcastDomain}/appcast.xml (never committed to git)`);
      if (c.payments) {
        const pay = c.payments as Record<string, any>;
        const trial = (pay.trialDays ?? 0) > 0 ? `${pay.trialDays}-day free trial → ` : '';
        out.push(`- Licensing: ${trial}${pay.priceLine} (Lemon Squeezy, client-only; macOS Sender only)`);
      }
    } else if (s.archetype === 'static-site' && c) {
      const branch = c.productionBranch ?? c.testBranch;   // back-compat with pre-rename state
      out.push(`- Source: \`${c.siteDir}/\` in this repo`);
      out.push(`- Ship: push to \`${branch}\` → Cloudflare Pages **production** (your domain); any other branch → a preview URL`);
      out.push(`- Pipeline: \`.github/workflows/launchpad-${c.appName}-site.yml\``);
      if (c.appcastUrl) out.push(`- The download button reads ${c.appcastUrl} → auto-updates on each macOS release`);
    } else if (s.archetype === 'ios' && c) {
      const ios = c as unknown as IosConfig;
      const signer = signingMode(ios) === 'cloud' ? 'Xcode cloud (App Store Connect API key)' : 'fastlane match';
      out.push(`- Ship: push to \`${c.testBranch}\` → TestFlight internal; tag \`${c.tagPrefix}X.Y.Z\` → App Store upload`);
      out.push(`- Pipeline: \`.github/workflows/launchpad-${iosWorkflowSlug(ios)}-ios.yml\` — build → sign via ${signer} → upload`);
    } else if (s.archetype === 'android' && c) {
      out.push(`- Ship: push to \`${c.testBranch}\` → Firebase App Distribution`);
      out.push(`- Pipeline: \`.github/workflows/launchpad-${c.appName}-android.yml\``);
    } else if (s.archetype === 'web-app' && c) {
      out.push(`- Vercel project \`${c.project}\` (root \`${c.rootDir}\`) — preview per branch, production on main`);
    } else {
      out.push('- Not configured/wired yet — run `/launchpad:setup` to add config.');
    }
  }
  if (state.pipelines.length) {
    out.push('', '## Existing pipelines detected (candidates for consolidation)');
    for (const p of state.pipelines) out.push(`- ${p.kind}: \`${p.path}\``);
  }
  out.push(
    '',
    '## Where artifacts live (never committed to git)',
    '- macOS DMGs + Sparkle appcast → Cloudflare R2',
    '- iOS / Android builds → TestFlight / Firebase / Play',
    '- Website source → `site/` in this repo (Cloudflare Pages serves it)',
    '',
  );
  return out.join('\n');
}

/**
 * The runbook. Wholly launchpad's — regenerated on every `setup`/`apply`, as
 * the managed CLAUDE.md block says out loud — so there is nothing here to
 * preserve. It still follows the repository's line-ending convention: a
 * checked-in file that is LF in a uniformly-CRLF tree is one more line of
 * unexplained diff for a Windows buyer, and this one is checked in on purpose.
 *
 * The convention is taken from this file's own previous version if there is
 * one, else from the repo's `CLAUDE.md`, else LF.
 */
export function writeDeploymentDoc(repo: string, state: LaunchpadState): void {
  const p = join(repo, '.launchpad', 'DEPLOYMENT.md');
  const read = (f: string) => (existsSync(f) ? readFileSync(f, 'utf8') : '');
  const sample = [read(p), read(join(repo, 'CLAUDE.md'))].find(t => t.includes('\n')) ?? '';
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, toEol(renderDeployment(state), detectEol(sample)), 'utf8');
}
