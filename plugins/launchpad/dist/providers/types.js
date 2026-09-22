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
export {};
