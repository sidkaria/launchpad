import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
/**
 * The one place launchpad decides where its own state lives.
 *
 * Everything launchpad keeps about a machine rather than about a repository —
 * the licence, the project registry, the progress history, the vault's file
 * backend, the dashboard's fleet — lives under `<home>/.launchpad`. Until this
 * file existed, eight modules each answered "where is home?" independently with
 * a bare `os.homedir()` default parameter, which is three separate problems:
 *
 * 1. **It cannot be overridden.** A container, a CI runner, a second account on
 *    a shared machine and this product's own harness all want a scratch home,
 *    and there was no way to ask for one.
 * 2. **A tool that writes to the real home when told otherwise is a privacy
 *    bug**, not merely an inconvenience. Anyone who develops this product is
 *    also a user of it, so `~/.launchpad` on a developer's machine holds a real
 *    licence and real history; anything that reaches it by accident corrupts the
 *    thing the isolation exists to protect.
 * 3. **Eight defaults drift.** One of them gaining a fallback the others lack
 *    is invisible until a machine disagrees with itself about where its own
 *    licence is.
 *
 * ## Precedence
 *
 * 1. `LAUNCHPAD_HOME` — an explicit instruction, and it wins over everything.
 * 2. **`.launchpad/local.json` in the current repository**, key `home` — an
 *    explicit instruction that does not have to survive an environment
 *    allowlist. See below.
 * 3. `$HOME` (POSIX) / `%USERPROFILE%` (Windows) — the OS's own answer, read
 *    directly so that a caller who sets it gets what they asked for.
 * 4. `os.homedir()` — the passwd-database fallback, for the rare process whose
 *    environment has no home at all.
 *
 * Steps 3 and 4 are what `os.homedir()` does internally, restated here so the
 * order is a documented contract rather than a Node implementation detail.
 *
 * ## Why a file, when there is already a variable
 *
 * Because the one environment that most needs the override is the one that
 * cannot deliver it. L2's finding: an eval/CI sandbox forwards only `PATH`,
 * locale, proxy and cert settings, `ANTHROPIC_*`, `CLAUDE_CODE_*` and `EVAL_*`,
 * and a case's own `execution.env` keys must match `EVAL_[A-Z0-9_]*`. So
 * `LAUNCHPAD_HOME` and `LAUNCHPAD_VAULT_BACKEND` cannot reach launchpad there
 * at all — and those switches exist precisely *because* the OS-standard answer
 * is sometimes unreachable and only the caller can say so. A sandboxed agent is
 * that case exactly.
 *
 * An `EVAL_`-prefixed alias was the obvious fix and it is the wrong one: it is
 * still an environment variable, so it inherits the same class of problem the
 * next time a runner tightens its allowlist, and it names one tool in the
 * product's own precedence rules. A file in the repository cannot be filtered
 * by anything, is visible to the person debugging it, and is the same mechanism
 * on every platform.
 *
 * ## The file
 *
 * `<repo>/.launchpad/local.json`, two keys, both optional:
 *
 * ```json
 * { "home": ".launchpad/sandbox-home", "vaultBackend": "file" }
 * ```
 *
 * - `home` may be absolute, `~`-relative, or relative to the repository root —
 *   which is what makes a sandbox's scratch home expressible without knowing
 *   the sandbox's own paths in advance.
 * - `vaultBackend` is read by `vault.ts`'s `detectBackend`, with the same
 *   precedence: `LAUNCHPAD_VAULT_BACKEND` first, this file second, OS default
 *   last. An unknown value is an error there, not a fallback, exactly as the
 *   environment variable's is.
 *
 * **It must never be committed.** It points launchpad's state somewhere other
 * than the machine's home, which is a fact about one checkout on one machine
 * and never about the project: committed, it would silently redirect every
 * collaborator's licence and history. launchpad writes no `.gitignore` in a
 * customer's repository, so it cannot add the entry for you — add
 * `.launchpad/local.json` to yours. Nothing in launchpad ever writes this file;
 * it is read-only input, so an absent one costs a single `existsSync`.
 */
