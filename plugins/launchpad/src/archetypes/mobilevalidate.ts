import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { renderOnBlock, pathGlob } from './triggers.js';
import { writeGuarded, type WriteResult } from '../generated.js';
import { flutterSetupStep } from './triggers.js';

/**
 * The cheap Flutter VALIDATE workflow.
 *
 * The distribution workflows are expensive (macOS runners, signing secrets) and
 * side-effectful (they ship to TestFlight / Firebase). Once the distribution
 * trigger is narrowed — to a schedule, a tag, or a path filter — ordinary pushes
 * get no CI feedback at all. This fills that gap: `flutter analyze` + `flutter
 * test` on every push to the test branch, on ubuntu, with no credentials.
 *
 * It ships NOTHING. It must never need a secret — that is what makes it safe to
 * run on every commit, and it is asserted in the tests.
 */

export interface MobileValidateConfig {
  appName: string;
  workdir: string;            // flutter app dir, repo-relative ('.' or 'apps/mobile')
  testBranch: string;
  framework?: 'flutter' | 'native';  // native surfaces have no flutter analyze/test
  pathFilter?: string[];      // defaults to everything under workdir
  validate?: boolean;         // opt-in; unset → no file is emitted at all
  // Command that regenerates the project's GENERATED dart sources (e.g.
  // 'dart run tool/gen_tokens.dart', 'dart run build_runner build'). Mirrors
  // IosConfig.prebuild. Without it, `flutter analyze` on a project with codegen
  // fails on undefined identifiers that simply don't exist in the repo yet.
  // Unset → no step, and the workflow is byte-for-byte the pre-codegen one.
  codegen?: string;
  flutterVersion?: string;
  // Extra args for `flutter test` in the validate lane, e.g. '--exclude-tags golden'.
  // Golden tests are pixel comparisons whose baselines are rasterised on the machine
  // that generated them, so they legitimately pass locally and fail on a different
  // CI OS. Keep them in the local gate; keep them out of the cheap CI lane.
  testArgs?: string;
}

export interface GeneratedFile { path: string; contents: string; }

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'mobile');
const tmpl = (n: string) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');

/** Slugify an app name so "My App Receiver" never yields a path with a space. */
export function validateWorkflowSlug(appName: string): string {
  return appName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

export function validateWorkflowPath(c: MobileValidateConfig): string {
  return `.github/workflows/launchpad-${validateWorkflowSlug(c.appName)}-mobile-validate.yml`;
}

/** Everything under the app dir — the default scope when no pathFilter is given. */
export function defaultValidatePaths(workdir: string): string[] {
  // `pathGlob` returns '' at the repo root. This workflow validates rather
  // than ships, so the catch-all is the right root behaviour — but it must be
  // `**`, never `./**`, which GitHub does not document as matching anything.
  return [pathGlob(workdir) || '**'];
}

/**
 * The codegen step, emitted only when a command is configured. It runs after
 * `flutter pub get` (the generator is usually a dev_dependency) and before
 * `flutter analyze`. Substituted at the START of the line holding the analyze
 * step, so the unset case renders to nothing at all and the workflow stays
 * byte-for-byte identical; the set case ends with a blank line.
 */
export function codegenStep(c: MobileValidateConfig): string {
  const cmd = c.codegen?.trim();
  if (!cmd) return '';
  return [
    '      - name: Codegen',
    `        working-directory: ${c.workdir}`,
    `        run: ${cmd}`,
    '',
    '',
  ].join('\n');
}

/**
 * Plan the validate workflow. Returns `[]` unless `validate` is explicitly true
 * (so no existing app gains a new file) and the surface is Flutter.
 */
export function planFlutterValidateFiles(c: MobileValidateConfig): GeneratedFile[] {
  if (!c.validate) return [];
  if (c.framework && c.framework !== 'flutter') return [];
  const onTriggers = renderOnBlock({
    testBranch: c.testBranch,
    distributeOn: ['push', 'dispatch'],
    pathFilter: c.pathFilter?.length ? c.pathFilter : defaultValidatePaths(c.workdir),
  });
  return [{
    path: validateWorkflowPath(c),
    contents: render(tmpl('validate.yml'), {
      FLUTTER_SETUP: flutterSetupStep(c.flutterVersion, ''),
      TEST_ARGS: c.testArgs?.trim() ? ` ${c.testArgs.trim()}` : '',
      APP_NAME: c.appName,
      WORKDIR: c.workdir,
      ON_TRIGGERS: onTriggers,
      CODEGEN_STEP: codegenStep(c),
    }),
  }];
}

export function writeFlutterValidateFiles(repo: string, c: MobileValidateConfig): WriteResult {
  return writeGuarded(repo, planFlutterValidateFiles(c));
}

/**
 * The same Codegen step for a DISTRIBUTION workflow. `flutter build` needs the
 * generated sources exactly as much as `flutter analyze` does — a real CI run
 * failed with "Error when reading 'lib/core/theme/tokens.g.dart'" after the
 * validate lane had already been fixed. `stepIf` is the schedule-guard gating
 * line (empty unless the workflow runs on a schedule).
 */
export function codegenWorkflowStep(codegen: string | undefined, workdir: string, stepIf: string): string {
  const cmd = codegen?.trim();
  if (!cmd) return '';
  return [
    '      - name: Codegen',
    ...(stepIf ? [stepIf] : []),
    `        working-directory: ${workdir}`,
    `        run: ${cmd}`,
    '',
  ].join('\n');
}
