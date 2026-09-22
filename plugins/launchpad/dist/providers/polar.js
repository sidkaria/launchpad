import { POLAR_API, POLAR_ORGANIZATION_ID } from '../product.js';
/** A Polar organization id is a uuid4. Anything else is a misconfiguration. */
const looksLikeUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function makePolarProvider(opts = {}) {
    const api = opts.api ?? POLAR_API;
    const org = opts.organizationId ?? POLAR_ORGANIZATION_ID;
    const post = (fetcher, path, payload, signal) => fetcher(`${api}/v1/customer-portal/license-keys/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        ...(signal ? { signal } : {}),
    });
    /**
     * The guard that keeps a missing constant from behaving like a mass
     * cancellation. An unconfigured or malformed organization id makes every
     * request a 422, and 422 is our bug — so it is caught here and reported as
     * "no rail to ask", which changes nothing about anybody's entitlement.
     */
    const unconfigured = () => {
        if (!org)
            return 'no Polar organization configured in this build';
        if (!looksLikeUuid(org))
            return 'the configured Polar organization id is not a uuid';
        return null;
    };
    return {
        id: 'polar',
        label: 'Polar',
        async validate(key, activationId, fetcher, signal) {
            const bad = unconfigured();
            if (bad)
                return { status: 'unreachable', why: bad };
            let status;
            let body;
            try {
                const res = await post(fetcher, 'validate', {
                    key,
                    organization_id: org,
                    // Only sent when this machine actually activated a seat. Polar
                    // requires it only where the activation limit is enabled, and sending
                    // a stale one turns a good key into a 404.
                    ...(activationId ? { activation_id: activationId } : {}),
                    // `increment_usage` is deliberately never sent: it is the only field
                    // that can turn a validity check into a 400, and it makes the call
                    // non-idempotent on retry. We are asking a question, not metering.
                }, signal);
                status = res.status;
                /**
                 * Unreachable, in ascending order of how much it looks like an answer:
                 *
                 *   - 5xx / 408 — Polar failing to say anything.
                 *   - 429 — the unauthenticated licence endpoints share a 3 req/s
                 *     bucket, so this is a *neighbourhood* failure the customer had no
                 *     part in. Absolutely not a rejection.
                 *   - 422 — malformed request. That is our bug (a bad organization id),
                 *     and our bugs must not cancel licences.
                 */
                if (status >= 500 || status === 408 || status === 429) {
                    return { status: 'unreachable', why: `HTTP ${status}` };
                }
                if (status === 422) {
                    return { status: 'unreachable', why: 'Polar rejected the request as malformed (HTTP 422)' };
                }
                // 404 is the documented answer for a key that is not valid — and it is
                // an answer. It arrives before the body is read because Polar's 404
                // body is an error object, not a licence.
                if (status === 404) {
                    return { status: 'invalid', why: 'Polar does not recognise this key for this product' };
                }
                body = (await res.json());
                if (!body || typeof body !== 'object') {
                    return { status: 'unreachable', why: 'unrecognised response' };
                }
            }
            catch (e) {
                return { status: 'unreachable', why: e.message };
            }
            /**
             * Belt and braces over the 404. The schema admits `granted`, `revoked`
             * and `disabled`, and in practice a dead key 404s rather than returning
             * 200 with a status — but "200 therefore valid" would be trusting a
             * behaviour rather than a contract, and Polar is actively reconciling the
             * two. Only `granted` is a yes.
             */
            if (body.status === 'granted') {
                return { status: 'valid', ...(body.activation?.id ? { instanceId: body.activation.id } : {}) };
            }
            if (typeof body.status === 'string') {
                return { status: 'invalid', why: `Polar reports this key as ${body.status}` };
            }
            // A 200 with no status at all is not something we understand, and an
            // answer we do not understand is not a rejection.
            return { status: 'unreachable', why: 'unrecognised response' };
        },
        async activate(key, instanceName, fetcher) {
            const bad = unconfigured();
            if (bad)
                return { status: 'unreachable', why: bad };
            try {
                const res = await post(fetcher, 'activate', {
                    key, organization_id: org, label: instanceName,
                });
                if (res.status >= 500 || res.status === 408 || res.status === 429) {
                    return { status: 'unreachable', why: `HTTP ${res.status}` };
                }
                if (res.status === 422) {
                    return { status: 'unreachable', why: 'Polar rejected the request as malformed (HTTP 422)' };
                }
                // 403 NotPermitted: either this product has no activation limit at all,
                // or the seats are used up. Polar cannot tell us which, so the message
                // covers both without claiming either.
                if (res.status === 403) {
                    return {
                        status: 'refused',
                        why: 'Polar will not bind another machine to this key — either the seats are used up, '
                            + 'or this product does not use activations. Try `/launchpad:license` with no arguments.',
                    };
                }
                if (res.status === 404) {
                    return { status: 'refused', why: 'Polar does not recognise this key for this product' };
                }
                const body = (await res.json());
                return body?.id
                    ? { status: 'activated', instanceId: body.id }
                    : { status: 'unreachable', why: 'unrecognised response' };
            }
            catch (e) {
                return { status: 'unreachable', why: e.message };
            }
        },
        async deactivate(key, activationId, fetcher) {
            const bad = unconfigured();
            if (bad)
                return { status: 'unreachable', why: bad };
            try {
                const res = await post(fetcher, 'deactivate', {
                    key, organization_id: org, activation_id: activationId,
                });
                // 204 No Content is the success case, and it has no body at all —
                // calling `.json()` on it throws, which would read as unreachable and
                // leave a seat that was in fact released looking held.
                if (res.status === 204 || res.ok)
                    return { status: 'released' };
                if (res.status === 404)
                    return { status: 'refused', why: 'Polar does not recognise this activation' };
                return { status: 'unreachable', why: `HTTP ${res.status}` };
            }
            catch (e) {
                return { status: 'unreachable', why: e.message };
            }
        },
    };
}
export const polar = makePolarProvider();
