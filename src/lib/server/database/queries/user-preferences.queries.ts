// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * User Preferences Query Module
 *
 * Centralized queries for user preference tables:
 * - user_widget_order (dashboard widget configuration)
 * - user_playback_preferences (playback settings)
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import { DEFAULT_FEED_PREFS, type FeedMode, type FeedPrefs } from '$lib/shared/feed-section-kinds';
import { defineQuery, defineWriteQuery } from '../typed-query.js';

// =============================================================================
// Types - Widget Order
// =============================================================================

export interface WidgetOrderRow {
    user_id: string;
    widget_order: string[];
    hidden_widgets: string[] | null;
    updated_at: Date;
}

// =============================================================================
// Types - Playback Preferences
// =============================================================================

export interface PlaybackPreferencesRow {
    user_id: string;
    audio_language: string | null;
    last_audio_language: string | null;
    prefer_original_audio: boolean | null;
    subtitle_language: string | null;
    subtitles_enabled: boolean | null;
    forced_subtitles_enabled: boolean | null;
    subtitle_style: unknown; // JSON
    subtitle_track_hint: unknown; // JSONB
    quality_mode: 'original' | 'auto' | 'fixed' | null;
    max_bitrate: number | null;
    preferred_resolution: string | null;
    autoplay_next_episode: boolean | null;
    skip_intro_automatically: boolean | null;
    skip_credits_automatically: boolean | null;
    show_episode_languages: boolean;
    show_annotation_markers: boolean | null;
    auto_show_annotations: boolean | null;
    music_crossfade_enabled: boolean | null;
    music_crossfade_beats: number | null;
    music_autoplay_enabled: boolean | null;
    music_show_loudness_db: boolean | null;
    music_show_bpm: boolean | null;
    music_always_show_beat_pulse: boolean | null;
    music_loudness_normalization_enabled: boolean | null;
    next_episode_countdown_seconds: number | null;
    show_next_episode_popup: boolean | null;
    next_episode_prompt_lead_seconds: number | null;
    no_outro_fallback_seconds: number | null;
    seek_step_seconds: number | null;
    auto_dismiss_next_episode_popup: boolean | null;
    still_watching_enabled: boolean | null;
    metadata_language: string | null;
    metadata_title_language: string | null;
    updated_at: Date | null;
}

// =============================================================================
// Widget Order Queries
// =============================================================================

/**
 * Get widget order for a user.
 */
export const getWidgetOrder = defineQuery<{ userId: UserId }, WidgetOrderRow>(
    'getWidgetOrder',
    (sql, { userId }) => sql`
        SELECT user_id, widget_order, hidden_widgets, updated_at
        FROM user_widget_order
        WHERE user_id = ${userId}
    `,
);

/**
 * Upsert widget order (both order and hidden widgets).
 */
export const upsertWidgetOrderFull = defineWriteQuery<
    { userId: UserId; widgetOrder: string[]; hiddenWidgets: string[] },
    WidgetOrderRow
>(
    'upsertWidgetOrderFull',
    (sql, { userId, widgetOrder, hiddenWidgets }) => sql`
    INSERT INTO user_widget_order (user_id, widget_order, hidden_widgets, updated_at)
    VALUES (${userId}, ${widgetOrder}, ${hiddenWidgets}, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
        widget_order = ${widgetOrder},
        hidden_widgets = ${hiddenWidgets},
        updated_at = NOW()
    RETURNING user_id, widget_order, hidden_widgets, updated_at
`,
);

/**
 * Upsert widget order only (preserves hidden widgets).
 */
export const upsertWidgetOrderOnly = defineWriteQuery<
    { userId: UserId; widgetOrder: string[] },
    WidgetOrderRow
>(
    'upsertWidgetOrderOnly',
    (sql, { userId, widgetOrder }) => sql`
    INSERT INTO user_widget_order (user_id, widget_order, updated_at)
    VALUES (${userId}, ${widgetOrder}, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
        widget_order = ${widgetOrder},
        updated_at = NOW()
    RETURNING user_id, widget_order, hidden_widgets, updated_at
`,
);

/**
 * Upsert hidden widgets only (preserves widget order).
 */
export const upsertHiddenWidgetsOnly = defineWriteQuery<
    { userId: UserId; hiddenWidgets: string[] },
    WidgetOrderRow
>(
    'upsertHiddenWidgetsOnly',
    (sql, { userId, hiddenWidgets }) => sql`
    INSERT INTO user_widget_order (user_id, widget_order, hidden_widgets, updated_at)
    VALUES (${userId}, '{}', ${hiddenWidgets}, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
        hidden_widgets = ${hiddenWidgets},
        updated_at = NOW()
    RETURNING user_id, widget_order, hidden_widgets, updated_at
`,
);

