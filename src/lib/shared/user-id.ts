// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Branded user identifiers — the single sanctioned place to reason about the two
 * different "who is this user" values the app carries.
 *
 * This file is platform-agnostic (no server- or browser-specific imports) so
 * server queries and any client type that needs it import the SAME brand.
 *
 * ## The two conventions
 *
 *  - **`UserId`** — the STABLE `users.id` UUID. This is the ONLY value that may
 *    key user-data tables/queries/caches (ratings, watch-state, playlists, …).
 *    Since migration 16.46.0 every user-data column is `uuid REFERENCES users(id)`.
 *
 *  - **`Username`** — the mutable login/display handle (`users.username`). Fine
 *    for display, login lookup, and Jellyfin identity matching, but it must NEVER
 *    be used as a data key (a rename would orphan the user's data).
 *
 * They are distinct brands so the compiler rejects passing one where the other is
 * expected: a username-vs-UUID mixup becomes a COMPILE error, not silent data
 * corruption. A `UserId` can only be minted at a trusted boundary — a DB read of
 * `users.id` or auth resolution — via {@link toUserId}, which VALIDATES the UUID
 * shape so a username can never be tagged by mistake.
 *
 * Do NOT bypass the brand with `as UserId` / `as Username` outside this file
 * (enforced by an ESLint `no-restricted-syntax` rule). Use the constructors.
 */

import { UUID_RE } from '$lib/utils/id-patterns.js';

/** The stable users.id UUID — the only valid key for user data. */
export type UserId = string & { readonly __userId: unique symbol };

/** The mutable login/display handle (users.username). Never a data key. */
export type Username = string & { readonly __username: unique symbol };

/** True if `value` is a syntactically valid UUID (the shape of a UserId). */
export function isUserId(value: unknown): value is UserId {
    return typeof value === 'string' && UUID_RE.test(value);
}

/**
 * Mint a `UserId` from a value KNOWN to be a `users.id` UUID (a DB read or auth
 * resolution). Throws on a non-UUID so a username can never be tagged as a UserId
 * by mistake — a bad UserId corrupts data, so fail loud rather than coerce.
 */
export function toUserId(uuid: string): UserId {
    if (!UUID_RE.test(uuid)) {
        // `String(...)` before slicing: a caller that reaches here with a
        // non-string (a legacy numeric id, a null from an untyped boundary)
        // used to crash on `.slice` with "uuid.slice is not a function",
        // which hides the actual problem this guard exists to report.
        throw new Error(`toUserId: not a UUID (got ${JSON.stringify(String(uuid).slice(0, 16))})`);
    }
    return uuid as UserId;
}

/**
 * Mint a `UserId` from a nullable DB value, or `undefined` if null/empty.
 * For the service-boundary `row.user_id ?? undefined` pattern with nullable
 * user columns (e.g. playback_telemetry.user_id after the SET NULL re-key).
 */
export function toUserIdOrUndefined(uuid: string | null | undefined): UserId | undefined {
    return uuid ? toUserId(uuid) : undefined;
}

/** Tag a verified login handle as a `Username` (presentation/lookup only). */
export function toUsername(name: string): Username {
    return name as Username;
}