export function launchpadHome(env = process.env, cwd = process.cwd()) {
    const explicit = env.LAUNCHPAD_HOME?.trim();
    if (explicit)
        return explicit;
    const local = readLocalOverride(cwd);
    if (local.home)
        return local.home;
    const fromEnv = (process.platform === 'win32' ? env.USERPROFILE : env.HOME)?.trim();
    if (fromEnv)
        return fromEnv;
    return homedir();
}
/**
 * Find the project-local override, from `cwd` up to the repository root.
 *
 * It climbs, because `launchpad` is run from wherever the user happens to be
 * inside a repo and `.launchpad/` lives at the top of it. It **stops** at the
 * repository root — the first directory holding a `.git` — because a file
 * anywhere above that is not project-local, and one in `$HOME/.launchpad/`
 * would be a global switch created by accident, which is the opposite of what
 * this is for.
 */
export function localOverridePath(cwd = process.cwd()) {
    let dir = resolve(cwd);
    // Bounded: a symlink cycle or an unusually deep tree must not become a hang.
    for (let i = 0; i < 64; i++) {
        const candidate = join(dir, '.launchpad', 'local.json');
        if (existsSync(candidate))
            return candidate;
        if (existsSync(join(dir, '.git')))
            return null;
        const up = dirname(dir);
        if (up === dir)
            return null;
        dir = up;
    }
    return null;
}
/**
 * Read it, coercing rather than trusting.
 *
 * A malformed file reads as "no override" rather than throwing: this is
 * consulted from the default parameter of functions all over the product, and a
 * stray comma in a scratch file must not make every command exit non-zero. The
 * one thing it must never do is silently half-apply — each key is taken only if
 * it is a non-empty string.
 */
export function readLocalOverride(cwd = process.cwd()) {
    const path = localOverridePath(cwd);
    if (!path)
        return {};
    let raw;
    try {
        raw = JSON.parse(readFileSync(path, 'utf8'));
    }
    catch {
        return {};
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const o = raw;
    const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    // `.launchpad/local.json` → the repo root is two levels up.
    const root = dirname(dirname(path));
    const home = str(o.home);
    return {
        ...(home ? { home: resolveHome(home, root) } : {}),
        ...(str(o.vaultBackend) ? { vaultBackend: str(o.vaultBackend) } : {}),
        from: path,
    };
}
/**
 * `~/scratch`, `/tmp/scratch` and `.launchpad/scratch` all mean something, and
 * the third is the one a sandbox can write without knowing where it will be
 * unpacked.
 */
function resolveHome(value, root) {
    if (value === '~')
        return homedir();
    if (value.startsWith('~/') || value.startsWith('~\\'))
        return join(homedir(), value.slice(2));
    if (isAbsolute(value))
        return value;
    return resolve(root, value);
}
/**
 * Make the resolved home true for code that has not been converted yet.
 *
 * `os.homedir()` reads `$HOME`/`%USERPROFILE%` out of the live process
 * environment on every call, so pointing those at the resolved home makes every
 * remaining `homedir()` default agree with `launchpadHome()` instead of
 * splitting a machine's state across two directories — the licence in one home
 * and the progress history in another is a worse failure than having no
 * override at all.
 *
 * Called once, from the CLI entry point, before any verb runs. A no-op unless
 * an override is actually in play, so the default path is byte-for-byte
 * unchanged — and it now bridges the file as well as the variable, because a
 * bridge that covered only one of the two sources would be the state-splitting
 * bug it exists to prevent.
 */
export function applyHomeOverride(env = process.env, cwd = process.cwd()) {
    const home = launchpadHome(env, cwd);
    const overridden = Boolean(env.LAUNCHPAD_HOME?.trim()) || Boolean(readLocalOverride(cwd).home);
    if (overridden) {
        env.HOME = home;
        env.USERPROFILE = home;
    }
    return home;
}
