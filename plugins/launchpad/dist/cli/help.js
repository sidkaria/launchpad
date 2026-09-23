export const VERBS = [
    { verb: 'score', what: 'the readiness scorecard — what stands between this repo and a product (writes nothing)' },
    { verb: 'setup', what: 'detect what this repo ships and record it in .launchpad/' },
    { verb: 'status', what: 'what launchpad knows about this repo, as JSON' },
    { verb: 'detect', what: 'raw detection, as JSON (writes nothing)' },
    { verb: 'doctor', what: 'which credentials this project needs, and which are stored' },
    { verb: 'needs', args: '[--json]', what: 'everything across your projects that is waiting on you, and what it costs' },
    { verb: 'confirm', args: '[<id> ["note"]] [--undo]', what: 'answer a question only you can answer (a "?" row)' },
    { verb: 'projects', args: '[--json]', what: 'every project you have added, one line each' },
    { verb: 'add', args: '[path]', what: 'put a set-up project on Mission Control' },
    { verb: 'remove', args: '[path]', what: 'take a project off Mission Control (the repo is untouched)' },
    { verb: 'dashboard', args: '[--port=N] [--no-open] [--demo]', what: 'Mission Control, on http://127.0.0.1:4747' },
    { verb: 'apply', what: 'write the pipelines for every surface that has its config', licensed: true },
    { verb: 'secrets', args: '[--dry-run]', what: 'push this repo\'s credentials from your vault into its GitHub secrets', licensed: true },
    { verb: 'secret', args: '<name> | set <name>', what: 'read one credential to stdout, or store one (the value is never shown)' },
    { verb: 'release', args: '<version> <project-file> [tag-prefix]', what: 'bump, commit and push a version', licensed: true },
    { verb: 'domains', args: '[--wire <domain>]', what: 'match a domain in your Cloudflare zones; --wire points it here', licensed: true },
    { verb: 'nightshift', args: '[init|idea "<text>"|groom|schedule]', what: 'the overnight worker (opt-in beta)' },
    { verb: 'license', args: '[<key> | deactivate]', what: 'activate a key, check it, or release this machine' },
    { verb: 'report', args: '[--out=FILE]', what: 'a redacted support bundle — safe to paste in public' },
    { verb: 'update', what: 'is there a newer launchpad? (asks; never installs)' },
    { verb: 'version', what: 'which launchpad is running, and from where' },
];
export function renderHelp(price) {
    // A fixed column, and a verb whose arguments do not fit takes its own line —
    // one long signature used to push every description off an 80-column screen.
    const width = 22;
    const line = (v) => {
        const sig = v.verb + (v.args ? ` ${v.args}` : '');
        const what = `${v.what}${v.licensed ? '  [licensed]' : ''}`;
        return sig.length <= width ? `  ${sig.padEnd(width)}  ${what}` : `  ${sig}\n  ${''.padEnd(width)}  ${what}`;
    };
    return [
        'launchpad — names everything between the app on your laptop and a shipped product,',
        'then wires the parts a machine can do.',
        '',
        'In Claude Code, you mostly just ask. These are the ones to start with:',
        '  /launchpad:onboard     in the repo you want to ship — detects, scores, and walks you through it',
        '  /launchpad:status      the scorecard, and nothing written',
        '  /launchpad:dashboard   every project on one screen',
        '',
        'The commands underneath (Claude runs these for you):',
        ...VERBS.map(line),
        '',
        `Everything that reads your projects is free. [licensed] needs a key — ${price}, once.`,
    ].join('\n');
}
/** Edit distance, for "did you mean". Small inputs only; no need for anything clever. */
function distance(a, b) {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++)
        d[0][j] = j;
    for (let i = 1; i <= a.length; i++) {
        for (let j = 1; j <= b.length; j++) {
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
                d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[a.length][b.length];
}
/** The closest verb, when it is close enough to be what was meant. */
export function suggest(typed, verbs = VERBS.map(v => v.verb)) {
    const t = typed.toLowerCase().replace(/^-+/, '');
    let best = null;
    let bestD = Infinity;
    for (const v of verbs) {
        const dd = v.startsWith(t) && t.length >= 3 ? 0.5 : distance(t, v);
        if (dd < bestD) {
            best = v;
            bestD = dd;
        }
    }
    return best && bestD <= Math.max(1, Math.floor(t.length / 3)) ? best : null;
}
