import { basename } from 'node:path';
/**
 * Is this a workflow launchpad generated? launchpad names every workflow it
 * emits `launchpad-<app>-<archetype>.yml`, so the basename is the ownership
 * test — no need to read the file.
 *
 * Two callers depend on the SAME answer and must not drift apart: `detect`
 * skips these when listing existing pipelines (they are launchpad's own output,
 * not a foreign pipeline to reconcile), and `nonLaunchpadWorkflows` reports the
 * remainder as consolidation candidates.
 */
export function isLaunchpadWorkflow(path) {
    return basename(path).startsWith('launchpad-');
}
/**
 * Existing github-actions workflows that launchpad did NOT generate. When
 * `apply` wires a surface that emits its own release workflow, these are
 * potential ownership conflicts — e.g. a legacy `release.yml` that also
 * triggers on the same `v*` tags would DOUBLE-RUN. Surfaced so the migration
 * resolves them explicitly (remove/disable), never a silent clashing duplicate
 * (spec §3.2). launchpad never deletes user files.
 */
export function nonLaunchpadWorkflows(pipelines) {
    return pipelines
        .filter((p) => p.kind === 'github-actions' && !isLaunchpadWorkflow(p.path))
        .map((p) => p.path);
}
