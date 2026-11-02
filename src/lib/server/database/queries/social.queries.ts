// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Social Queries Module
 *
 * Queries for social features like "who watched this" viewers lists.
 * Uses UUID-based tables (user_watch_history, user_ratings).
 *
 * Privacy: Users with stream privacy enabled are excluded from viewer lists
 * AND from the total count — both share the same predicate so the count of
 * opted-out users can never be inferred from `total - rows.length`.
 *
 * ## Audiobooks are gated harder than everything else here
 *
 * `hide_streams` alone is the *movie/series* privacy tier and this endpoint is
 * media-type agnostic, so an audiobook UUID used to reach the same code path and
 * return everyone who finished that book — bypassing the trust-circle predicate
 * the listening surfaces were built around (design doc
 * `2026-07-28-audiobook-social-design.md` §3). "Finished" is one of the
 * dimensions that doc puts at the ambient tier, so it is gated at the ambient
 * tier here too, through the SAME shared predicate
 * (`builders/social-visibility.builder.ts`) rather than a second copy of the
 * rules.
 *
 * Non-audiobook rows are deliberately untouched: their visibility contract has
 * always been `hide_streams`, and folding them into the trust circle would make
 * every existing "who watched this" list go dark on an install that never
 * configures `SOCIAL_TRUST_GROUPS`.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { buildSocialVisibilityFilter } from './builders/social-visibility.builder.js';

// =============================================================================
// Types
// =============================================================================

export interface ViewerRow {
    user_id: string;
    display_name: string | null;
    play_count: number;
    last_played_at: Date | null;
    is_favorite: boolean;
    rating: number | null;
    rating_style: string | null;
    total_count: number;
}

// =============================================================================
// Constants
// =============================================================================

/**
 * Characters stripped before deciding a `display_name` is blank.
 *
 * Passed as a BOUND PARAMETER rather than written into the SQL text: an escape
 * sequence inline in a postgres.js template gets cooked by the JS template
 * parser before postgres.js ever sees it, so `E'\t'` in source is not what
 * reaches the server. A parameter has no such hazard.
 *
 * Bare `BTRIM(x)` would only strip spaces — a tab-only display name is just as
 * blank on a living-room screen. The zero-width and bidi-control characters are
 * here for the same reason and to keep this READ-side guard aligned with the
 * WRITE-side `sanitizeDisplayName`, which removes exactly these: a name made
 * only of U+200B renders as nothing, but is not whitespace, so it slipped past
 * NULLIF and put a blank row on screen instead of the username fallback. Rows
 * predating the sanitiser (or written by a path that missed it) still land
 * here, so the read side cannot rely on the write side alone.
 *
 * Mirrors UNSAFE_DISPLAY_CHARS in `$lib/server/utils/display-name.ts` for the
 * zero-width/bidi ranges; C0/C1 controls are not enumerated because they cannot
 * appear mid-label without also being trimmed by the whitespace members here
 * and are not the invisible-name vector.
 */
const BLANK_NAME_CHARS =
    ' \t\n\r\f\v' +
    // Written as escapes because the literals are invisible in an editor.
    // U+200B ZWSP, U+200C ZWNJ, U+200D ZWJ, U+FEFF BOM.
    '\u200B\u200C\u200D\uFEFF' +
    // U+200E/200F LRM/RLM, U+202A-U+202E bidi embeddings/overrides.
    '\u200E\u200F\u202A\u202B\u202C\u202D\u202E' +
    // U+2066-U+2069 bidi isolates.
    '\u2066\u2067\u2068\u2069';

// =============================================================================
// Queries
// =============================================================================

export interface MediaViewersOptions {
    /**
     * Designated trust circles for the audiobook gate, for tests and for callers
     * that already resolved them. Defaults to `config.SOCIAL_TRUST_GROUPS`
     * inside the shared builder.
     */
    trustGroups?: readonly string[];
    /**
     * Audience mode override (`'auto' | 'household' | 'groups'`), for tests and
     * pre-resolved callers. Defaults to `config.SOCIAL_DEFAULT_AUDIENCE`.
     */
    audienceMode?: string;
}

/**
 * Get users who have watched a specific media item, plus the pre-LIMIT total
 * (via `COUNT(*) OVER ()`) under the SAME predicate as the returned rows.
 * Excludes the current user and users with stream privacy enabled.
 * Includes each viewer's rating if available.
 *
 * For `media_type = 'audiobook'` rows the shared trust-circle predicate applies
 * on top (see the module doc). The type is read in SQL rather than taken from the
 * caller so no caller can forget it and no id can change type between the check
 * and the read.
 */
