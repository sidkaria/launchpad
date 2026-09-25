import { execFileSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readLocalOverride } from './home.js';

export type Runner = (cmd: string, args: string[], input?: string) => string;

const realRunner: Runner = (cmd, args, input) =>
  execFileSync(cmd, args, { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });

const SERVICE = 'launchpad';

export interface Vault {
  set(key: string, value: string): void;
  get(key: string): string | null;
  has(key: string): boolean;
}

/** Which OS mechanism is actually holding the secrets. Reported by `doctor`. */
export type VaultBackend = 'keychain' | 'dpapi' | 'secret-service' | 'file';

export interface VaultOptions {
  platform?: NodeJS.Platform;
  /** Overrides backend selection. Used by tests and by an explicit user choice. */
  backend?: VaultBackend;
  /** Root for the file/dpapi backends. Defaults to the user's home. */
  home?: string;
  /** Passphrase for the `file` backend. Defaults to $LAUNCHPAD_VAULT_PASSPHRASE. */
  passphrase?: string;
  /**
   * `keychain` backend only: a keychain FILE instead of the default keychain.
   * For tests, which must never touch the login keychain. Must exist.
   */
  keychain?: string;
}

/**
 * `security find-generic-password -w` prints the password as HEX (not text)
 * whenever the stored data contains a newline or a non-ASCII byte — which is
 * every multi-line secret launchpad handles: service-account JSON, `.p8` App
 * Store Connect keys, PEM certs. Piping that straight to `gh secret set` would
 * inject a corrupt secret that only fails later, inside CI.
 *
 * Decoding blindly is NOT safe: some legitimate secrets are themselves hex
 * (an R2 access key id is 32 hex chars), and decoding one would corrupt it.
 * So only decode when the bytes really do look like something security(1)
 * would have had to hex-encode: valid UTF-8 that contains a newline or a
 * non-ASCII character. A random 16-byte key almost never satisfies both.
 *
 * macOS-specific: no other backend mangles its output this way.
 */
export function decodeKeychainValue(raw: string): string {
  if (raw.length === 0 || raw.length % 2 !== 0 || !/^[0-9a-f]+$/.test(raw)) return raw;
  const text = Buffer.from(raw, 'hex').toString('utf8');
  // Invalid UTF-8 turns into U+FFFD and won't round-trip — that means it was
  // never text, so keep the original.
  if (Buffer.from(text, 'utf8').toString('hex') !== raw) return raw;
  if (!/[\n-￿]/.test(text)) return raw;
  return text;
}

// ── backend: macOS Keychain ──────────────────────────────────────────────────

/**
 * An account or keychain name on the `security -i` command line. The parser
 * splits on whitespace and honours double quotes; a name that would need
 * escaping inside quotes is refused rather than guessed at.
 */
