// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Usernames reserved for internal actors.
 *
 * Several places in the codebase pass a literal string as the "who did this"
 * value for an action the server itself performs — `'system'` is the one that
 * matters here: `watch-together.service.ts`'s stale-session sweep used to call
 * `endSession(code, 'system')`, and `endSession` treated that literal as an
 * in-band escape hatch from its host-only check. A REAL account named `system`
 * could therefore end any party by authenticating as `system` and hitting
 * `DELETE /watch-together/{code}` — no such account was ever supposed to be
 * mintable, but nothing stopped one from being provisioned (native signup,
 * OIDC `preferred_username`, an installed auth plugin's asserted username, or
 * a forward-auth reverse-proxy header).
 *
 * Every path that turns external/attacker-influenced input into a NEW
 * `users.username` row must reject (or route around) a name in this set —
 * `normalizeUsername` (OIDC), `validateUsername` (native/admin-created),
 * `provisionUserWithIdentity` (OIDC + auth-plugin provisioning), and the
 * forward-auth header-upsert path all enforce it.
 *
 * Deliberately NOT reserved: `admin` is a plausible, common real operator
 * account name (the setup wizard's own first-run account is often literally
 * `admin`) — it is not a sentinel the server uses to mean "this action has no
 * real actor", so reserving it would only lock out a legitimate choice with no
 * security benefit.
 */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set(['system']);

/** Case-insensitive membership check against {@link RESERVED_USERNAMES}. */
export function isReservedUsername(username: string): boolean {
    return RESERVED_USERNAMES.has(username.trim().toLowerCase());
}
