#!/usr/bin/env node
/**
 * The entry point the scheduler fires. `launchpad-nightshift` in package.json.
 *
 * Deliberately its own binary rather than a verb on the main CLI: a launchd
 * plist, a scheduled task and a systemd unit all hold an absolute path to
 * something, and pointing them at a general-purpose CLI means the overnight
 * job breaks the day someone changes that CLI's argument handling.
 *
 * It exits 0 on a quiet night. Most invocations do nothing — that is the
 * design, not a failure.
 */
import { runNight, writeReports } from './run.js';
import { headline } from './report.js';

function main(): void {
  const summary = runNight();
  const { report } = summary;

  // One report per project that ran, plus the machine-level one. This used to
  // write every copy to `process.cwd()`, which for a scheduled job is not a
  // repo — so the write threw, the throw was swallowed, and the morning report
  // was never written anywhere at all.
  writeReports(summary);

  process.stdout.write(`${headline(report)}\n`);
  for (const s of summary.skipped) process.stdout.write(`  skipped ${s.project}: ${s.why}\n`);

  // Always 0. A night with nothing to do is a success, and a non-zero exit
  // would make every scheduler on every platform report a recurring failure.
  process.exit(0);
}

main();