function securityWord(v: string, what: string): string {
  if (!v || /["\\\n\r]/.test(v)) throw new Error(`launchpad vault: ${what} ${JSON.stringify(v)} cannot be passed to security(1)`);
  return /\s/.test(v) ? `"${v}"` : v;
}

/**
 * The line `set` writes to `security -i`'s STDIN.
 *
 * `security add-generic-password -w <value>` puts the credential in the
 * process's argv, where `ps` shows it to every user on the machine for as long
 * as the process lives — Apple's own usage text says "Use of the -p or -w
 * options is insecure" (JOURNEY ledger #30). Interactive mode (`security -i`)
 * reads its commands from stdin, so the argv is just `security -i`.
 *
 * The value travels as `-X <hex>` — "password data to be added as a
 * hexadecimal string" — because the interactive parser is line-based and
 * splits on whitespace: a service-account JSON, a `.p8` or a PEM is multi-line,
 * and hex carries every byte of it verbatim with nothing to quote. `-U`
 * ("update item if it already exists") works in interactive mode exactly as on
 * the command line, so an existing item is updated in place — which also keeps
 * its access list (PLAYBOOK §8). The trailing newline is not optional:
 * `security -i` executes a line only when it ends.
 */
export function keychainAddCommand(key: string, value: string, keychain?: string): string {
  const hex = Buffer.from(value, 'utf8').toString('hex');
  return `add-generic-password -U -a ${securityWord(key, 'account')} -s ${SERVICE} -X ${hex}`
    + `${keychain ? ` ${securityWord(keychain, 'keychain')}` : ''}\n`;
}

function keychainVault(run: Runner, keychain?: string): Vault {
  /**
   * A keychain PATH that does not exist is not a harmless miss: given one,
   * `security add-generic-password` was observed to exit 0 and put the item in
   * the LOGIN keychain instead. Refuse before anything is written.
   */
  const target = (): string[] => {
    if (!keychain) return [];
    if (!existsSync(keychain)) throw new Error(`launchpad vault: keychain ${keychain} does not exist`);
    return [keychain];
  };
  const raw = (key: string): string =>
    run('security', ['find-generic-password', '-a', key, '-s', SERVICE, '-w', ...target()]).trim();
  const get = (key: string): string | null => {
    try {
      return decodeKeychainValue(raw(key));
    } catch {
      return null;
    }
  };
  return {
    // -U updates if present; -s service namespaces all launchpad secrets. The
    // value is on stdin, never in argv (see keychainAddCommand).
    set: (key, value) => {
      const kc = target();
      run('security', ['-i'], keychainAddCommand(key, value, kc[0]));
      /**
       * `security -i` exits with the status of its LAST command, and a command
       * it could not parse can print usage and still leave a 0 behind. A write
       * that did not land must be loud, so read it back: the exact value, or
       * security(1)'s hex rendering of it (multi-line and non-ASCII values).
       */
      let back: string | null = null;
      try { back = raw(key); } catch { /* reported below */ }
      const hex = Buffer.from(value, 'utf8').toString('hex');
      if (back === null || !(decodeKeychainValue(back) === value || back === value || back === hex || back === value.trim())) {
        throw new Error(`launchpad vault: the macOS Keychain did not store "${key}" (it does not read back). Nothing was printed.`);
      }
    },
    get,
    has: key => get(key) !== null,
  };
}

// ── backend: Linux Secret Service (libsecret / gnome-keyring / KWallet) ───────

function secretServiceVault(run: Runner): Vault {
  const get = (key: string): string | null => {
    try {
      const out = run('secret-tool', ['lookup', 'service', SERVICE, 'account', key]);
      // A miss exits non-zero on most versions, but some print nothing and exit 0.
      return out === '' ? null : out.replace(/\n$/, '');
    } catch {
      return null;
    }
  };
  return {
    set: (key, value) => {
      // `store` reads the secret from stdin, so it never appears in the process
      // list — unlike security(1), where -w puts it on the command line.
      run('secret-tool', ['store', '--label', `${SERVICE}: ${key}`, 'service', SERVICE, 'account', key], value);
    },
    get,
    has: key => get(key) !== null,
  };
}

// ── backend: encrypted file (Windows DPAPI-equivalent + universal fallback) ───

const FILE_ALGO = 'aes-256-gcm';

/**
 * Windows deliberately does NOT get Credential Manager.
 *
 * Credential Manager is the obvious answer and it is the wrong one here: a
 * CredentialBlob is capped at 2560 bytes, and launchpad routinely stores
 * secrets far larger than that — a Firebase service-account JSON is ~2.3KB and
 * a base64 upload keystore or .p12 cert is several KB. A capped write either
 * fails or truncates, and a truncated secret is the exact failure this
 * codebase has already paid for once (the hex-encoding bug): it looks stored,
 * and only breaks later inside CI.
 *
 * So Windows uses a passphrase-encrypted file, which is what the file backend
 * below provides on every platform. It is AES-256-GCM with a scrypt-derived
 * key — authenticated, so tampering is detected rather than silently decrypted
 * into garbage.
 *
 * It REFUSES to operate without a passphrase rather than falling back to
 * plaintext on disk. Silently writing a user's Apple signing key to an
 * unencrypted file would be indefensible, and "it worked without asking me"
 * is not worth it.
 */
function fileVault(opts: { home: string; passphrase?: string; backend: VaultBackend }): Vault {
  const dir = join(opts.home, '.launchpad');
  const path = join(dir, 'vault.json');

  const passphrase = () => {
    const p = opts.passphrase;
    if (!p) {
      throw new Error(
        'launchpad vault: no passphrase. This platform has no usable OS keychain, so secrets are ' +
        'stored in an encrypted file and need a passphrase to unlock.\n' +
        '  Set one (any long random string) and keep it in your password manager:\n' +
        '    LAUNCHPAD_VAULT_PASSPHRASE="..."\n' +
        'Secrets are never written unencrypted.',
      );
    }
    return p;
  };

  type Entry = { salt: string; iv: string; tag: string; data: string };
  const readAll = (): Record<string, Entry> => {
    if (!existsSync(path)) return {};
    try { return JSON.parse(readFileSync(path, 'utf8')) as Record<string, Entry>; } catch { return {}; }
  };

  const get = (key: string): string | null => {
    const e = readAll()[key];
    if (!e) return null;
    try {
      const dk = scryptSync(passphrase(), Buffer.from(e.salt, 'base64'), 32);
      const d = createDecipheriv(FILE_ALGO, dk, Buffer.from(e.iv, 'base64'));
      d.setAuthTag(Buffer.from(e.tag, 'base64'));
      return d.update(Buffer.from(e.data, 'base64')).toString('utf8') + d.final('utf8');
    } catch (err) {
      // A wrong passphrase and a corrupt file are indistinguishable to GCM, and
      // both must be loud: returning null would read as "not stored yet" and
      // send the user off to re-provision a credential they already have.
      throw new Error(
        `launchpad vault: cannot decrypt "${key}" — wrong LAUNCHPAD_VAULT_PASSPHRASE, or ${path} is damaged.`,
        { cause: err },
      );
    }
  };

  return {
    set(key, value) {
      const salt = randomBytes(16);
      const iv = randomBytes(12);
      const dk = scryptSync(passphrase(), salt, 32);
      const c = createCipheriv(FILE_ALGO, dk, iv);
      const data = Buffer.concat([c.update(value, 'utf8'), c.final()]);
      const all = readAll();
      all[key] = {
        salt: salt.toString('base64'), iv: iv.toString('base64'),
        tag: c.getAuthTag().toString('base64'), data: data.toString('base64'),
      };
      mkdirSync(dir, { recursive: true });
      writeFileSync(path, JSON.stringify(all, null, 2), { encoding: 'utf8', mode: 0o600 });
      // writeFileSync's mode only applies at creation, so an existing file keeps
      // whatever permissions it had. Re-assert every time.
      chmodSync(path, 0o600);
    },
    get,
    has(key) {
      // `has` must never throw — doctor calls it for every credential, and one
      // undecryptable entry should not take down the whole report.
      try { return get(key) !== null; } catch { return false; }
    },
  };
}

// ── selection ────────────────────────────────────────────────────────────────

function canRun(run: Runner, cmd: string, args: string[]): boolean {
  try { run(cmd, args); return true; } catch { return false; }
}

export const VAULT_BACKENDS: VaultBackend[] = ['keychain', 'dpapi', 'secret-service', 'file'];

/** The env var that pins the backend, named once so nothing can misspell it. */
export const VAULT_BACKEND_ENV = 'LAUNCHPAD_VAULT_BACKEND';

/**
 * An explicitly requested backend, validated.
 *
 * An unknown value THROWS rather than falling back to detection. Someone who
 * sets this is telling launchpad not to touch a particular secret store — a
 * typo that silently reverted to the login keychain would do the one thing
 * they asked it not to, in the one case where they cared enough to ask.
 */
export function requestedBackend(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): VaultBackend | null {
  const fromEnv = env[VAULT_BACKEND_ENV]?.trim();
  if (fromEnv) return validateBackend(fromEnv, VAULT_BACKEND_ENV);
  /**
   * The same project-local file `home.ts` reads, and for the same reason: an
   * eval or CI sandbox forwards a fixed allowlist of variables, so the one
   * environment that most needs to pin the backend — a container with no
   * Secret Service, a runner that must not touch the operator's login keychain
   * — is the one environment that cannot set `LAUNCHPAD_VAULT_BACKEND`.
   *
   * Second in the order, never first: someone who exported the variable for
   * this one command is being more specific than a file on disk.
   */
  const fromFile = readLocalOverride(cwd).vaultBackend;
  if (fromFile) return validateBackend(fromFile, '.launchpad/local.json "vaultBackend"');
  return null;
}

/** Unknown is an error wherever it came from — the source is named in the message. */
function validateBackend(raw: string, source: string): VaultBackend {
  if ((VAULT_BACKENDS as string[]).includes(raw)) return raw as VaultBackend;
  throw new Error(
    `launchpad vault: ${source}="${raw}" is not a backend. ` +
    `Use one of: ${VAULT_BACKENDS.join(', ')}. ` +
    'Unset it to let launchpad pick the OS-standard one.',
  );
}

/**
 * Pick the OS-standard mechanism. Linux is the only ambiguous one: a desktop
 * has a Secret Service, a container or a bare server does not, and probing is
 * the only honest way to tell.
 *
 * `LAUNCHPAD_VAULT_BACKEND` overrides the choice, because the OS-standard
 * answer is sometimes unreachable and the caller is the only one who knows:
 *
 * - A launchd-managed self-hosted CI runner cannot reach the login keychain at
 *   all — it fails `-25308 errSecInteractionNotAllowed` (PLAYBOOK §3) — and
 *   before this there was no way to tell launchpad to use the file backend.
 * - A container, or the L2 harness, needs a scratch vault; `doctor` shelled out
 *   to `security` against the caller's real login keychain regardless of what
 *   `HOME` said, which is also how two people sharing a Mac saw each other's
 *   credentials reported as present.
 *
 * `.launchpad/local.json`'s `vaultBackend` says the same thing where the
 * variable cannot arrive — an eval or CI sandbox forwards a fixed allowlist, so
 * the environment with the strongest claim on this switch is the one that
 * cannot set it (L2-F-01). Order: variable, then file, then the OS default, and
 * `home.ts` owns the file and the argument for it.
 *
 * It widens nothing. `file` and `dpapi` still refuse to run without
 * `LAUNCHPAD_VAULT_PASSPHRASE`, and nothing here writes an unencrypted secret.
 */
export function detectBackend(
  platform: NodeJS.Platform,
  run: Runner = realRunner,
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): VaultBackend {
  const requested = requestedBackend(env, cwd);
  if (requested) return requested;
  if (platform === 'darwin') return 'keychain';
  if (platform === 'win32') return 'dpapi';
  return canRun(run, 'secret-tool', ['--version']) ? 'secret-service' : 'file';
}

export function makeVault(run: Runner = realRunner, opts: VaultOptions = {}): Vault {
  const platform = opts.platform ?? process.platform;
  const backend = opts.backend ?? detectBackend(platform, run);
  switch (backend) {
    case 'keychain': return keychainVault(run, opts.keychain);
    case 'secret-service': return secretServiceVault(run);
    default: return fileVault({
      home: opts.home ?? homedir(),
      passphrase: opts.passphrase ?? process.env.LAUNCHPAD_VAULT_PASSPHRASE,
      backend,
    });
  }
}

/** Human label for `doctor`, so the user knows where their secrets actually live. */
export function backendLabel(backend: VaultBackend): string {
  switch (backend) {
    case 'keychain': return 'macOS Keychain (service "launchpad")';
    case 'secret-service': return 'Secret Service via secret-tool (service "launchpad")';
    case 'dpapi': return 'encrypted file ~/.launchpad/vault.json (AES-256-GCM)';
    case 'file': return 'encrypted file ~/.launchpad/vault.json (AES-256-GCM)';
  }
}

/**
 * The exact shell command that reads one stored credential to stdout, for the
 * backend in play. This is the single source of truth for that incantation:
 * `doctor`, the "missing credential" errors, and the onboard skill all point a
 * stuck session HERE instead of letting it invent the one anti-pattern this
 * whole system exists to prevent — a deploy/DNS token pasted into a project's
 * `.env`, which then rides along into CI and every deploy.
 *
 * The keychain and secret-service forms are usable in command substitution
 * exactly as the setup skill already does (`--token "$(… -w)"`). The file
 * backends have no native one-liner, so they route through `launchpad` itself.
 */
export function vaultReadCommand(key: string, backend: VaultBackend): string {
  switch (backend) {
    case 'keychain': return `security find-generic-password -a ${key} -s ${SERVICE} -w`;
    case 'secret-service': return `secret-tool lookup service ${SERVICE} account ${key}`;
    case 'dpapi':
    case 'file': return `LAUNCHPAD_VAULT_PASSPHRASE=… node "$CLAUDE_PLUGIN_ROOT/dist/cli/index.js" secret ${key}`;
  }
}
