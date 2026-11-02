// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Profile Preferences Query Module
 *
 * Narrow slice of `user_profiles.preferences` (jsonb) — the
 * "include my watch history" toggle for the taste profile.
 *
 * Deliberately separate from `user-preferences.queries.ts`, which covers
 * `user_widget_order` / `user_playback_preferences` / `user_feed_preferences`
 * — different tables entirely. This module reads/writes the AI profile's own
 * `user_profiles.preferences` blob, which `UserProfileService` also rewrites
 * wholesale on every rebuild — see `getIncludeWatchHistoryPreference`'s
 * doc comment for why the builder must re-persist the flag on every write.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';

/**
 * Whether the user's taste profile should fold watch-history signals
 * (watch-only items, and the watched-boost portion of watched+rated weight)
 * into the positive centroid.
 *
 * Defaults to `true` — only an EXPLICIT stored `'false'` string disables it.
 * A missing row, missing key, or any other value all mean "included". This
 * mirrors the brief's contract precisely so a malformed/legacy preferences
 * blob never silently disables watch history.
 */
export async function getIncludeWatchHistoryPreference(
    sql: postgres.Sql,
    userId: UserId,
): Promise<boolean> {
    const [row] = await sql<{ value: string | null }[]>`
        SELECT preferences ->> 'includeWatchHistory' AS value
        FROM user_profiles
        WHERE user_id = ${userId}
    `;
    return row?.value !== 'false';
}

/**
 * Persist the includeWatchHistory toggle into `user_profiles.preferences`,
 * merging into (not clobbering) whatever else is already stored there.
 * Upserts the anchor row so this is safe to call before any rating/watch
 * activity has created one (mirrors `ensureUserProfileExists`).
 *
 * Note: `UserProfileService.createEnhancedUserProfile` REWRITES `preferences`
 * wholesale on every rebuild (genres/created_from/etc. are rebuilt fresh each
 * time, not merged) — it re-reads this flag via
 * `getIncludeWatchHistoryPreference` and re-includes it in what it writes, so
 * the toggle survives a rebuild triggered here (and every later one, e.g. a
 * rating-milestone rebuild) without this function's merge being undone.
 */
export async function setIncludeWatchHistoryPreference(
    sql: postgres.Sql,
    userId: UserId,
    includeWatchHistory: boolean,
): Promise<void> {
    await sql`
        INSERT INTO user_profiles (user_id, preferences, updated_at)
        VALUES (${userId}, ${sql.json({ includeWatchHistory })}, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
            preferences = COALESCE(user_profiles.preferences, '{}'::jsonb)
                || jsonb_build_object('includeWatchHistory', ${includeWatchHistory}),
            updated_at = NOW()
    `;
}
