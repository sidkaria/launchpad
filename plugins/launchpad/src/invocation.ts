import { userInfo } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * How a person types a launchpad command into a terminal.
 *
 * There is no `launchpad` on anybody's PATH — it is a Claude Code plugin, and
 * the skills run it as `node "${CLAUDE_PLUGIN_ROOT}/dist/cli/index.js"`. That
 * form is right for an agent and useless in a terminal, where
 * `CLAUDE_PLUGIN_ROOT` is not set. The credential cards on the dashboard and in
 * `launchpad needs` are the one place the product asks a person to type
 * something themselves (DECISIONS 2026-09-22: a credential value goes from a
 * terminal into the vault and never through a page), and they printed
 * `launchpad secret <key>` — which is "command not found" on every machine
 * that exists.
 *
 * So the command is spelled with the real path of the CLI that is running.
 * Under the home directory it is written `$HOME/…` inside double quotes, which
 * every POSIX shell expands, which keeps working when pasted, and which does
 * not put a username on a screen somebody may photograph.
 */
export function cliPath(): string {
  // dist/invocation.js → dist/cli/index.js
  return join(fileURLToPath(new URL('.', import.meta.url)), 'cli', 'index.js');
}

/**
 * The login home — what `$HOME` is in the terminal the command will be pasted
 * into — rather than launchpad's state home, which a sandbox, a CI runner or
 * the harness may have pointed somewhere else.
 */
function loginHome(): string {
  try { return userInfo().homedir; } catch { return process.env.HOME ?? ''; }
}

export function cliInvocation(path = cliPath(), home = loginHome(), platform = process.platform): string {
  const abs = resolve(path);
  if (platform !== 'win32' && home) {
    const h = resolve(home);
    if (abs.startsWith(h + sep)) return `node "$HOME/${abs.slice(h.length + 1).split(sep).join('/')}"`;
  }
  return `node "${abs}"`;
}

/** `launchpad secret set x` → `node "$HOME/…/dist/cli/index.js" secret set x`. */
export function runnable(command: string, invocation = cliInvocation()): string {
  return command.replace(/^launchpad(?=\s|$)/, invocation);
}