/**
 * Delete ALL users' widget order + hidden-widget rows.
 *
 * Admin "reset to defaults" primitive: clears every per-user override so the
 * server falls back to the admin-configured defaults. The home page SSRs the
 * widget grid from these rows, so deleting them is the whole reset.
 * `RETURNING user_id` lets the caller report how many users were reset.
 */
export const deleteAllWidgetOrder = defineWriteQuery<Record<string, never>, { user_id: string }>(
    'deleteAllWidgetOrder',
    (sql) => sql`
    DELETE FROM user_widget_order
    RETURNING user_id
`,
);

// =============================================================================
// Playback Preferences Queries
// =============================================================================

/**
 * Get playback preferences for a user.
 */
export const getPlaybackPreferences = defineQuery<{ userId: UserId }, PlaybackPreferencesRow>(
    'getPlaybackPreferences',
    (sql, { userId }) => sql`
        SELECT
            user_id,
            audio_language,
            last_audio_language,
            prefer_original_audio,
            subtitle_language,
            subtitles_enabled,
            forced_subtitles_enabled,
            subtitle_style,
            subtitle_track_hint,
            quality_mode,
            max_bitrate,
            preferred_resolution,
            autoplay_next_episode,
            skip_intro_automatically,
            skip_credits_automatically,
            show_episode_languages,
            show_annotation_markers,
            auto_show_annotations,
            music_crossfade_enabled,
            music_crossfade_beats,
            music_autoplay_enabled,
            music_show_loudness_db,
            music_show_bpm,
            music_always_show_beat_pulse,
            music_loudness_normalization_enabled,
            next_episode_countdown_seconds,
            show_next_episode_popup,
            next_episode_prompt_lead_seconds,
            no_outro_fallback_seconds,
            seek_step_seconds,
            auto_dismiss_next_episode_popup,
            still_watching_enabled,
            metadata_language,
            metadata_title_language,
            updated_at
        FROM user_playback_preferences
        WHERE user_id = ${userId}
    `,
);

/**
 * Playback preference fields accepted by the upsert. Only fields actually
 * present on the passed object are written — the distinction between
 * "omitted" and "explicit null" is preserved:
 * - omitted key  → column is not touched (INSERT uses schema default, UPDATE leaves value)
 * - explicit null → column is cleared to NULL (INSERT sets NULL, UPDATE sets NULL)
 *
 * This is required so "turn off subtitles" (subtitleLanguage: null) actually
 * clears the column, while other unrelated fields are preserved.
 */
export interface PlaybackPreferencesUpsert {
    audioLanguage?: string | null;
    lastAudioLanguage?: string | null;
    /** NOT NULL column — no `| null`, an explicit null would raise 23502. */
    preferOriginalAudio?: boolean;
    subtitleLanguage?: string | null;
    subtitlesEnabled?: boolean | null;
    forcedSubtitlesEnabled?: boolean | null;
    subtitleStyle?: string | null; // JSON string
    subtitleTrackHint?: string | null; // JSON string
    qualityMode?: 'original' | 'auto' | 'fixed' | null;
    maxBitrateBps?: number | null;
    preferredResolution?: string | null;
    autoplayNextEpisode?: boolean | null;
    skipIntroAutomatically?: boolean | null;
    skipCreditsAutomatically?: boolean | null;
    showEpisodeLanguages?: boolean;
    showAnnotationMarkers?: boolean | null;
    autoShowAnnotations?: boolean | null;
    musicCrossfadeEnabled?: boolean | null;
    musicCrossfadeBeats?: number | null;
    musicAutoplayEnabled?: boolean | null;
    musicShowLoudnessDb?: boolean | null;
    musicShowBpm?: boolean | null;
    musicAlwaysShowBeatPulse?: boolean | null;
    musicLoudnessNormalizationEnabled?: boolean | null;
    nextEpisodeCountdownSeconds?: number | null;
    showNextEpisodePopup?: boolean | null;
    nextEpisodePromptLeadSeconds?: number | null;
    noOutroFallbackSeconds?: number | null;
    seekStepSeconds?: number | null;
    autoDismissNextEpisodePopup?: boolean | null;
    stillWatchingEnabled?: boolean | null;
    metadataLanguage?: string | null;
    metadataTitleLanguage?: string | null;
}