export async function getMediaViewers(
    sql: postgres.Sql,
    mediaId: string,
    currentUser: UserId,
    limit: number = 50,
    options: MediaViewersOptions = {},
): Promise<ViewerRow[]> {
    // Ambient tier: "has finished this book" is exactly what this endpoint
    // returns, and the doc puts finished-status at the ambient tier. Unconfigured
    // circles make this `AND false`, so the EXISTS below is empty and audiobook
    // rows drop out — dark, not open.
    const audiobookVisibility = buildSocialVisibilityFilter(sql, {
        viewerId: currentUser,
        media: mediaId,
        subjectAlias: 'u_soc',
        tier: 'ambient',
        trustGroups: options.trustGroups,
        audienceMode: options.audienceMode,
        audiobook: true,
    });

    // The SAME audience, applied to everything else. Movies and series used to be
    // gated on `hide_streams` alone, so a user who narrowed their audience to one
    // group still had their whole watch history visible to every account on the
    // instance — the one place "your audience" did not mean what the Privacy page
    // implies it means.
    //
    // `audiobook: false` because `share_audiobook_activity` is audiobook-specific;
    // this arm still applies the audience, `hide_streams`, liveness, per-item
    // opt-out and catalogue dismissal.
    //
    // This was previously blocked: with only `SOCIAL_TRUST_GROUPS`, an install that
    // never configured a circle resolved to `AND false`, so routing movies through
    // the predicate would have blanked the Community tab everywhere. The `auto`
    // audience mode removed that — no groups now means household, not dark. What
    // remains is deliberate: an operator who explicitly selects "Selected groups"
    // and names none has said "nobody shares", and movies obey that like everything
    // else. The admin panel warns when the audience resolves to nobody.
    const generalVisibility = buildSocialVisibilityFilter(sql, {
        viewerId: currentUser,
        media: mediaId,
        subjectAlias: 'u_soc',
        tier: 'ambient',
        trustGroups: options.trustGroups,
        audienceMode: options.audienceMode,
        audiobook: false,
    });

    // The `media_items` read below is a media_type LOOKUP, not a catalogue read:
    // it decides which privacy tier applies and can only ever REMOVE rows from
    // the result. The access gate for the item itself is the caller's —
    // `defs/catalog/media-id-viewers.ts` runs `resolveCatalogInternalId` then
    // `checkMediaAccess` before reaching here, per the three-tier rule that
    // queries never gate and routes do.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- media_type lookup only; caller gates (see comment above)
    return await sql<ViewerRow[]>`
        SELECT
            uwh.user_id,
            -- BTRIM before NULLIF: a display_name of '   ' is not empty by
            -- string equality, so it passed straight through and rendered as a
            -- blank name on a living-room screen.
            -- Never fall back to users.username here. This payload is rendered
            -- on shared screens and the login handle is an authentication
            -- identifier, not a display label. NULL lets clients render their
            -- own localized anonymous-user fallback without exposing it.
            NULLIF(BTRIM(u_priv.display_name, ${BLANK_NAME_CHARS}), '') as display_name,
            1 as play_count,
            uwh.last_watched_at as last_played_at,
            FALSE as is_favorite,
            urv.rating,
            urv.rating_style,
            COUNT(*) OVER ()::int as total_count
        FROM user_media_state uwh
        JOIN users u_priv ON u_priv.id = uwh.user_id
        LEFT JOIN user_ratings urv ON (
            uwh.user_id = urv.user_id
            AND uwh.media_id = urv.media_id
        )
        WHERE uwh.media_id = ${mediaId}
            AND uwh.is_watched = true
            AND uwh.user_id != ${currentUser}::uuid
            AND (u_priv.hide_streams IS NULL OR u_priv.hide_streams = false)
            -- The audience gate, in two arms by media type. Both arms apply the
            -- same audience; only the audiobook arm additionally requires the
            -- audiobook-wide sharing switch on both sides.
            --
            -- A missing media_items row takes the general arm rather than falling
            -- through ungated: an id whose catalogue row vanished is not a reason
            -- to widen who can see it. That is the one behaviour change here
            -- beyond the audience itself — the previous "not an audiobook OR ..."
            -- shape let such a row skip the check entirely.
            AND (
                CASE
                    WHEN EXISTS (
                        SELECT 1 FROM media_items mi_tier
                        WHERE mi_tier.id = uwh.media_id
                          AND mi_tier.media_type = 'audiobook'
                    ) THEN EXISTS (
                        SELECT 1 FROM users u_soc
                        WHERE u_soc.id = uwh.user_id
                        ${audiobookVisibility}
                    )
                    ELSE EXISTS (
                        SELECT 1 FROM users u_soc
                        WHERE u_soc.id = uwh.user_id
                        ${generalVisibility}
                    )
                END
            )
        ORDER BY uwh.last_watched_at DESC NULLS LAST
        LIMIT ${limit}
    `;
}

/**
 * Get the current user's own watch state + rating for a media item in one
 * query — used by the viewers endpoint instead of a self-scan over the
 * (now self-excluding) viewer rows.
 */
export async function getCurrentUserWatchState(
    sql: postgres.Sql,
    mediaId: string,
    userId: UserId,
): Promise<{ watched: boolean; rating: number | null }> {
    const rows = await sql<{ watched: boolean; rating: number | null }[]>`
        SELECT COALESCE(uwh.is_watched, false) as watched, urv.rating
        FROM (SELECT 1) dummy
        LEFT JOIN user_media_state uwh
            ON uwh.media_id = ${mediaId} AND uwh.user_id = ${userId}::uuid
        LEFT JOIN user_ratings urv
            ON urv.media_id = ${mediaId} AND urv.user_id = ${userId}::uuid
        LIMIT 1
    `;
    return rows[0] ?? { watched: false, rating: null };
}
