/**
 * Making the overnight run happen, on three operating systems.
 *
 * The old system was launchd plists — macOS only, which for a product means
 * every Windows and Linux buyer gets a Nightshift that silently never fires.
 * Each platform's native scheduler is used rather than a long-lived daemon:
 * a daemon that must survive a reboot, a lid close and a sleep cycle is a
 * support burden, and all three systems already solved this.
 */
/**
 * Directories a scheduler must search for the agent binary.
 *
 * launchd, systemd and Task Scheduler all hand a job a minimal environment —
 * launchd gives roughly `/usr/bin:/bin:/usr/sbin:/sbin` — and nothing a
 * developer installed lives there. `claude` is typically in `~/.local/bin` or
 * a Homebrew prefix, so the generated schedule found nothing and every task
 * came back `agent exited 1 after 0s`: a whole night of runs that looked like
 * the agent failing rather than the launcher never finding it.
 *
 * This is the single most expensive thing to get wrong, because it fails
 * silently and only at night, on the machine, hours after anyone was watching.
 */
export const AGENT_PATH_DIRS = [
    '~/.local/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
];
export const agentPath = (home) => AGENT_PATH_DIRS.map(d => d.replace(/^~/, home)).join(':');
export const DEFAULT_LABEL = 'com.launchpad.nightshift';
export function schedulerFor(platform) {
    if (platform === 'darwin')
        return 'launchd';
    if (platform === 'win32')
        return 'schtasks';
    return 'systemd';
}
const pad = (n) => String(n).padStart(2, '0');
export function launchdPlist(s, home = '~') {
    const label = s.label ?? DEFAULT_LABEL;
    return [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        `  <key>Label</key><string>${label}</string>`,
        '  <key>ProgramArguments</key>',
        `  <array><string>${s.node}</string><string>${s.script}</string></array>`,
        `  <key>StartInterval</key><integer>${s.intervalMinutes * 60}</integer>`,
        // The drain re-checks the window itself, so a tick outside it is a cheap
        // no-op. StartInterval is used rather than StartCalendarInterval because a
        // machine asleep at the calendar moment simply misses that fire entirely.
        `  <key>StandardOutPath</key><string>${s.logDir}/nightshift.out.log</string>`,
        `  <key>StandardErrorPath</key><string>${s.logDir}/nightshift.err.log</string>`,
        // Without this launchd hands the job a minimal PATH and the agent binary
        // is simply not on it — every task returns `exited 1 after 0s`.
        '  <key>EnvironmentVariables</key>',
        `  <dict><key>PATH</key><string>${agentPath(home)}</string><key>HOME</key><string>${home}</string></dict>`,
        '  <key>RunAtLoad</key><false/>',
        '</dict>',
        '</plist>',
        '',
    ].join('\n');
}
/**
 * Windows Task Scheduler. `/f` overwrites, so re-running install is idempotent
 * rather than an error the user has to read and dismiss.
 */
export function schtasksCommand(s) {
    const label = s.label ?? DEFAULT_LABEL;
    const duration = 24 * 60; // repeat all day; the drain's own window gates it
    return [
        'schtasks /Create /F',
        `/TN "${label}"`,
        `/TR "'${s.node}' '${s.script}'"`,
        '/SC DAILY',
        `/ST ${pad(s.startHour)}:${pad(s.startMinute)}`,
        `/RI ${s.intervalMinutes}`,
        `/DU ${Math.floor(duration / 60)}:${pad(duration % 60)}`,
    ].join(' ');
}
export function systemdUnits(s, home = '~') {
    const label = s.label ?? DEFAULT_LABEL;
    return {
        service: [
            '[Unit]',
            'Description=launchpad Nightshift — overnight autonomous work',
            '',
            '[Service]',
            'Type=oneshot',
            // systemd user units inherit almost nothing, so the agent binary has to
            // be findable here for the same reason it does under launchd.
            `Environment=PATH=${agentPath(home)}`,
            `ExecStart=${s.node} ${s.script}`,
            '',
        ].join('\n'),
        timer: [
            '[Unit]',
            `Description=Run ${label} every ${s.intervalMinutes} minutes`,
            '',
            '[Timer]',
            `OnCalendar=*:0/${s.intervalMinutes}`,
            // A laptop asleep at the scheduled moment otherwise skips the night
            // entirely; Persistent runs the missed trigger once it wakes.
            'Persistent=true',
            '',
            '[Install]',
            'WantedBy=timers.target',
            '',
        ].join('\n'),
    };
}
export function installPlan(platform, s, home) {
    const label = s.label ?? DEFAULT_LABEL;
    switch (schedulerFor(platform)) {
        case 'launchd': {
            const plist = `${home}/Library/LaunchAgents/${label}.plist`;
            return {
                scheduler: 'launchd',
                files: { [plist]: launchdPlist(s, home) },
                // `bootout` first so a re-install replaces the old definition instead
                // of failing with "service already loaded" and leaving the stale one.
                commands: [
                    `launchctl bootout gui/$(id -u)/${label} 2>/dev/null || true`,
                    `launchctl bootstrap gui/$(id -u) ${plist}`,
                ],
                uninstall: [`launchctl bootout gui/$(id -u)/${label}`, `rm -f ${plist}`],
            };
        }
        case 'schtasks':
            return {
                scheduler: 'schtasks',
                files: {},
                commands: [schtasksCommand(s)],
                uninstall: [`schtasks /Delete /F /TN "${label}"`],
            };
        default: {
            const dir = `${home}/.config/systemd/user`;
            const units = systemdUnits(s, home);
            return {
                scheduler: 'systemd',
                files: { [`${dir}/${label}.service`]: units.service, [`${dir}/${label}.timer`]: units.timer },
                commands: [
                    'systemctl --user daemon-reload',
                    `systemctl --user enable --now ${label}.timer`,
                    // Without this a user timer stops the moment the user logs out, which
                    // is exactly when an overnight job is supposed to be running.
                    `loginctl enable-linger $(whoami) || true`,
                ],
                uninstall: [`systemctl --user disable --now ${label}.timer`, `rm -f ${dir}/${label}.{service,timer}`],
            };
        }
    }
}
/** What to tell the user about staying awake — genuinely different per OS. */
export function sleepAdvice(platform) {
    switch (schedulerFor(platform)) {
        case 'launchd':
            return 'macOS sleeps on battery with the lid closed regardless of any scheduler. ' +
                'Keep it plugged in, or run `caffeinate` alongside; a closed lid on battery needs ' +
                '`sudo pmset -b disablesleep 1`.';
        case 'schtasks':
            return 'Set the task to wake the computer (Task Scheduler → Conditions → Wake the computer ' +
                'to run this task), or Windows will sleep through the whole window.';
        default:
            return 'The timer is Persistent, so a missed trigger runs on wake. For a laptop, ' +
                'check that suspend is not configured to cut user services.';
    }
}
