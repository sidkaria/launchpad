/**
 * CI trigger policy for the mobile distribution workflows.
 *
 * The original templates hardcoded `push: branches: [<testBranch>]` (+ tags for
 * iOS) with no path filter and no way to change the runner. In a monorepo whose
 * `main` is pushed constantly — by a human or by an autonomous agent — that
 * fires a mobile build on every unrelated commit and auto-ships unreviewed code.
 *
 * This module builds the `on:` block from config instead. **The defaults
 * reproduce the old hardcoded blocks byte-for-byte**, so an existing app that
 * sets none of the new fields regenerates an identical workflow.
 */
/** Defaults preserving each surface's pre-policy behaviour. */
export const IOS_DEFAULT_DISTRIBUTE_ON = ['push', 'tag', 'dispatch'];
export const ANDROID_DEFAULT_DISTRIBUTE_ON = ['push', 'dispatch'];
export const IOS_DEFAULT_RUNNER = 'macos-15';
export const ANDROID_DEFAULT_RUNNER = 'ubuntu-latest';
/** Single-quote a glob so the shell never expands it before git sees it. */
const shq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
/**
 * A repo-relative directory in the only form a GitHub path filter accepts.
 *
 * GitHub matches `paths:` against **repository-root-relative** paths, and a
 * leading `./` is not documented as accepted — so a surface configured with
 * `siteDir: '.'` rendered `- './**'`, which may simply never match. The
 * workflow then never fires on a push, and that symptom is indistinguishable
 * from a correct skip (PLAYBOOK §4: "a skip that is actually a
 * misconfiguration looks exactly like a correct skip"), which is the most
 * expensive way for a pipeline to be wrong.
 *
 * Returns '' for the repository root, so a caller can tell "the root" from
 * any real subdirectory and choose what to render for it.
 */
export function repoRelDir(dir) {
    return (dir ?? '').trim()
        .replace(/\\/g, '/') // a Windows-shaped config value is still a repo path
        .replace(/^(?:\.\/)+/, '')
        .replace(/\/+$/, '')
        .replace(/^\.$/, '');
}
/**
 * The `paths:` glob scoping a workflow to one directory — '' when that
 * directory IS the repository root.
 *
 * At the root a filter has nothing to exclude (every push touches the surface
 * by definition), so callers render no `paths:` key at all rather than a
 * catch-all. A filter that cannot exclude anything can still fail to match;
 * an absent one cannot.
 */
export function pathGlob(dir) {
    const d = repoRelDir(dir);
    return d ? `${d}/**` : '';
}
/**
 * Render the body of the workflow's `on:` block (two-space indented, no
 * trailing newline).
 *
 * Key order is fixed — workflow_dispatch, schedule, push — so regenerating a
 * workflow never produces a spurious diff, and so the default case matches the
 * order the old templates used.
 *
 * `push` branches and `tag` tags MUST share one `push:` key: a mapping with two
 * `push:` keys is invalid YAML and GitHub rejects the workflow.
 */
export function renderOnBlock(p) {
    const on = new Set(p.distributeOn);
    if (on.size === 0) {
        throw new Error('renderOnBlock: distributeOn is empty — the workflow could never run');
    }
    const lines = [];
    if (on.has('dispatch'))
        lines.push('  workflow_dispatch:');
    if (on.has('schedule')) {
        const cron = p.schedule?.trim();
        if (!cron) {
            throw new Error("renderOnBlock: distributeOn includes 'schedule' but no schedule cron was given");
        }
        lines.push('  schedule:', `    - cron: '${cron}'`);
    }
    if (on.has('push') || on.has('tag')) {
        lines.push('  push:');
        if (on.has('push'))
            lines.push('    branches:', `      - '${p.testBranch}'`);
        if (on.has('tag'))
            lines.push('    tags:', `      - '${p.tagPrefix ?? 'v'}*'`);
        // `paths:` belongs to the push event only — GitHub does not accept a path
        // filter on `schedule`, and it is meaningless on a tag push. It is therefore
        // emitted solely when branch pushes are in play. NOTE: because branches and
        // tags share one `push:` key, a config that enables BOTH 'tag' and a
        // pathFilter also constrains tag pushes; prefer a tag-only policy
        // (distributeOn without 'push') when releases must never be path-gated.
        if (on.has('push') && p.pathFilter?.length) {
            lines.push('    paths:', ...p.pathFilter.map(g => `      - '${g}'`));
        }
    }
    return lines.join('\n');
}
/**
 * The paths the schedule guard diffs against: the explicit filter, else the app dir.
 *
 * These are git **pathspecs**, not GitHub path filters — a different grammar,
 * in which `.` and `./x` are both accepted and `''` is an error. So this
 * deliberately does NOT go through `pathGlob`.
 */
