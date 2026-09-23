import { LEMONSQUEEZY_API } from '../product.js';
const post = async (fetcher, path, form, signal) => fetcher(`${LEMONSQUEEZY_API}/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
    ...(signal ? { signal } : {}),
});
/**
 * Lemon Squeezy's refusal, in words a buyer can act on.
 *
 * Its errors are written for developers — `license_key not found.` is a field
 * name and a period — and the buyer reading it has just pasted something out
 * of a receipt email. The one thing they can do about "not found" is check
 * what they pasted, so that is what it says. Anything else is quoted rather
 * than paraphrased: guessing at a reason we were not given is how a refund
 * gets called an expiry.
 */
export function refusedWhy(error) {
    if (!error)
        return 'Lemon Squeezy rejected that key.';
    if (/license_key not found/i.test(error)) {
        return 'Lemon Squeezy has no key like that. Check it against your receipt email and paste the whole '
            + 'thing, dashes included.';
    }
    return `Lemon Squeezy says: "${error.replace(/\.$/, '')}".`;
}
export const lemonSqueezy = {
    id: 'lemonsqueezy',
    label: 'Lemon Squeezy',
    async validate(key, instanceId, fetcher, signal) {
        let body;
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
            body = (await res.json());
            // Reached something that was not the API — a captive portal, a proxy
            // error page. An unparseable body is silence with extra steps.
            if (!body || typeof body !== 'object') {
                return { status: 'unreachable', why: 'unrecognised response' };
            }
        }
        catch (e) {
            return { status: 'unreachable', why: e.message };
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
    async activate(key, instanceName, fetcher) {
        let body;
        try {
            const res = await post(fetcher, 'activate', { license_key: key, instance_name: instanceName });
            /**
             * The same classification `validate` has always had, and activation had
             * none of it: a 429 from Lemon Squeezy's rate limiter carries a JSON
             * body (`{"error":"Too Many Attempts."}`), so it parsed, `activated` was
             * absent, and a buyer who had just paid was told their key was REFUSED
             * with the rate limiter's own words. A 500 with an HTML body surfaced as
             * a JSON parse error. Neither is Lemon Squeezy saying no.
             */
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                return { status: 'unreachable', why: `HTTP ${res.status}` };
            }
            body = (await res.json());
            if (!body || typeof body !== 'object')
                return { status: 'unreachable', why: 'unrecognised response' };
        }
        catch (e) {
            return { status: 'unreachable', why: e.message };
        }
        if (!body?.activated) {
            const limit = body?.license_key?.activation_limit;
            const used = body?.license_key?.activation_usage;
            if (limit != null && used != null && used >= limit) {
                return {
                    status: 'refused',
                    why: `This key is already active on ${used} of ${limit} machines. To move it here: on a machine `
                        + 'you no longer use, run `/launchpad:license` and deactivate it, then activate again here.',
                };
            }
            return { status: 'refused', why: refusedWhy(body?.error) };
        }
        return { status: 'activated', instanceId: body.instance?.id };
    },
    async deactivate(key, instanceId, fetcher) {
        try {
            const res = await post(fetcher, 'deactivate', { license_key: key, instance_id: instanceId });
            if (res.status >= 500 || res.status === 408 || res.status === 429) {
                return { status: 'unreachable', why: `HTTP ${res.status}` };
            }
            const body = (await res.json());
            return body?.deactivated
                ? { status: 'released' }
                : { status: 'refused', why: body?.error || 'Lemon Squeezy refused the deactivation.' };
        }
        catch (e) {
            return { status: 'unreachable', why: e.message };
        }
    },
};
