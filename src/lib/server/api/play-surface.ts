// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * play-surface.ts — which API surface a play session's client spoke.
 *
 * `play_sessions.source` answers "which system OWNS this playback" and is
 * load-bearing: reaper staleness thresholds, `unmeteredSources()` stream-limit
 * exemption, and the `/j` session serializer all branch on it. `surface`
 * answers a different question — "which protocol did the client speak to reach
 * us". The two are deliberately orthogonal.
 *
 * One behaviour reads it: the free-tier cap on concurrent `/j` streams per
 * server counts rows with `surface = 'jellyfin_compat'`
 * (`getLiveJellyfinCompatSessions`). That value is safe to act on because it
 * is a literal written only by `findOrCreateJellyfinSession`; nothing a client
 * sends can set it. The caveat below is about `native_app` vs
 * `third_party_api`, which stay statistics-only.
 *
 * ============================================================================
 * ATTRIBUTION, NOT AUTHORIZATION
 * ============================================================================
 * `native_app` vs `third_party_api` keys on the device-flow `client_id`, which
 * is SELF-DECLARED: `/oauth/device` is unauthenticated and the device flow has
 * no client-registration step, so any caller can claim `lumastra-ios` (see
 * oauth/device-client-redirects.ts, which documents the same property for its
 * own table). A third party that deliberately impersonates a first-party
 * client_id WILL be counted as first-party. That is accepted rather than
 * guarded, because no authorization decision reads that distinction — it feeds
 * one admin statistics card. Do not promote it into an auth path.
 */

import type { Principal, PrincipalKind } from './principal.js';

/**
 * The access surface a play session arrived through.
 *
 * `unknown` is a real value, not an error case: stream-token requests,
 * principal-less internal replay paths, and rows created before this column
 * existed all legitimately land here.
 */
export type PlaySurface =
    | 'web'
    | 'native_app'
    | 'third_party_api'
    | 'jellyfin_compat'
    | 'subsonic'
    | 'jellyfin_mirror'
    | 'unknown';

/**
 * Device-flow `client_id` values belonging to our own apps.
 *
 * A `Set`, not an object literal, and membership is `.has()` — the same
 * reasoning as device-scope-map.ts and device-client-redirects.ts: indexing a
 * plain object with an attacker-controlled string resolves through
 * `Object.prototype`, so `constructor` / `__proto__` / `toString` would return
 * a truthy non-value instead of a miss.
 *
 * This is deliberately NOT `getRegisteredDeviceRedirect()`. That table is a
 * redirect map which intentionally omits `lumastra-tvos` (tvOS's approving
 * browser is normally a different physical device), so reusing it as a
 * first-party test would file every tvOS session under `third_party_api`.
 */
const FIRST_PARTY_CLIENT_IDS: ReadonlySet<string> = new Set(['lumastra-ios', 'lumastra-tvos']);

/**
 * Derive the surface for a session being created on an authenticated route.
 *
 * Deliberately does NOT take the mount surface (`'internal'` | `'v1'`): no
 * outcome below varies by it — our own web app and our own native apps are
 * separated by credential kind, not by which path they call, and `/api/v1` is
 * dual-auth at the edge so browser cookies reach it too. Taking an input that
 * changes no output would only invite a cross-product test over a dead
 * dimension.
 *
 * Total over `PrincipalKind`: the switch is exhaustiveness-checked, so adding a
 * credential kind without deciding its surface is a compile error rather than a
 * silent `unknown`.
 */
export function deriveSurface(principal: Principal | undefined | null): PlaySurface {
    // No principal: internal replay paths and any credential arm that failed to
    // populate one. Attributing these to a real surface would be a guess.
    if (!principal) return 'unknown';

    const kind: PrincipalKind = principal.kind;
    switch (kind) {
        case 'forward_auth':
        case 'session':
            // Browser credentials. Our web app is the only thing that holds one.
            return 'web';

        case 'bearer': {
            // OAuth device-flow JWT. Our iOS/tvOS apps use this — but so does
            // any third party implementing the public device flow, so the
            // client_id claim is what splits them. Absent claim → third party:
            // our apps always send one, and an unattributable bearer token is
            // far more likely to be someone else's client than ours.
            const clientId = principal.clientId;
            return clientId && FIRST_PARTY_CLIENT_IDS.has(clientId)
                ? 'native_app'
                : 'third_party_api';
        }

        case 'pat':
        case 'service_token':
            // Long-lived credentials minted for scripts and integrations.
            // No first-party app authenticates this way.
            return 'third_party_api';

        case 'jellyfin_compat':
            // A Jellyfin client app: ours or anyone's, nothing tells them apart.
            // Before /j had a principal this was 'unknown' too.
            return 'unknown';

        case 'stream_token':
            // Short-lived streaming credential minted BY an already-classified
            // session. It carries no evidence of the original surface, and
            // guessing would double-count that session under two labels.
            return 'unknown';

        default: {
            const exhaustive: never = kind;
            void exhaustive;
            return 'unknown';
        }
    }
}
