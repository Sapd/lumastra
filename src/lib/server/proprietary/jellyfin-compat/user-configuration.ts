// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin `UserConfiguration` language / subtitle fields from Lumastra's
 * playback preferences (`user_playback_preferences`), so Jellyfin apps pick
 * the same default audio and subtitle tracks as the Lumastra player.
 *
 * - `AudioLanguagePreference`: the explicit audio language, else the learned
 *   one, as the ISO 639-2/T code Jellyfin 10.11+ uses (`deu`, `eng`, `fra`, …).
 * - `PlayDefaultAudioTrack`: true unless an explicit audio language is set
 *   (Lumastra then prefers it over the file's default track).
 * - `SubtitleLanguagePreference`: the saved subtitle language (else the
 *   remembered non-forced track's language), ISO 639-2/T; `''` when none.
 * - `SubtitleMode` from subtitles on/off and forced subtitles on/off:
 *   off + forced off → `None`, off + forced on → `OnlyForced`, on with a
 *   language → `Always`, on without one → `Default` (the file's flags).
 * - `EnableNextEpisodeAutoPlay`: the autoplay-next-episode switch.
 *
 * POST /Users/Configuration (below) writes the same fields back; every other
 * UserConfiguration field (grouped folders, view order, …) is accepted and
 * ignored.
 */

import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id';
import type { JellyfinUserConfiguration } from './types';
import {
    getPlaybackPreferences,
    upsertPlaybackPreferences,
    type PlaybackPreferencesRow,
    type PlaybackPreferencesUpsert,
} from '$lib/server/database/queries/user-preferences.queries';
import { isUnknownLanguage, normalizeLanguage, toIso6392T } from '$lib/shared/language-codes';
import { getCultures } from './localization';
import { getParam } from './utils';
import { isOtherUser } from './self-user';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { BODY_TOO_LARGE, readBoundedBodyText } from '$lib/server/utils/bounded-body-reader';
import { jellyfinBadRequest } from './bad-request';

const logger = Logger.for('JellyfinCompat:UserConfiguration');

export type JellyfinSubtitleMode = 'Default' | 'Always' | 'OnlyForced' | 'None' | 'Smart';

export type UserPlaybackPreferences = Pick<
    PlaybackPreferencesRow,
    | 'audio_language'
    | 'last_audio_language'
    | 'subtitle_language'
    | 'subtitles_enabled'
    | 'forced_subtitles_enabled'
    | 'subtitle_track_hint'
> &
    // Optional so callers holding only the language columns still type-check.
    Partial<Pick<PlaybackPreferencesRow, 'autoplay_next_episode'>>;

type LanguageConfiguration = Pick<
    JellyfinUserConfiguration,
    | 'AudioLanguagePreference'
    | 'PlayDefaultAudioTrack'
    | 'SubtitleLanguagePreference'
    | 'SubtitleMode'
>;

function hintLanguage(hint: unknown): string | null {
    if (!hint || typeof hint !== 'object') return null;
    const h = hint as { language?: unknown; isForced?: unknown };
    return typeof h.language === 'string' && h.isForced !== true ? h.language : null;
}

export function buildLanguageConfiguration(
    prefs: UserPlaybackPreferences | null | undefined,
): LanguageConfiguration {
    const explicitAudio = toIso6392T(prefs?.audio_language);
    const audio = explicitAudio ?? toIso6392T(prefs?.last_audio_language);
    const subtitleLanguage =
        toIso6392T(prefs?.subtitle_language) ??
        toIso6392T(hintLanguage(prefs?.subtitle_track_hint));
    // Column defaults are true for both (user_playback_preferences).
    const subtitlesOn = prefs?.subtitles_enabled ?? true;
    const forcedOn = prefs?.forced_subtitles_enabled ?? true;
    const mode: JellyfinSubtitleMode = !subtitlesOn
        ? forcedOn
            ? 'OnlyForced'
            : 'None'
        : subtitleLanguage
          ? 'Always'
          : 'Default';
    return {
        ...(audio ? { AudioLanguagePreference: audio } : {}),
        PlayDefaultAudioTrack: !explicitAudio,
        SubtitleLanguagePreference: subtitleLanguage ?? '',
        SubtitleMode: mode,
    };
}

/** Every UserConfiguration field backed by playback preferences, as /Users/Me reports it. */
export function reportedPlaybackConfiguration(
    prefs: UserPlaybackPreferences | null | undefined,
): LanguageConfiguration & Pick<JellyfinUserConfiguration, 'EnableNextEpisodeAutoPlay'> {
    return {
        ...buildLanguageConfiguration(prefs),
        EnableNextEpisodeAutoPlay: prefs?.autoplay_next_episode ?? true,
    };
}

const SUBTITLE_MODES = new Set(['Default', 'Always', 'OnlyForced', 'None', 'Smart']);
/** Column width of the language preference columns (see the web app's schema). */
const MAX_LANGUAGE_LENGTH = 20;

function field(body: Record<string, unknown>, name: string): unknown {
    // Jellyfin's JSON binding is case-insensitive.
    const key = Object.keys(body).find((k) => k.toLowerCase() === name.toLowerCase());
    return key === undefined ? undefined : body[key];
}

/** ISO 639-1 where the language has one, else the code as sent (lowercased). */
function toStoredLanguage(code: string): string | null {
    const trimmed = code.trim();
    if (!trimmed || isUnknownLanguage(trimmed)) return null;
    const lower = trimmed.toLowerCase();
    const culture = getCultures().find(
        (c) =>
            c.TwoLetterISOLanguageName === lower || c.ThreeLetterISOLanguageNames.includes(lower),
    );
    const stored = culture?.TwoLetterISOLanguageName || normalizeLanguage(trimmed);
    return stored.slice(0, MAX_LANGUAGE_LENGTH);
}

/** Same language once stored (ger, deu and de are one); absent and '' are "none". */
function sameLanguage(sent: string | null, reported: unknown): boolean {
    const a = sent ? toStoredLanguage(sent) : null;
    const b = typeof reported === 'string' && reported ? toStoredLanguage(reported) : null;
    return a === b;
}

/**
 * The playback-preference update a UserConfiguration body asks for.
 *
 * Apps (jellyfin-web, Findroid, Swiftfin) POST the WHOLE configuration they
 * read from /Users/Me on any change. With `reported` (what /Users/Me currently
 * answers), a field the app merely echoes back is skipped, so an unchanged
 * `SubtitleMode: Default` or `EnableNextEpisodeAutoPlay: true` never turns an
 * unset preference into a stored one (forcing subtitles on, or pinning a value
 * the web app's default would otherwise decide).
 */
export function preferencesFromUserConfiguration(
    body: unknown,
    reported?: Partial<JellyfinUserConfiguration>,
): PlaybackPreferencesUpsert {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) return {};
    const b = body as Record<string, unknown>;
    const update: PlaybackPreferencesUpsert = {};

    const audio = field(b, 'AudioLanguagePreference');
    if (
        (typeof audio === 'string' || audio === null) &&
        !(reported && sameLanguage(audio, reported.AudioLanguagePreference))
    ) {
        update.audioLanguage = audio === null ? null : toStoredLanguage(audio);
    }
    const subtitle = field(b, 'SubtitleLanguagePreference');
    if (
        (typeof subtitle === 'string' || subtitle === null) &&
        !(reported && sameLanguage(subtitle, reported.SubtitleLanguagePreference))
    ) {
        update.subtitleLanguage = subtitle === null ? null : toStoredLanguage(subtitle);
    }
    const mode = field(b, 'SubtitleMode');
    if (
        typeof mode === 'string' &&
        SUBTITLE_MODES.has(mode) &&
        !(reported && mode === reported.SubtitleMode)
    ) {
        if (mode === 'None') {
            update.subtitlesEnabled = false;
            update.forcedSubtitlesEnabled = false;
        } else if (mode === 'OnlyForced') {
            update.subtitlesEnabled = false;
            update.forcedSubtitlesEnabled = true;
        } else {
            update.subtitlesEnabled = true;
        }
    }
    const autoplay = field(b, 'EnableNextEpisodeAutoPlay');
    if (
        typeof autoplay === 'boolean' &&
        !(reported && autoplay === reported.EnableNextEpisodeAutoPlay)
    ) {
        update.autoplayNextEpisode = autoplay;
    }
    return update;
}

export async function applyUserConfiguration(
    sql: postgres.Sql,
    userId: UserId,
    body: unknown,
): Promise<void> {
    const reported = reportedPlaybackConfiguration(
        await getPlaybackPreferences.one(sql, { userId }),
    );
    const update = preferencesFromUserConfiguration(body, reported);
    if (Object.keys(update).length === 0) return;
    await upsertPlaybackPreferences(sql, userId, update);
}

/** Largest UserConfiguration body read (real ones are well under 4 KB). */
const MAX_CONFIGURATION_BODY_BYTES = 64 * 1024;

/**
 * POST /Users/Configuration?userId= and the legacy /Users/{userId}/Configuration
 * (Jellyfin UserController.UpdateUserConfiguration): 204 on success, 400 for a
 * body that is no JSON object, 403 when `userId` names someone else.
 */
export async function handleUpdateUserConfiguration(event: RequestEvent): Promise<Response> {
    const requested = event.params.userId ?? getParam(event.url, 'UserId');
    if (isOtherUser(requested, event.locals.user.userId)) {
        return ApiResponses.forbidden('User is not allowed to update the configuration.');
    }
    const text = await readBoundedBodyText(event.request, MAX_CONFIGURATION_BODY_BYTES);
    if (text === BODY_TOO_LARGE) return ApiResponses.payloadTooLarge();
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return jellyfinBadRequest('Body must be a UserConfiguration (JSON)');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return jellyfinBadRequest('Body must be a UserConfiguration (JSON)');
    }

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    try {
        await applyUserConfiguration(sql, event.locals.user.userId, body);
    } catch (err) {
        logger.error('User configuration update failed', err as Error);
        return ApiResponses.error('Failed to update the configuration');
    }
    return new Response(null, { status: 204 });
}
