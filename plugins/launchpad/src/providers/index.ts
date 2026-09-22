import { LICENSE_PROVIDER } from '../product.js';
import { lemonSqueezy } from './lemonsqueezy.js';
import { polar } from './polar.js';
import type { LicenseProvider } from './types.js';

export type { Activation, Deactivation, Fetcher, LicenseProvider, Validation } from './types.js';
export { lemonSqueezy } from './lemonsqueezy.js';
export { polar, makePolarProvider } from './polar.js';

/**
 * Every rail this build can talk to.
 *
 * A plain array rather than a mutable registry, and that is deliberate: there
 * is no `register()` for anything outside this file to call, so there is no
 * runtime hook that could be driven from an environment variable into
 * "entitled". Tests and the harness inject a provider by **passing one** to
 * `activate` / `revalidate` / `refreshIfStale`, which is a seam that exists
 * only for a caller that already has the code in its hands.
 */
export const PROVIDERS: readonly LicenseProvider[] = [lemonSqueezy, polar];

export const providerById = (id: string): LicenseProvider | null =>
  PROVIDERS.find(p => p.id === id) ?? null;

/** The rail named by the constant in `product.ts`, falling back to the first. */
export const defaultProvider = (): LicenseProvider =>
  providerById(LICENSE_PROVIDER) ?? lemonSqueezy;

/**
 * Which rail should answer for a key we are seeing for the first time?
 *
 * The configured provider wins. A key-format hint only breaks a tie the
 * constant did not settle, and every provider's `looksLikeKey` is expected to
 * be conservative to the point of usually saying nothing — sending a real
 * customer's key to the wrong rail produces a confident 404, which is the one
 * failure mode this whole module exists to prevent. Today neither Lemon Squeezy
 * nor Polar claims a distinctive format, so the hook is mechanism without a
 * claim; that is the honest state rather than a guess dressed as detection.
 */
export function selectProvider(key?: string): LicenseProvider {
  const configured = providerById(LICENSE_PROVIDER);
  if (configured) return configured;
  if (key) {
    const hinted = PROVIDERS.find(p => p.looksLikeKey?.(key.trim()));
    if (hinted) return hinted;
  }
  return lemonSqueezy;
}

/**
 * Which rail issued the key already on this machine?
 *
 * **`null` means "nobody we can ask", and the caller must treat that as
 * UNREACHABLE.** A record written by a build that used a provider this build
 * has never heard of is not a bad key — it is a question we cannot put to
 * anyone — and routing it to whatever the current default happens to be would
 * earn a confident rejection from a rail that has never seen it. That is
 * exactly how switching provider would otherwise cancel every existing
 * customer on their next command.
 *
 * A record with no provider recorded at all predates this field. Those were all
 * written by the Lemon Squeezy build, so they go there.
 */
export function providerForRecord(rec: { key: string; provider?: string }): LicenseProvider | null {
  if (!rec.provider) return lemonSqueezy;
  return providerById(rec.provider);
}