// Whitelisted camelCase → snake_case column mapping. Anything not listed here
// is rejected — prevents accidental column drift when the payload grows.
// Exported so the HTTP route can derive its passthrough allow-list from the
// same source (finding C-2): adding a preference here automatically makes it
// writable through the API without touching the route.
export const PLAYBACK_PREF_COLUMNS: Record<keyof PlaybackPreferencesUpsert, string> = {
    audioLanguage: 'audio_language',
    lastAudioLanguage: 'last_audio_language',
    preferOriginalAudio: 'prefer_original_audio',
    subtitleLanguage: 'subtitle_language',
    subtitlesEnabled: 'subtitles_enabled',
    forcedSubtitlesEnabled: 'forced_subtitles_enabled',
    subtitleStyle: 'subtitle_style',
    subtitleTrackHint: 'subtitle_track_hint',
    qualityMode: 'quality_mode',
    maxBitrateBps: 'max_bitrate',
    preferredResolution: 'preferred_resolution',
    autoplayNextEpisode: 'autoplay_next_episode',
    skipIntroAutomatically: 'skip_intro_automatically',
    skipCreditsAutomatically: 'skip_credits_automatically',
    showEpisodeLanguages: 'show_episode_languages',
    showAnnotationMarkers: 'show_annotation_markers',
    autoShowAnnotations: 'auto_show_annotations',
    musicCrossfadeEnabled: 'music_crossfade_enabled',
    musicCrossfadeBeats: 'music_crossfade_beats',
    musicAutoplayEnabled: 'music_autoplay_enabled',
    musicShowLoudnessDb: 'music_show_loudness_db',
    musicShowBpm: 'music_show_bpm',
    musicAlwaysShowBeatPulse: 'music_always_show_beat_pulse',
    musicLoudnessNormalizationEnabled: 'music_loudness_normalization_enabled',
    nextEpisodeCountdownSeconds: 'next_episode_countdown_seconds',
    showNextEpisodePopup: 'show_next_episode_popup',
    nextEpisodePromptLeadSeconds: 'next_episode_prompt_lead_seconds',
    noOutroFallbackSeconds: 'no_outro_fallback_seconds',
    seekStepSeconds: 'seek_step_seconds',
    autoDismissNextEpisodePopup: 'auto_dismiss_next_episode_popup',
    stillWatchingEnabled: 'still_watching_enabled',
    metadataLanguage: 'metadata_language',
    metadataTitleLanguage: 'metadata_title_language',
};

/**
 * Upsert playback preferences with presence-preserving partial update.
 *
 * Only fields actually present on `preferences` (via Object.hasOwn) are
 * written. Explicit null clears the column; omission leaves it untouched.
 * All values and column identifiers go through postgres.js's `sql(obj, keys)`
 * helper — no dynamic string concatenation reaches SQL.
 */
export async function upsertPlaybackPreferences(
    sql: postgres.Sql,
    userId: UserId,
    preferences: PlaybackPreferencesUpsert,
): Promise<PlaybackPreferencesRow | null> {
    // Build a snake_case row object from present entries only.
    // Distinguishes "omitted" (absent key) from "explicit null" (present, value = null).
    // Type widened to `postgres.ParameterOrJSON<never>` so postgres.js's
    // `sql(obj, keys)` helper accepts it — the helper's generic signature
    // intersects with `Record<string, any>`, which `Record<string, unknown>`
    // does not satisfy.
    const row: Record<string, postgres.ParameterOrJSON<never>> = {
        user_id: userId,
    };
    const updateColumns: string[] = [];
    for (const key of Object.keys(PLAYBACK_PREF_COLUMNS) as Array<
        keyof PlaybackPreferencesUpsert
    >) {
        if (!Object.hasOwn(preferences, key)) continue;
        const value = preferences[key];
        if (value === undefined) continue;
        const col = PLAYBACK_PREF_COLUMNS[key];
        row[col] = value as postgres.ParameterOrJSON<never>;
        updateColumns.push(col);
    }

    if (updateColumns.length === 0) {
        // Nothing to write — upsert the anchor row only and bump updated_at.
        const rows = await sql<PlaybackPreferencesRow[]>`
            INSERT INTO user_playback_preferences (user_id)
            VALUES (${userId})
            ON CONFLICT (user_id) DO UPDATE SET updated_at = NOW()
            RETURNING
                user_id,
                audio_language,
                last_audio_language,
                prefer_original_audio,
                subtitle_language,
                subtitles_enabled,
                forced_subtitles_enabled,
                subtitle_style,
                subtitle_track_hint,
                quality_mode,
                max_bitrate,
                preferred_resolution,
                autoplay_next_episode,
                skip_intro_automatically,
                skip_credits_automatically,
                show_episode_languages,
                show_annotation_markers,
                auto_show_annotations,
                music_crossfade_enabled,
                music_crossfade_beats,
                music_autoplay_enabled,
                music_show_loudness_db,
                music_show_bpm,
                music_always_show_beat_pulse,
                music_loudness_normalization_enabled,
                next_episode_countdown_seconds,
                show_next_episode_popup,
                next_episode_prompt_lead_seconds,
                no_outro_fallback_seconds,
                seek_step_seconds,
                auto_dismiss_next_episode_popup,
                still_watching_enabled,
                metadata_language,
                metadata_title_language,
                updated_at
        `;
        return rows[0] ?? null;
    }

    const insertColumns = ['user_id', ...updateColumns];

    const rows = await sql<PlaybackPreferencesRow[]>`
        INSERT INTO user_playback_preferences ${sql(row, insertColumns)}
        ON CONFLICT (user_id) DO UPDATE SET
            ${sql(row, updateColumns)},
            updated_at = NOW()
        RETURNING
            user_id,
            audio_language,
            last_audio_language,
            prefer_original_audio,
            subtitle_language,
            subtitles_enabled,
            forced_subtitles_enabled,
            subtitle_style,
            subtitle_track_hint,
            quality_mode,
            max_bitrate,
            preferred_resolution,
            autoplay_next_episode,
            skip_intro_automatically,
            skip_credits_automatically,
            show_episode_languages,
            show_annotation_markers,
            auto_show_annotations,
            music_crossfade_enabled,
            music_crossfade_beats,
            music_autoplay_enabled,
            music_show_loudness_db,
            music_show_bpm,
            music_always_show_beat_pulse,
            music_loudness_normalization_enabled,
            next_episode_countdown_seconds,
            show_next_episode_popup,
            next_episode_prompt_lead_seconds,
            no_outro_fallback_seconds,
            seek_step_seconds,
            auto_dismiss_next_episode_popup,
            still_watching_enabled,
            metadata_language,
            metadata_title_language,
            updated_at
    `;

    return rows[0] ?? null;
}

