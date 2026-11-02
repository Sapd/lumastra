// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * What a device-flow (QR / user-code) grant ACTUALLY gives the device.
 *
 * The device authorization request carries a `scope` string (tvOS sends
 * `"media"`; a read-only client can send `"media:read"`), which is persisted
 * on `oauth_device_codes.scope` and, from there, onto the JWT's `scope`
 * claim. Both this module and `forward-auth.ts` turn that string into raw
 * scopes via the SAME closed allowlist, `mapRequestedScopeToRaw()`
 * (`device-scope-map.ts`) — never a raw split of the request string, which
 * would let an unauthenticated device request `scope=admin`.
 *
 * This module computes the real grant by running the SAME `buildPrincipal()`
 * the bearer auth path runs, with the SAME `mapRequestedScopeToRaw()` output,
 * so the consent screen cannot drift from enforcement: if someone changes
 * `deriveIsAdmin()`, `expandScopes()`, or the scope-mapping table, this output
 * changes with it (and `device-grant-capabilities.test.ts` fails).
 *
 * @module oauth/device-grant-capabilities
 */

import { buildPrincipal } from '$lib/server/api/principal.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    mapRequestedScopeToRaw,
    KNOWN_DEVICE_REQUEST_SCOPES,
} from '$lib/server/oauth/device-scope-map.js';

/** Placeholder identity — only the scope/admin derivation is read. */
const PROBE_USER_ID = toUserId('00000000-0000-0000-0000-000000000000');

/**
 * Display cap for the requested scope.
 *
 * `oauth_device_codes.scope` is an unbounded `text` column fed straight from
 * the device's authorization request, so a buggy or hostile client can put
 * arbitrary length in it. The value is advisory (nothing reads it back), so
 * truncating the display costs no meaning and keeps the consent card bounded.
 */
const MAX_REQUESTED_DISPLAY_LENGTH = 200;

/**
 * Scope tokens this server recognizes in a device authorization request.
 *
 * Recognition is presentational (governs whether {@link requested} is safe
 * to echo verbatim) AND, via {@link mapRequestedScopeToRaw}, load-bearing:
 * a recognized `'media:read'` request actually narrows the grant. An
 * unrecognized value is arbitrary text from an unauthenticated endpoint —
 * it gets described rather than displayed, and always falls back to the
 * full grant (see `device-scope-map.ts`).
 *
 * Kept in sync with the keys of the table in `device-scope-map.ts` — see
 * `device-grant-capabilities.test.ts` for the pin.
 */
const KNOWN_REQUESTED_SCOPES = new Set(KNOWN_DEVICE_REQUEST_SCOPES);

export interface DeviceGrantCapabilities {
    /**
     * The `scope` the device asked for, or null when it sent none.
     * Truncated to {@link MAX_REQUESTED_DISPLAY_LENGTH} for display.
     */
    requested: string | null;
    /**
     * True when every token in the requested scope is one this server knows
     * ({@link KNOWN_REQUESTED_SCOPES}). Only then is {@link requested} safe to
     * echo verbatim on the consent screen. False for null/unknown requests.
     */
    requestedIsKnown: boolean;
    /**
     * True when the device sent a `scope` that has NO effect on the grant —
     * i.e. it is absent, unrecognized, or recognized-but-equal to the
     * default (`'media'`). False when a recognized request actually narrows
     * the grant (`'media:read'`). This is no longer "always true whenever
     * something was requested": a `media:read` device really does get less
     * than a `media` device, and the consent screen must not tell the user
     * otherwise.
     */
    requestedIsIgnored: boolean;
    /** The expanded scope set the issued token will actually carry. */
    granted: string[];
    /**
     * Always false. Device-flow tokens are never admin — not even when the
     * approving user is an admin. Surfaced explicitly because "this TV cannot
     * administer the server" is the property a user is being asked to trust.
     */
    grantsAdmin: boolean;
}

/**
 * Resolve the effective grant for a device-flow token.
 *
 * `ownerIsAdmin: true` is passed deliberately: it models the worst case (an
 * admin approving the device) and proves the result is admin-free regardless
 * of who approves.
 */
export function getDeviceGrantCapabilities(requestedScope: string | null): DeviceGrantCapabilities {
    const trimmed = requestedScope?.trim() || null;

    // The SAME function forward-auth.ts calls on the enforcement path — this
    // is what keeps the two from drifting (see the module doc comment).
    const rawScopes = mapRequestedScopeToRaw(trimmed);
    const defaultRawScopes = mapRequestedScopeToRaw(null);

    const principal = buildPrincipal({
        kind: 'bearer',
        userId: PROBE_USER_ID,
        username: '',
        userGroups: [],
        tokenScopes: rawScopes,
        sessionIsAdmin: false,
        ownerIsAdmin: true, // worst case: an admin approves it
        forceNonAdmin: false,
    });

    const requested =
        trimmed !== null && trimmed.length > MAX_REQUESTED_DISPLAY_LENGTH
            ? `${trimmed.slice(0, MAX_REQUESTED_DISPLAY_LENGTH)}…`
            : trimmed;

    // RFC 6749 §3.3: scope is a space-delimited list. One unknown token makes
    // the whole request unrecognized — partial echoing would be more confusing
    // than the plain "not recognized" statement.
    const requestedTokens = trimmed?.split(/\s+/).filter(Boolean) ?? [];
    const requestedIsKnown =
        requestedTokens.length > 0 &&
        requestedTokens.every((token) => KNOWN_REQUESTED_SCOPES.has(token));

    // "Ignored" means the request had NO effect on the grant — true for
    // absent/unrecognized scope (both fall back to the same default the
    // device would have gotten by sending nothing) AND for a recognized
    // request that happens to equal the default (`'media'`). False only for
    // a recognized request that actually narrows the grant (`'media:read'`).
    const requestedIsIgnored =
        requested !== null &&
        rawScopes.length === defaultRawScopes.length &&
        rawScopes.every((scope, i) => scope === defaultRawScopes[i]);

    return {
        requested,
        requestedIsKnown,
        requestedIsIgnored,
        granted: [...principal.scopes].sort(),
        grantsAdmin: principal.isAdmin,
    };
}
