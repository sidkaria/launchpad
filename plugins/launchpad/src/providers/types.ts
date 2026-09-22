/**
 * The seam between "is this key any good?" and *who we ask*.
 *
 * Lemon Squeezy is being absorbed into Stripe Managed Payments, and it is both
 * our licensing rail and one of the payment rails we recommend to customers —
 * the largest single external dependency in the product. One file should be the
 * whole cost of moving off it, so the thing every other module talks to is this
 * interface rather than anybody's API.
 *
 * **The three-way result is the entire point.** A boolean cannot express the
 * distinction this product's worst bug was made of: "the provider says this key
 * is dead" and "we could not reach the provider" are opposite answers, and a
 * type that collapses them into `false` will eventually revoke every paying
 * customer during somebody else's outage. So the result is a tri-state and
 * there is no way to spell it otherwise.
 */

export type Fetcher = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

/**
 * What a provider can conclude about a key.
 *
 *  - `valid`       — the provider answered, and the answer is yes.
 *  - `invalid`     — the provider answered, and the answer is no. A refund, a
 *                    chargeback, a key that never existed. **Only this revokes.**
 *  - `unreachable` — no answer at all: a firewall, an aeroplane, a 502, a
 *                    captive portal, a proxy that returns HTML. Changes nothing.
 */
export type Validation =
  | { status: 'valid'; instanceId?: string }
  | { status: 'invalid'; why: string }
  | { status: 'unreachable'; why: string };

/** Binding a key to this machine. Same tri-state, same reasoning. */
export type Activation =
  | { status: 'activated'; instanceId?: string }
  | { status: 'refused'; why: string }
  | { status: 'unreachable'; why: string };

/** Releasing a seat. */
export type Deactivation =
  | { status: 'released' }
  | { status: 'refused'; why: string }
  | { status: 'unreachable'; why: string };

export interface LicenseProvider {
  /** Stable id: what `LAUNCHPAD_LICENSE_PROVIDER` is set to, and what is stored. */
  id: string;
  /** What to call it to a human, in a refusal message or a support reply. */
  label: string;

  /**
   * Re-check a stored key. The only method every provider must have: a
   * validate-only rail is a legitimate provider, and one that cannot bind a
   * machine is less capable, not unusable.
   */
  validate(
    key: string,
    instanceId: string | undefined,
    fetcher: Fetcher,
    signal?: AbortSignal,
  ): Promise<Validation>;

  /**
   * Bind this key to this machine, where the provider has a notion of seats.
   * Absent means "this rail cannot count machines" — `license activate` then
   * validates and stores instead, which is weaker anti-sharing and honest about
   * it rather than pretending.
   */
  activate?(key: string, instanceName: string, fetcher: Fetcher): Promise<Activation>;

  /** Release a seat. Absent wherever `activate` is. */
  deactivate?(key: string, instanceId: string, fetcher: Fetcher): Promise<Deactivation>;

  /**
   * Does this key *look* like one of ours? A hint only, and deliberately
   * conservative: it breaks the tie when no provider was named, and must never
   * be the reason a real customer's key is sent to the wrong rail. Returning
   * false for a key you are unsure about is always the right answer.
   */
  looksLikeKey?(key: string): boolean;
}
