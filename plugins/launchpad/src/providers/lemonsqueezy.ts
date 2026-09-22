import { LEMONSQUEEZY_API } from '../product.js';
import type { Activation, Deactivation, Fetcher, LicenseProvider, Validation } from './types.js';

/**
 * Lemon Squeezy — the rail launchpad launches on, and the one this interface
 * was extracted from. Behaviour here is deliberately unchanged from when it was
 * written inline in `license.ts`; the refactor was allowed to move code and
 * nothing else.
 *
 * Validate-only in the sense that matters: every call sends the customer's own
 * key and nothing else. There is no store API token in this file, and there
 * must never be one — the package ships as readable JavaScript to strangers, so
 * an operator credential in it is an operator credential published.
 */

interface LsResponse {
  activated?: boolean;
  deactivated?: boolean;
  valid?: boolean;
  error?: string | null;
  instance?: { id?: string } | null;
  license_key?: { status?: string; activation_limit?: number; activation_usage?: number } | null;
  meta?: { product_name?: string } | null;
}

const post = async (
  fetcher: Fetcher, path: string, form: Record<string, string>, signal?: AbortSignal,
) => fetcher(`${LEMONSQUEEZY_API}/${path}`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
  body: new URLSearchParams(form).toString(),
  ...(signal ? { signal } : {}),
});

export const lemonSqueezy: LicenseProvider = {
  id: 'lemonsqueezy',
  label: 'Lemon Squeezy',

  async validate(key, instanceId, fetcher, signal): Promise<Validation> {
    let body: LsResponse;
    try {
      const res = await post(fetcher, 'validate', {
        license_key: key,
        ...(instanceId ? { instance_id: instanceId } : {}),
      }, signal);
      /**
       * A 500, a 502 from a load balancer, a 429, a Cloudflare interstitial —
       * none of these is Lemon Squeezy saying no. They are Lemon Squeezy
       * failing to say anything, which is our outage to absorb rather than the
       * customer's key to cancel. Treating a bad afternoon at the payment
       * provider as a mass revocation would refuse every paying customer at
       * once.
       *
       * 404 is deliberately NOT here: that is the documented answer for a key
       * that does not exist, and it is an answer.
       */
      if (res.status >= 500 || res.status === 408 || res.status === 429) {
        return { status: 'unreachable', why: `HTTP ${res.status}` };
      }
      body = (await res.json()) as LsResponse;
      // Reached something that was not the API — a captive portal, a proxy
      // error page. An unparseable body is silence with extra steps.
      if (!body || typeof body !== 'object') {
        return { status: 'unreachable', why: 'unrecognised response' };
      }
    } catch (e) {
      return { status: 'unreachable', why: (e as Error).message };
    }
    return body.valid
      ? { status: 'valid' }
      : { status: 'invalid', why: body.error || 'the key was rejected' };
  },

  /**
   * The activation limit on the Lemon Squeezy product is what makes sharing
   * inconvenient — one key, N machines, and the N+1th is told so plainly. That
   * message is the entire anti-sharing mechanism, and it is enough for a
   * product at this price.
   */
  async activate(key, instanceName, fetcher): Promise<Activation> {
    let body: LsResponse;
    try {
      const res = await post(fetcher, 'activate', { license_key: key, instance_name: instanceName });
      body = (await res.json()) as LsResponse;
    } catch (e) {
      return { status: 'unreachable', why: (e as Error).message };
    }
    if (!body?.activated) {
      const limit = body?.license_key?.activation_limit;
      const used = body?.license_key?.activation_usage;
      if (limit != null && used != null && used >= limit) {
        return {
          status: 'refused',
          why: `This key is already active on ${used} of ${limit} machines. Deactivate one with `
            + '`/launchpad:license` there and deactivate it, or buy another seat.',
        };
      }
      return { status: 'refused', why: body?.error || 'Lemon Squeezy rejected that key.' };
    }
    return { status: 'activated', instanceId: body.instance?.id };
  },

  async deactivate(key, instanceId, fetcher): Promise<Deactivation> {
    try {
      const res = await post(fetcher, 'deactivate', { license_key: key, instance_id: instanceId });
      const body = (await res.json()) as LsResponse;
      return body?.deactivated
        ? { status: 'released' }
        : { status: 'refused', why: body?.error || 'Lemon Squeezy refused the deactivation.' };
    } catch (e) {
      return { status: 'unreachable', why: (e as Error).message };
    }
  },
};
