/**
 * The customer-facing URLs and the price, in one place.
 *
 * They appear in the README, in the refusal message, in the licence skill, on
 * the landing page and on the dashboard. Defined once because the failure mode
 * of duplicating them is silent: a buyer follows a stale link, or reads a price
 * the checkout disagrees with, and there is nobody to tell.
 */
/** Where someone buys a key. */
export const CHECKOUT_URL = process.env.LAUNCHPAD_CHECKOUT_URL ?? 'https://launchpad.lemonsqueezy.com/checkout';
/**
 * What a key costs today, as the customer sees it written.
 *
 * ONE constant. The README, the skills and the landing page all derive from it
 * or are tested against it, and `test/price.test.ts` fails the build if a dollar
 * amount that disagrees with it appears in any of them. The previous $20 was
 * typed into six files and went stale in all six at once.
 *
 * The price is **stepped on real sales** — $29 → $49 → $79 (DECISIONS.md
 * 2026-09-21) — so this value changes when a step is taken. It is deliberately
 * a string including the currency symbol: a number would have to be formatted
 * at four call sites, and the first one to format it differently is the bug.
 */
export const PRICE = process.env.LAUNCHPAD_PRICE ?? '$29';
/**
 * The published ladder, so the page can say where the price is going without
 * inventing a position on it. The current `PRICE` is the step we are on.
 */
export const PRICE_STEPS = ['$29', '$49', '$79'];
/** How long a buyer has to change their mind, in days (DECISIONS.md 2026-09-21). */
export const REFUND_DAYS = Number(process.env.LAUNCHPAD_REFUND_DAYS ?? 14);
/**
 * What the purchase includes on the version axis. Stated wherever updates are
 * described, because "one-time" and "updates forever" are not the same promise
 * and a buyer who assumes the second is a refund waiting to happen.
 */
export const UPDATE_POLICY = 'all 1.x updates included; 2.0 is a paid upgrade, discounted for owners';
/** Where someone goes when the product is wrong. */
export const SUPPORT_URL = process.env.LAUNCHPAD_SUPPORT_URL ?? 'https://github.com/sidkaria/launchpad/issues';
/**
 * Which rail answers "is this key good?".
 *
 * Lemon Squeezy is being absorbed into Stripe Managed Payments, and it is both
 * our licensing rail and one of the payment rails we recommend to customers.
 * That makes it the largest single external dependency in the product, so the
 * cost of moving off it is kept to this constant plus one file in `providers/`.
 *
 * `lemonsqueezy` is what we launch on. `polar` is the tested fallback.
 */
export const LICENSE_PROVIDER = process.env.LAUNCHPAD_LICENSE_PROVIDER ?? 'lemonsqueezy';
/** Lemon Squeezy's public licence API. Overridable so CI can point at a stub. */
export const LEMONSQUEEZY_API = process.env.LAUNCHPAD_LEMONSQUEEZY_API ?? 'https://api.lemonsqueezy.com/v1/licenses';
/** Polar's public API root. Sandbox is `https://sandbox-api.polar.sh`. */
export const POLAR_API = process.env.LAUNCHPAD_POLAR_API ?? 'https://api.polar.sh';
/**
 * Our Polar organization id, required in every customer-portal licence call.
 *
 * **This is a public constant, not a secret**, and it matters that the
 * distinction is written down where someone might later "tidy it away" into the
 * vault. Polar documents the validate/activate/deactivate endpoints as safe for
 * a public client — a desktop or mobile app — while making `organization_id`
 * required, so it cannot be a value that has to stay private. It is a namespace
 * discriminator that stops one organization's keys validating against another's.
 * The thing that IS secret on Polar is an Organization Access Token
 * (`polar_oat_…`), and none of those may ever appear in shipped code.
 *
 * Empty until the Polar product exists. The provider treats an unset id as "no
 * rail configured" and reports UNREACHABLE — never as a rejection, because a
 * constant nobody filled in must not be able to cancel a paying customer.
 */
export const POLAR_ORGANIZATION_ID = process.env.LAUNCHPAD_POLAR_ORGANIZATION_ID ?? '';
