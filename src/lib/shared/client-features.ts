// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * client-features.ts — the vocabulary a CLIENT uses to announce what it can
 * render, and the only place those token strings are written.
 *
 * This is the mirror image of the signed-in `/server` bootstrap: that endpoint is the
 * server telling a client what the install can do, this is a client telling
 * the server what the app in front of the user can do. Both directions are
 * needed, because "the server can send an admin toast" and "this particular
 * Apple TV build will draw one" are different facts, and the admin UI has to
 * answer the second before it offers the button.
 *
 * **Why an announced list and not a version check.** tvOS, iOS and the web
 * player version independently, and a `client_version >= 1.1` gate is wrong
 * for at least one of them within a release. A feature token is also the only
 * form that survives a client shipping one half of a pair — the toast before
 * the countdown banner, say — which is the expected rollout order.
 *
 * **Unknown tokens are kept, never rejected.** A newer client talking to an
 * older server must not be 422'd for announcing something this build has
 * never heard of, so `normalizeClientFeatures` bounds and cleans the list but
 * does not filter it against {@link KNOWN_CLIENT_FEATURES}. The known list is
 * for consumers that gate on a token, not for input validation.
 *
 * Wire surfaces that carry these tokens:
 *   - `POST /api/v1/play-sessions` → `client_features: string[]`
 *   - `POST /api/v1/music/sessions` → `clientFeatures: string[]`
 *   - `POST /api/v1/devices/{id}/heartbeat` → `features: string[]`
 *
 * Read back on `AdminPlaySession.clientFeatures`, `ActiveSession.clientFeatures`
 * and `GET /api/v1/devices` → `features`.
 */

/**
 * The client renders a per-session admin message (the perishable toast sent
 * from the admin Active Sessions row). Gating the admin "Send message" button
 * on this token is the whole reason the vocabulary exists.
 */
export const CLIENT_FEATURE_ADMIN_MESSAGE = 'admin_message';

/**
 * The client renders the pinned maintenance banner with a live countdown.
 *
 * Deliberately separate from {@link CLIENT_FEATURE_ADMIN_MESSAGE}: the toast
 * and the banner are different UI with different lifetimes, and a client is
 * expected to ship one before the other. The maintenance *button* is never
 * gated on this (a broadcast has no single target session) — it is used only
 * to tell the operator how much of their audience will see the banner.
 */
export const CLIENT_FEATURE_MAINTENANCE_NOTICE = 'maintenance_notice';

/**
 * The client can host / join a Watch Together party.
 *
 * Generalises the `supportsWatchTogether: boolean` that
 * `POST /devices/{id}/heartbeat` has always accepted. That boolean keeps
 * working and keeps winning when both are sent — the shipped tvOS build sends
 * only the boolean, and a heartbeat contract that broke it would take device
 * presence down with it.
 */
export const CLIENT_FEATURE_WATCH_TOGETHER = 'watch_together';

/**
 * Every token this build understands. Additive by design: a consumer asks
 * `features.includes(TOKEN)` and an unlisted token is simply never asked
 * about. Do NOT use this list to validate input — see the module comment.
 */
export const KNOWN_CLIENT_FEATURES = [
    CLIENT_FEATURE_ADMIN_MESSAGE,
    CLIENT_FEATURE_MAINTENANCE_NOTICE,
    CLIENT_FEATURE_WATCH_TOGETHER,
] as const;

export type KnownClientFeature = (typeof KNOWN_CLIENT_FEATURES)[number];

/** Hard cap on announced tokens per session/device. */
export const MAX_CLIENT_FEATURES = 32;

/** Hard cap on one token's length. */
export const MAX_CLIENT_FEATURE_LENGTH = 64;

/** Tokens are lowercase snake_case — anything else is dropped as noise. */
const TOKEN_RE = /^[a-z0-9][a-z0-9_]*$/;

/**
 * Clean a client-announced feature list into what gets stored.
 *
 * Lowercases and trims, drops empties / non-tokens / over-long entries,
 * de-duplicates while preserving first-seen order, and caps the result at
 * {@link MAX_CLIENT_FEATURES}.
 *
 * **Presence is preserved.** `undefined` in means `undefined` out ("the client
 * never told us"); an array in always yields an array out, `[]` included ("the
 * client announced nothing"). Collapsing `[]` to `undefined` would erase a
 * distinction two consumers depend on:
 *
 *   - `play_sessions.client_features` stores NULL for the first and `{}` for
 *     the second — the one question an operator debugging a missing toast asks
 *     is which of the two they are looking at (migration 16.247.0).
 *   - `POST /devices/{id}/heartbeat` resolves `supportsWatchTogether` from the
 *     list when one was sent, and from the `deviceType === 'tv'` guess when it
 *     was not. A TV that announces `[]` is saying NO, and must not fall back
 *     into the guess the list exists to replace — otherwise it is offered in
 *     the Watch Together picker and casting to it silently does nothing.
 *
 * Unknown-but-well-formed tokens survive: the store is a record of what the
 * client said, not of what this server happens to gate on.
 */
export function normalizeClientFeatures(raw: readonly string[] | undefined): string[] | undefined {
    if (raw === undefined) return undefined;

    const seen = new Set<string>();
    for (const entry of raw) {
        if (typeof entry !== 'string') continue;
        const token = entry.trim().toLowerCase();
        if (token.length === 0 || token.length > MAX_CLIENT_FEATURE_LENGTH) continue;
        if (!TOKEN_RE.test(token)) continue;
        seen.add(token);
        if (seen.size >= MAX_CLIENT_FEATURES) break;
    }

    return [...seen];
}

/** Whether an announced list contains a token. Absent / empty → false. */
export function announcesFeature(
    features: readonly string[] | null | undefined,
    token: string,
): boolean {
    return Array.isArray(features) && features.includes(token);
}

/**
 * What the Lumastra web player announces. Both are true of it today: the
 * session-scoped SSE reader routes `admin_message` into the toast store
 * (`services/sse/admin-event-handler.ts`) and `MaintenanceBanner.svelte`
 * renders the countdown from `maintenance-notice.store.svelte.ts`.
 *
 * Kept next to the tokens rather than inline at the call site so that adding
 * a token and claiming it are one edit apart, not one grep apart.
 */
export const WEB_CLIENT_FEATURES: readonly string[] = Object.freeze([
    CLIENT_FEATURE_ADMIN_MESSAGE,
    CLIENT_FEATURE_MAINTENANCE_NOTICE,
]);
