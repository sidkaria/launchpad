import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../templating.js';
import { renderOnBlock, pathGlob } from './triggers.js';
import { writeGuarded } from '../generated.js';
import { flutterSetupStep } from './triggers.js';
const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'templates', 'mobile');
const tmpl = (n) => readFileSync(join(TEMPLATES_DIR, n), 'utf8');
/** Slugify an app name so "My App Receiver" never yields a path with a space. */
export function validateWorkflowSlug(appName) {
    return appName.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}
export function validateWorkflowPath(c) {
    return `.github/workflows/launchpad-${validateWorkflowSlug(c.appName)}-mobile-validate.yml`;
}
/** Everything under the app dir — the default scope when no pathFilter is given. */
export function defaultValidatePaths(workdir) {
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
export function codegenStep(c) {
    const cmd = c.codegen?.trim();
    if (!cmd)
        return '';
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
export function planFlutterValidateFiles(c) {
    if (!c.validate)
        return [];
    if (c.framework && c.framework !== 'flutter')
        return [];
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
export function writeFlutterValidateFiles(repo, c) {
    return writeGuarded(repo, planFlutterValidateFiles(c));
}
/**
 * The same Codegen step for a DISTRIBUTION workflow. `flutter build` needs the
 * generated sources exactly as much as `flutter analyze` does — a real CI run
 * failed with "Error when reading 'lib/core/theme/tokens.g.dart'" after the
 * validate lane had already been fixed. `stepIf` is the schedule-guard gating
 * line (empty unless the workflow runs on a schedule).
 */
export function codegenWorkflowStep(codegen, workdir, stepIf) {
    const cmd = codegen?.trim();
    if (!cmd)
        return '';
    return [
        '      - name: Codegen',
        ...(stepIf ? [stepIf] : []),
        `        working-directory: ${workdir}`,
        `        run: ${cmd}`,
        '',
    ].join('\n');
}