export function guardPaths(p, workdir) {
    return p.pathFilter?.length ? p.pathFilter : [workdir];
}
/**
 * The `if:` line gating every step after the schedule guard. Empty (and so
 * invisible in the output) unless the workflow actually runs on a schedule.
 * Returned without a trailing newline — see `stepIfVar` for template use.
 */
export function stepIfLine(distributeOn) {
    return distributeOn.includes('schedule')
        ? "        if: steps.changed.outputs.run == 'true'"
        : '';
}
/**
 * `stepIfLine` as a template variable: it sits at the start of the line holding
 * a step's second key (`run:`/`with:`/`env:`/`working-directory:`), so the empty
 * case substitutes to nothing at all and leaves the YAML untouched.
 */
export function stepIfVar(distributeOn) {
    const line = stepIfLine(distributeOn);
    return line ? `${line}\n` : '';
}
/**
 * The guard step, emitted only for schedule-triggered workflows.
 *
 * A nightly build exists to batch an agent's overnight work into one release —
 * but on a quiet night there is nothing to ship, and burning a macOS runner (and
 * a TestFlight build number) on an unchanged tree is pure waste. This sets an
 * output the remaining steps gate on, so the job no-ops instead.
 *
 * It runs immediately after `actions/checkout` rather than literally first,
 * because it needs the history that checkout fetches (`fetch-depth: 0`).
 * Substituted at the start of the line holding the next step, so the non-
 * schedule case renders to nothing; the schedule case ends with a blank line.
 */
export function scheduleGuardStep(p, workdir) {
    if (!p.distributeOn.includes('schedule'))
        return '';
    const paths = guardPaths(p, workdir);
    const spec = paths.map(shq).join(' ');
    const human = paths.join(', ');
    return [
        '      # Scheduled runs batch the previous day\'s commits into one build. On a',
        '      # quiet night there is nothing to ship, so skip the job rather than burn a',
        '      # runner and a build number. The 26h window overlaps the daily cadence so a',
        '      # commit can never fall between two runs. Manual and tag runs always proceed.',
        '      - name: Skip if no mobile changes since yesterday',
        '        id: changed',
        '        run: |',
        '          if [ "${{ github.event_name }}" != "schedule" ]; then echo "run=true" >> "$GITHUB_OUTPUT"; exit 0; fi',
        `          if git log --since="26 hours ago" --oneline -- ${spec} | grep -q .; then`,
        '            echo "run=true" >> "$GITHUB_OUTPUT"',
        '          else',
        `            echo "run=false" >> "$GITHUB_OUTPUT"; echo "No changes under ${human} in the last day — skipping."`,
        '          fi',
        '',
        '',
    ].join('\n');
}
/**
 * The `subosito/flutter-action` step. `channel: stable` FLOATS — CI silently
 * runs whatever Flutter shipped most recently, so a project that analyses
 * clean locally can fail in CI the day a new stable adds a deprecation (real
 * case: `onReorder` deprecated after 3.41.0 broke `flutter analyze` while the
 * dev machine sat on 3.41.9). Pin `flutterVersion` for reproducible builds.
 */
export function flutterSetupStep(version, stepIf) {
    const pin = version?.trim();
    return [
        '      - uses: subosito/flutter-action@v2',
        ...(stepIf ? [stepIf] : []),
        '        with:',
        ...(pin ? [`          flutter-version: '${pin}'`] : []),
        '          channel: stable',
    ].join('\n');
}