// =============================================================================
/**
 * Delete playback preferences for a user.
 */
export const deletePlaybackPreferences = defineWriteQuery<{ userId: UserId }, { user_id: string }>(
    'deletePlaybackPreferences',
    (sql, { userId }) => sql`
        DELETE FROM user_playback_preferences
        WHERE user_id = ${userId}
        RETURNING user_id
    `,
);

// =============================================================================
// Types - Feed Preferences (For You feed section visibility)
// =============================================================================

export interface FeedPreferencesRow {
    user_id: string;
    feed_mode: FeedMode;
    hidden_section_kinds: string[];
    updated_at: Date;
}

// =============================================================================
// Feed Preferences Queries
// =============================================================================

/**
 * Get For You feed preferences for a user. Returns no row when the user has
 * never customised their feed — callers default to "full" (show everything).
 */
export const getFeedPreferences = defineQuery<{ userId: UserId }, FeedPreferencesRow>(
    'getFeedPreferences',
    (sql, { userId }) => sql`
        SELECT user_id, feed_mode, hidden_section_kinds, updated_at
        FROM user_feed_preferences
        WHERE user_id = ${userId}
    `,
);

/**
 * Upsert feed preferences (mode + hidden kinds together). The single home-page
 * form saves both at once, so a full upsert is sufficient (mirrors
 * `upsertWidgetOrderFull`). Callers MUST sanitise `hiddenSectionKinds`
 * (drop unknown kinds + strip essentials) before persisting.
 */
export const upsertFeedPreferencesFull = defineWriteQuery<
    { userId: UserId; feedMode: FeedMode; hiddenSectionKinds: string[] },
    FeedPreferencesRow
>(
    'upsertFeedPreferencesFull',
    (sql, { userId, feedMode, hiddenSectionKinds }) => sql`
    INSERT INTO user_feed_preferences (user_id, feed_mode, hidden_section_kinds, updated_at)
    VALUES (${userId}, ${feedMode}, ${hiddenSectionKinds}, NOW())
    ON CONFLICT (user_id)
    DO UPDATE SET
        feed_mode = ${feedMode},
        hidden_section_kinds = ${hiddenSectionKinds},
        updated_at = NOW()
    RETURNING user_id, feed_mode, hidden_section_kinds, updated_at
`,
);

/**
 * Load a user's feed preferences as the lightweight {@link FeedPrefs} shape used
 * by the visibility predicate. Always resolves to a value: no row, no DB, or any
 * error yields the back-compat default ("full" = show everything) so feed
 * rendering never breaks on a preferences read.
 */
export async function loadFeedPrefsForUser(
    sql: postgres.Sql | null | undefined,
    userId: UserId | null | undefined,
): Promise<FeedPrefs> {
    if (!sql || !userId) return DEFAULT_FEED_PREFS;
    try {
        const row = await getFeedPreferences.one(sql, { userId });
        if (!row) return DEFAULT_FEED_PREFS;
        return {
            mode: row.feed_mode,
            hiddenKinds: row.hidden_section_kinds ?? [],
        };
    } catch {
        return DEFAULT_FEED_PREFS;
    }
}
