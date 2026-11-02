// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/playback-preferences.ts — GET /me/playback-preferences +
 *                                     PATCH /me/playback-preferences
 *
 * Auth: {kind:'user'} — self-scoped, no {id} param.
 * Errors: problem+json.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { config } from '$lib/server/config.js';
import { playbackPreferencesSchema } from '$lib/schemas/user.js';
import { normalizeLanguageTag } from '$lib/shared/metadata-language.js';
import { z } from 'zod';
import {
    getPlaybackPreferences,
    upsertPlaybackPreferences,
    PLAYBACK_PREF_COLUMNS,
} from '$lib/server/database/queries/user-preferences.queries.js';
import { upsertOrderedPlaybackPreferences } from '$lib/server/database/queries/ordered-playback-preferences.queries';
import { PlaybackPreferencesResponseSchema } from '$lib/schemas/api-user-responses';

const logger = Logger.for('PlaybackPrefsDef');

// ---------------------------------------------------------------------------
// Default preferences
// ---------------------------------------------------------------------------

const DEFAULT_PREFERENCES = {
    audioLanguage: null as string | null,
    lastAudioLanguage: null as string | null,
    preferOriginalAudio: false,
    subtitleLanguage: null as string | null,
    subtitlesEnabled: true,
    forcedSubtitlesEnabled: true,
    subtitleStyle: null as unknown,
    subtitleTrackHint: null as unknown,
    qualityMode: 'original' as string,
    maxBitrateBps: null as number | null,
    preferredResolution: null as string | null,
    autoplayNextEpisode: true,
    skipIntroAutomatically: false,
    skipCreditsAutomatically: false,
    showEpisodeLanguages: true,
    showAnnotationMarkers: true,
    autoShowAnnotations: true,
    musicCrossfadeEnabled: true,
    musicCrossfadeBeats: null as number | null,
    musicAutoplayEnabled: true,
    musicShowLoudnessDb: false,
    musicShowBpm: true,
    musicAlwaysShowBeatPulse: false,
    musicLoudnessNormalizationEnabled: true,
    nextEpisodeCountdownSeconds: null as number | null,
    nextEpisodeCountdownSecondsDefault: 10,
    showNextEpisodePopup: true,
    nextEpisodePromptLeadSeconds: null as number | null,
    noOutroFallbackSeconds: null as number | null,
    seekStepSeconds: null as number | null,
    autoDismissNextEpisodePopup: false,
    stillWatchingEnabled: false,
    metadataLanguage: null as string | null,
    metadataTitleLanguage: null as string | null,
};

// ---------------------------------------------------------------------------
// Subtitle style/hint parsers (carried over from the original handler)
// ---------------------------------------------------------------------------

interface SubtitleStyleSettings {
    preset: 'default' | 'outlined' | 'background' | 'shadow' | 'none';
    fontSize: number;
    fontFamily: 'system' | 'serif' | 'mono';
    textColor: string;
    backgroundColor: string;
    outlineColor: string;
    outlineWidth: number;
    shadowBlur: number;
    positionY: number;
}

interface SubtitleTrackHint {
    language: string;
    isForced: boolean;
    codec: string | null;
}

function isSubtitleStyleSettings(value: unknown): value is SubtitleStyleSettings {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    const preset = v.preset;
    const fontFamily = v.fontFamily;
    return (
        (preset === 'default' ||
            preset === 'outlined' ||
            preset === 'background' ||
            preset === 'shadow' ||
            preset === 'none') &&
        typeof v.fontSize === 'number' &&
        (fontFamily === 'system' || fontFamily === 'serif' || fontFamily === 'mono') &&
        typeof v.textColor === 'string' &&
        typeof v.backgroundColor === 'string' &&
        typeof v.outlineColor === 'string' &&
        typeof v.outlineWidth === 'number' &&
        typeof v.shadowBlur === 'number' &&
        typeof v.positionY === 'number'
    );
}

function parseSubtitleStyle(value: unknown): SubtitleStyleSettings | null {
    if (!value) return null;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value) as unknown;
            return isSubtitleStyleSettings(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return isSubtitleStyleSettings(value) ? value : null;
}

function isSubtitleTrackHint(value: unknown): value is SubtitleTrackHint {
    if (typeof value !== 'object' || value === null) return false;
    const v = value as Record<string, unknown>;
    return (
        typeof v.language === 'string' &&
        typeof v.isForced === 'boolean' &&
        (v.codec === null || typeof v.codec === 'string')
    );
}

