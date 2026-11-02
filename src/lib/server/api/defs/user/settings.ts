// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/settings.ts — GET /user/settings
 *
 * Composite endpoint: returns all user preferences in a single response by
 * querying all preference sources in parallel (profile comes from locals).
 *
 * Response: bare object containing:
 *   searchPreference, widgetOrder, playbackPreferences, streamPrivacy, profile
 *
 * Auth: {kind:'user'} — self-scoped.
 * Errors: problem+json, incl. 503 dependency_unavailable on DB-down.
 */

import { json } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getWidgetOrder, getPlaybackPreferences } from '$lib/server/database/queries/index.js';
import type { SubtitleStyleSettings } from '$lib/schemas/user.js';
import { callerPermissions } from '$lib/schemas/server-info.js';

export const def = defineEndpoint({
    auth: { kind: 'user' },
    handlers: {
        /**
         * GET /user/settings
         *
         * Fetches all user preference groups in parallel and returns them as a
         * single composite object. Individual preference endpoints remain
         * available for granular updates (PATCH/PUT/POST).
         */
        GET: async (event, _ctx) => {
            const user = event.locals.principal ?? event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const { userId, username } = user;

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            // Run all DB queries in parallel (profile comes from locals)
            const [searchRow, widgetRow, playbackRow, streamRow] = await Promise.all([
                sql<{ fulltext_search?: boolean }[]>`
                    SELECT fulltext_search
                    FROM user_search_preferences
                    WHERE user_id = ${userId}::uuid
                `,
                getWidgetOrder.one(sql, { userId }),
                getPlaybackPreferences.one(sql, { userId }),
                sql<{ hide_streams?: boolean }[]>`
                    SELECT hide_streams
                    FROM users
                    WHERE username = ${username}
                `,
            ]);

            // Parse subtitle style if present
            let subtitleStyle: SubtitleStyleSettings | null = null;
            if (playbackRow?.subtitle_style) {
                try {
                    subtitleStyle =
                        typeof playbackRow.subtitle_style === 'string'
                            ? (JSON.parse(playbackRow.subtitle_style) as SubtitleStyleSettings)
                            : (playbackRow.subtitle_style as SubtitleStyleSettings);
                } catch {
                    // best-effort: corrupt stored subtitle_style JSON → omit (client falls back to defaults)
                    subtitleStyle = null;
                }
            }

            return json(
                {
                    searchPreference: {
                        fulltextSearch: searchRow[0]?.fulltext_search ?? false,
                    },
                    widgetOrder: {
                        widgetOrder: widgetRow?.widget_order ?? null,
                        hiddenWidgets: widgetRow?.hidden_widgets ?? [],
                    },
                    playbackPreferences: {
                        audioLanguage: playbackRow?.audio_language ?? null,
                        subtitleLanguage: playbackRow?.subtitle_language ?? null,
                        subtitlesEnabled: playbackRow?.subtitles_enabled ?? true,
                        forcedSubtitlesEnabled: playbackRow?.forced_subtitles_enabled ?? true,
                        subtitleStyle,
                        qualityMode: playbackRow?.quality_mode || 'original',
                        maxBitrateBps: playbackRow?.max_bitrate ?? null,
                        preferredResolution: playbackRow?.preferred_resolution ?? null,
                        nextEpisodeCountdownSecondsDefault: config.NEXT_EPISODE_COUNTDOWN_SECONDS,
                        autoplayNextEpisode: playbackRow?.autoplay_next_episode ?? true,
                        skipIntroAutomatically: playbackRow?.skip_intro_automatically ?? false,
                        skipCreditsAutomatically: playbackRow?.skip_credits_automatically ?? false,
                        showEpisodeLanguages: playbackRow?.show_episode_languages ?? true,
                        showAnnotationMarkers: playbackRow?.show_annotation_markers ?? true,
                        autoShowAnnotations: playbackRow?.auto_show_annotations ?? true,
                        musicCrossfadeEnabled: playbackRow?.music_crossfade_enabled ?? true,
                        musicAlwaysShowBeatPulse:
                            playbackRow?.music_always_show_beat_pulse ?? false,
                        musicCrossfadeBeats: playbackRow?.music_crossfade_beats ?? null,
                        musicAutoplayEnabled: playbackRow?.music_autoplay_enabled ?? true,
                        updatedAt: playbackRow?.updated_at
                            ? new Date(playbackRow.updated_at).toISOString()
                            : undefined,
                    },
                    streamPrivacy: {
                        hideFromOthers: streamRow[0]?.hide_streams ?? true,
                    },
                    profile: {
                        username,
                        isAdmin: event.locals.principal?.isAdmin === true,
                        isAgeRestricted: event.locals.user?.isAgeRestricted ?? false,
                        permissions: callerPermissions(event.locals.user),
                        groups: event.locals.user?.userGroups ?? [],
                    },
                },
                { headers: { 'Cache-Control': 'private, max-age=300' } },
            );
        },
    },
});
