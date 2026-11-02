// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The closed allowlist that turns a device-flow `scope` request string into
 * the raw scopes fed to `buildPrincipal()`.
 *
 * `/oauth/device` is UNAUTHENTICATED (see `src/routes/oauth/device/+server.ts`)
 * — the `scope` string in a device authorization request is entirely
 * attacker-controlled. This module is the single place that turns that string
 * into a grant, so it must never be able to select anything outside the two
 * rows below. In particular `'admin'` is not a reachable output: passing it
 * to {@link mapRequestedScopeToRaw} does not throw and does not special-case
 * it — it simply isn't a key in the table, so it falls through to the same
 * default as any other unrecognized value.
 *
 * The table is a `Map`, not a plain object literal, and the lookup below is a
 * `.get()` call, not `table[key]`. That is not a style choice: indexing a
 * plain object with an attacker-controlled string resolves through
 * `Object.prototype`, so a `scope` of `constructor`, `toString`, `valueOf`,
 * `hasOwnProperty`, `__proto__`, `isPrototypeOf`, or `toLocaleString` would
 * return a truthy, non-iterable prototype method instead of `undefined` —
 * `[...hit]` on that throws `TypeError: hit is not iterable`, unauthenticated,
 * on every subsequent request bearing the resulting token (see
 * `forward-auth.ts` and `/device`'s consent screen, both of which call this
 * function with no try/catch). A `Map` has no prototype chain to leak
 * through, so this class of bug is structurally impossible here, not just
 * guarded against.
 *
 * Both `forward-auth.ts` (enforcement, the bearer JWT path) and
 * `device-grant-capabilities.ts` (the consent-screen display) MUST call this
 * exact function — never re-derive the mapping independently — so the two
 * can never drift apart. `device-grant-capabilities.test.ts` pins this at
 * source level.
 *
 * @module oauth/device-scope-map
 */

/**
 * Recognized device-flow request scope strings, matched by exact trimmed
 * string (not per-token) against `oauth_device_codes.scope` /
 * `AccessTokenPayload.scope`.
 *
 * - `'media'` — today's full device grant (unchanged). Also the fallback for
 *   every absent/unrecognized request — see the module doc and
 *   `device-grant-capabilities.test.ts` for why this must never narrow.
 * - `'media:read'` — new read-only grant: same read-closure, minus `write`
 *   and `media:write`.
 */
const DEVICE_SCOPE_TABLE: ReadonlyMap<string, readonly string[]> = new Map([
    ['media', ['read', 'write']],
    ['media:read', ['read']],
]);

/** The fallback raw scopes for absent/unrecognized requests (§3 of the design). */
const DEFAULT_RAW_SCOPES: readonly string[] = DEVICE_SCOPE_TABLE.get('media')!;

/** The set of request strings {@link mapRequestedScopeToRaw} recognizes. */
export const KNOWN_DEVICE_REQUEST_SCOPES: ReadonlySet<string> = new Set(DEVICE_SCOPE_TABLE.keys());

/**
 * Map a device-flow `scope` request string to the raw scopes for
 * `buildPrincipal({ tokenScopes: ... })`.
 *
 * Backward-compatibility ruling (never change without re-reading the design
 * doc): `undefined`, `null`, empty/whitespace-only, and any string that is
 * not an EXACT trimmed match for a table key all fall through to the same
 * full grant every device token gets today. This is not a security default —
 * it is a compatibility default: every token minted before this change was
 * issued under the (accidental) promise that its requested scope is ignored
 * and the grant is full. Never reject, never silently narrow.
 *
 * This function never returns a value that isn't one of the table's own
 * value-arrays — that is what makes a `scope=admin` (or any other string) a
 * structural impossibility to escalate through, not just an untested case.
 */
export function mapRequestedScopeToRaw(requestedScope: string | null | undefined): string[] {
    const trimmed = requestedScope?.trim();
    if (!trimmed) return [...DEFAULT_RAW_SCOPES];
    const hit = DEVICE_SCOPE_TABLE.get(trimmed);
    return hit ? [...hit] : [...DEFAULT_RAW_SCOPES];
}
