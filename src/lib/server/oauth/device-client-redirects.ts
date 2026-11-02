// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * RFC 6749 §3.1.2.2's "single registered redirect URI" pattern, applied to
 * the device-flow hand-off for the case where the approving browser and the
 * polling app are the SAME device (see the `/device` success page). Once a
 * code is approved there, the app has nothing left to do in the browser — it
 * already gets its token from its own `/oauth/token` polling, never from
 * this hand-off — so the only thing this table does is bring that app back
 * to the foreground.
 *
 * `/oauth/device` is UNAUTHENTICATED (see `src/routes/oauth/device/+server.ts`)
 * — `client_id` in a device authorization request is entirely
 * attacker-controlled, and device flow has no client-registration step, so
 * nothing stops a caller from self-declaring any client_id string it likes.
 * That is exactly why the redirect target is NEVER accepted from the
 * request: a client cannot supply its own redirect_uri here, full stop — it
 * only ever gets what THIS table has on file for a client_id it happens to
 * match, exactly the way a single pre-registered redirect URI works in
 * RFC 6749. An unrecognized client_id resolves to `undefined`, the device
 * code gets `redirect_uri IS NULL`, and the success page falls back to its
 * plain "you can close this page" behavior — never an error.
 *
 * A `Map`, not a plain object literal, and the lookup is `.get()`, not
 * `table[key]` — same reasoning as `device-scope-map.ts`: indexing a plain
 * object with an attacker-controlled string resolves through
 * `Object.prototype` (`constructor`, `toString`, `__proto__`, …), returning
 * a truthy non-string value instead of `undefined`. A `Map` has no
 * prototype chain to leak through.
 *
 * No secret crosses this redirect, so this table is a UX-correctness
 * boundary, not a token-leakage boundary — but it must still never resolve
 * to anything other than a first-party value from this file.
 *
 * @module oauth/device-client-redirects
 */
const DEVICE_CLIENT_REDIRECT_TABLE: ReadonlyMap<string, string> = new Map([
    // lumastra-ios: approving browser and polling app are the same device
    // (Safari on the same iPhone). Deliberately does NOT include tvOS's
    // "lumastra-tvos" — tvOS's approving device is normally a DIFFERENT
    // physical device (and even when that happens to be an iPhone, the
    // person is signing in the TV, not this app). The two used to share one
    // hardcoded client_id ("stellar-tvos", shared StellarCore
    // DashboardAuth.startDeviceAuth()) — split into "lumastra-ios" /
    // "lumastra-tvos" specifically so this table could tell them apart
    // (commit b0facaa on the client side, 2026-08-08).
    ['lumastra-ios', 'lumastra://'],
]);

/**
 * Resolve the registered redirect URI for a device-flow `client_id`, or
 * `undefined` if that client_id isn't a known first-party client.
 */
export function getRegisteredDeviceRedirect(clientId: string): string | undefined {
    return DEVICE_CLIENT_REDIRECT_TABLE.get(clientId);
}