function parseSubtitleTrackHint(value: unknown): SubtitleTrackHint | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value) as unknown;
            return isSubtitleTrackHint(parsed) ? parsed : null;
        } catch {
            return null;
        }
    }
    return isSubtitleTrackHint(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Row → preferences projection
// ---------------------------------------------------------------------------

function rowToPreferences(
    row: Awaited<ReturnType<typeof upsertPlaybackPreferences>>,
    username: string,
): typeof DEFAULT_PREFERENCES & { updatedAt?: string } {
    if (!row) {
        logger.warn('Null row returned from upsertPlaybackPreferences', { username });
        return { ...DEFAULT_PREFERENCES };
    }
    const subtitleStyle = parseSubtitleStyle(row.subtitle_style);
    if (row.subtitle_style && !subtitleStyle) {
        logger.warn('Failed to parse subtitleStyle', { username });
    }
    return {
        audioLanguage: row.audio_language,
        lastAudioLanguage: row.last_audio_language ?? null,
        preferOriginalAudio: row.prefer_original_audio ?? false,
        subtitleLanguage: row.subtitle_language,
        subtitlesEnabled: row.subtitles_enabled ?? true,
        forcedSubtitlesEnabled: row.forced_subtitles_enabled ?? true,
        subtitleStyle,
        subtitleTrackHint: parseSubtitleTrackHint(row.subtitle_track_hint),
        qualityMode: row.quality_mode || 'original',
        maxBitrateBps: row.max_bitrate,
        preferredResolution: row.preferred_resolution,
        autoplayNextEpisode: row.autoplay_next_episode ?? true,
        skipIntroAutomatically: row.skip_intro_automatically ?? false,
        skipCreditsAutomatically: row.skip_credits_automatically ?? false,
        showEpisodeLanguages: row.show_episode_languages ?? true,
        showAnnotationMarkers: row.show_annotation_markers ?? true,
        autoShowAnnotations: row.auto_show_annotations ?? true,
        musicCrossfadeEnabled: row.music_crossfade_enabled ?? true,
        musicCrossfadeBeats: row.music_crossfade_beats ?? null,
        musicAutoplayEnabled: row.music_autoplay_enabled ?? true,
        musicShowLoudnessDb: row.music_show_loudness_db ?? false,
        musicShowBpm: row.music_show_bpm ?? true,
        musicAlwaysShowBeatPulse: row.music_always_show_beat_pulse ?? false,
        musicLoudnessNormalizationEnabled: row.music_loudness_normalization_enabled ?? true,
        nextEpisodeCountdownSeconds: row.next_episode_countdown_seconds ?? null,
        nextEpisodeCountdownSecondsDefault: config.NEXT_EPISODE_COUNTDOWN_SECONDS,
        showNextEpisodePopup: row.show_next_episode_popup ?? true,
        nextEpisodePromptLeadSeconds: row.next_episode_prompt_lead_seconds ?? null,
        noOutroFallbackSeconds: row.no_outro_fallback_seconds ?? null,
        seekStepSeconds: row.seek_step_seconds ?? null,
        autoDismissNextEpisodePopup: row.auto_dismiss_next_episode_popup ?? false,
        stillWatchingEnabled: row.still_watching_enabled ?? false,
        metadataLanguage: row.metadata_language ?? null,
        metadataTitleLanguage: row.metadata_title_language ?? null,
        updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
    };
}

// ---------------------------------------------------------------------------
// Request contract
// ---------------------------------------------------------------------------

/**
 * PATCH body for user/playback-preferences — lenient mount-gate.
 *
 * playbackPreferencesSchema has an outer .refine("at least one field must be
 * provided") that would fire pre-handler on a valid payload if mount() runs
 * the full schema. To avoid that, mount() validates only that the body is a
 * plain JSON object. The handler then re-parses with the full
 * playbackPreferencesSchema (including the .refine) and applies the
 * presence-preserving partial-update projection.
 *
 * z.looseObject({}) accepts any plain object and passes unknown keys through
 * (no strip) — lenient by design (do NOT use .strict() here). The handler's
 * re-validation with the typed playbackPreferencesSchema is the real contract.
 */
const PlaybackPrefsBodyLenient = z.looseObject({});

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['User'],
            summary: 'Get playback preferences',
            stability: 'stable',
            auth: 'bearer',
            description:
                "Returns the authenticated user's playback preferences. " +
                'Null values indicate unset (falls back to system default).',
            responses: {
                200: {
                    schema: PlaybackPreferencesResponseSchema,
                    description: 'Playback preferences',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PATCH: {
            tags: ['User'],
            summary: 'Update playback preferences',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Upserts playback preferences for the authenticated user. ' +
                'Presence-preserving: only provided fields are written; omitted fields keep existing values. ' +
                'Set a field to `null` to clear it and revert to system default. ' +
                'Optional writeOrder metadata rejects older field edits and retired browser account generations; the response always reflects the persisted preferences.',
            body: playbackPreferencesSchema,
            responses: {
                200: {
                    schema: PlaybackPreferencesResponseSchema,
                    description: 'Updated preferences',
                },
                422: 'Validation failed',
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },
    request: {
        // Lenient body contract: accept any object, strip unknown keys at the
        // top-level record level. The handler re-validates with the full
        // playbackPreferencesSchema (which has the .refine). This avoids the
        // .refine("at least one field") from firing pre-handler on a valid
        // but sparse partial update.
        body: PlaybackPrefsBodyLenient,
    },
    handlers: {
        /**
         * GET /me/playback-preferences
         *
         * Retrieve the authenticated user's playback preferences.
         * Returns defaults when no preferences have been saved.
         */
        GET: async (event, _ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!userId || !username) {
                return ApiProblem.unauthorized();
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            try {
                const row = await getPlaybackPreferences.one(sql, { userId });

                if (!row) {
                    logger.debug('No preferences found, returning defaults', { username });
                    return json({
                        ...DEFAULT_PREFERENCES,
                        nextEpisodeCountdownSecondsDefault: config.NEXT_EPISODE_COUNTDOWN_SECONDS,
                    });
                }

                const subtitleStyle = parseSubtitleStyle(row.subtitle_style);
                if (row.subtitle_style && !subtitleStyle) {
                    logger.warn('Failed to parse subtitleStyle', { username });
                }

                return json({
                    audioLanguage: row.audio_language,
                    lastAudioLanguage: row.last_audio_language ?? null,
                    preferOriginalAudio: row.prefer_original_audio ?? false,
                    subtitleLanguage: row.subtitle_language,
                    subtitlesEnabled: row.subtitles_enabled ?? true,
                    forcedSubtitlesEnabled: row.forced_subtitles_enabled ?? true,
                    subtitleStyle,
                    subtitleTrackHint: parseSubtitleTrackHint(row.subtitle_track_hint),
                    qualityMode: row.quality_mode || 'original',
                    maxBitrateBps: row.max_bitrate,
                    preferredResolution: row.preferred_resolution,
                    autoplayNextEpisode: row.autoplay_next_episode ?? true,
                    skipIntroAutomatically: row.skip_intro_automatically ?? false,
                    skipCreditsAutomatically: row.skip_credits_automatically ?? false,
                    showEpisodeLanguages: row.show_episode_languages ?? true,
                    showAnnotationMarkers: row.show_annotation_markers ?? true,
                    autoShowAnnotations: row.auto_show_annotations ?? true,
                    musicCrossfadeEnabled: row.music_crossfade_enabled ?? true,
                    musicCrossfadeBeats: row.music_crossfade_beats ?? null,
                    musicAutoplayEnabled: row.music_autoplay_enabled ?? true,
                    musicShowLoudnessDb: row.music_show_loudness_db ?? false,
                    musicShowBpm: row.music_show_bpm ?? true,
                    musicAlwaysShowBeatPulse: row.music_always_show_beat_pulse ?? false,
                    musicLoudnessNormalizationEnabled:
                        row.music_loudness_normalization_enabled ?? true,
                    nextEpisodeCountdownSeconds: row.next_episode_countdown_seconds ?? null,
                    nextEpisodeCountdownSecondsDefault: config.NEXT_EPISODE_COUNTDOWN_SECONDS,
                    showNextEpisodePopup: row.show_next_episode_popup ?? true,
                    nextEpisodePromptLeadSeconds: row.next_episode_prompt_lead_seconds ?? null,
                    noOutroFallbackSeconds: row.no_outro_fallback_seconds ?? null,
                    seekStepSeconds: row.seek_step_seconds ?? null,
                    autoDismissNextEpisodePopup: row.auto_dismiss_next_episode_popup ?? false,
                    stillWatchingEnabled: row.still_watching_enabled ?? false,
                    metadataLanguage: row.metadata_language ?? null,
                    metadataTitleLanguage: row.metadata_title_language ?? null,
                    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : undefined,
                });
            } catch (err) {
                logger.error('Failed to get playback preferences', err as Error, { username });
                return ApiProblem.internalError('Failed to retrieve playback preferences');
            }
        },

        /**
         * PATCH /me/playback-preferences
         *
         * Partial-update the user's playback preferences (presence-preserving).
         * PATCH only — no POST alias.
         *
         * The body was already read and parsed to a plain object by mount()
         * (via the PlaybackPrefsBodyLenient schema). We use ctx.input!.body
         * directly instead of re-reading event.request (body stream consumed).
         */
        PATCH: async (event, ctx) => {
            const userId = event.locals.principal?.userId ?? event.locals.user?.userId;
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!userId || !username) {
                return ApiProblem.unauthorized();
            }

            // mount() validated and parsed the body via PlaybackPrefsBodyLenient.
            // Re-validate with the full schema (with the .refine) to preserve
            // field-level error messages and the partial-update projection logic.
            const rawBody: unknown = ctx.input?.body ?? {};
            const parsed = playbackPreferencesSchema.safeParse(rawBody);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            // Metadata language prefs (spec §2): a non-null value must normalize
            // via normalizeLanguageTag AND be in the allowed set = {primary} ∪
            // config.METADATA_ADDITIONAL_LANGUAGES, where primary accepts both the
            // full TMDB_LANGUAGE tag and its bare language part (e.g. en-US → en).
            // The normalized (not raw) tag is what gets stored — downstream lookups
            // key on it case-sensitively.
            const primaryFull = normalizeLanguageTag(config.TMDB_LANGUAGE) ?? config.TMDB_LANGUAGE;
            const primaryBare =
                normalizeLanguageTag(config.TMDB_LANGUAGE.split('-')[0]) ??
                config.TMDB_LANGUAGE.split('-')[0];
            const allowedMetadataLanguages = new Set<string>([
                primaryFull,
                primaryBare,
                ...config.METADATA_ADDITIONAL_LANGUAGES,
            ]);
            for (const field of ['metadataLanguage', 'metadataTitleLanguage'] as const) {
                const raw = parsed.data[field];
                if (raw === null || raw === undefined) continue;
                const normalized = normalizeLanguageTag(raw);
                if (!normalized || !allowedMetadataLanguages.has(normalized)) {
                    return ApiProblem.validationFailed([
                        {
                            field,
                            message: `Must be one of the configured metadata languages: ${[...allowedMetadataLanguages].join(', ')}`,
                        },
                    ]);
                }
                parsed.data[field] = normalized;
            }

            const sql = getDb();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is unavailable');
            }

            const data = parsed.data as Record<string, unknown>;

            // Presence-preserving partial-update: only include a field in the
            // upsert if the client sent it. Undefined (omitted) → leave alone.
            // Explicit null → clear the column.
            type Upsert = Parameters<typeof upsertPlaybackPreferences>[2];
            const upsertPayload: Upsert = {};
            const JSON_SPECIAL_CASE = new Set<string>(['subtitleStyle', 'subtitleTrackHint']);

            for (const key of Object.keys(PLAYBACK_PREF_COLUMNS)) {
                if (JSON_SPECIAL_CASE.has(key)) continue;
                if (Object.hasOwn(data, key)) {
                    (upsertPayload as Record<string, unknown>)[key] = data[key];
                }
            }

            // subtitleStyle → JSON string when present.
            if (Object.hasOwn(data, 'subtitleStyle')) {
                upsertPayload.subtitleStyle =
                    data.subtitleStyle === null || data.subtitleStyle === undefined
                        ? null
                        : JSON.stringify(data.subtitleStyle);
            }

            // subtitleTrackHint → JSON string; mirror language + isForced into
            // scalar columns for back-compat readers when non-null.
            if (Object.hasOwn(data, 'subtitleTrackHint')) {
                const hint = data.subtitleTrackHint;
                upsertPayload.subtitleTrackHint =
                    hint === null || hint === undefined ? null : JSON.stringify(hint);
                if (isSubtitleTrackHint(hint)) {
                    if (!Object.hasOwn(data, 'subtitleLanguage')) {
                        upsertPayload.subtitleLanguage = hint.language;
                    }
                    if (!Object.hasOwn(data, 'forcedSubtitlesEnabled')) {
                        upsertPayload.forcedSubtitlesEnabled = hint.isForced;
                    }
                }
            }

            const writeOrder = parsed.data.writeOrder;
            if (writeOrder?.fields.subtitleTrackHint) {
                // The legacy scalar projection is part of the hint edit, so it
                // must carry the same order. Explicit scalar edits keep theirs.
                for (const field of ['subtitleLanguage', 'forcedSubtitlesEnabled'] as const)
                    if (Object.hasOwn(upsertPayload, field) && !Object.hasOwn(data, field))
                        writeOrder.fields[field] = writeOrder.fields.subtitleTrackHint;
            }
            const row = writeOrder
                ? await upsertOrderedPlaybackPreferences(sql, userId, upsertPayload, writeOrder)
                : await upsertPlaybackPreferences(sql, userId, upsertPayload);

            if (!row) {
                return ApiProblem.internalError('Failed to save preferences');
            }

            logger.info('Playback preferences updated', {
                username,
                qualityMode: row.quality_mode,
            });

            return json(rowToPreferences(row, username));
        },
    },
});
