// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// OpenSubsonic Compatibility Layer — Transcode session helper
//
// Shared helper for upserting the play_sessions row that the music
// transcode service requires for FK satisfaction on active_transcode_jobs.
// Used by both the legacy `/stream` route (handlers/stream.ts) and the
// OpenSubsonic transcoding-extension `getTranscodeStream` handler
// (handlers/transcode.ts).
//
// Keying contract: `source_session_id = ${authUserId}:${trackId}` — the
// BARE scrobble-style key, intentionally identical to the one
// `handleScrobble` and the now-playing presence refresh use. Note: the
// key uses `auth.userId` (the users.id UUID), NOT the username — this
// matches what handleScrobble writes at ratings.ts:195 and what
// /api/scrobble's playback.ts writes at line 54. Since migration 16.46.0
// the play_sessions `user_id` column itself is `uuid REFERENCES users(id)`,
// so it ALSO stores the users.id UUID (authUserId) — never the username.
// That makes the transcode upsert MERGE INTO the scrobble's "direct"
// row, flipping its `play_method` to `audio_transcode` and adding
// container/bitrate/codec metadata. Result: one play_sessions row per
// (user, track), so admin/sessions surfaces the transcode metadata
// alongside the playback presence — no orphaned COMPLETED twin.
//
// Concurrency: same (user, track) streamed in parallel collapses to one
// row, same as scrobble. Per-stream in-memory state in
// MusicTranscodeService is keyed by a separate per-request `streamId`
// (UUID minted in service.streamFor), so concurrent streams don't alias
// each other's cancellers / slot releases / finalize guards.

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id';
import {
    upsertExternalSession,
    stopOtherActiveMusicSessions,
    type PlaySessionSource,
} from '$lib/server/database/queries/play-sessions.queries.js';
import type { MusicCodec } from '$lib/server/services/music-transcode/types.js';
import type { PlaySurface } from '$lib/server/api/play-surface.js';
import { Logger } from '$lib/server/utils/logger.js';
import { registerSubsonicDevice } from './device-registration.js';

const logger = Logger.for('SubsonicCompat');

export interface UpsertTranscodeSessionArgs {
    sql: postgres.Sql;
    /**
     * users.id UUID. Used to derive `source_session_id` so the key
     * matches what scrobble (ratings.ts:195) and playback (playback.ts:54)
     * write — `${authUserId}:${trackId}`. Without this, the transcode
     * row diverges from the scrobble row and admin/sessions shows two
     * entries for the same playback.
     */
    authUserId: UserId;
    clientName: string | null;
    trackId: string;
    codec: MusicCodec;
    bitrateKbps: number;
    /** Seconds. */
    timeOffset: number;
    /**
     * play_sessions.source value. Defaults to 'subsonic' for backward-
     * compatibility. Pass 'music' for the native API endpoint.
     */
    source?: PlaySessionSource;
    /**
     * play_sessions.surface value. REQUIRED, and deliberately WITHOUT the
     * backward-compatible default `source` above carries.
     *
     * This helper is not subsonic-only: the native music endpoint
     * (music-transcode/route-handler.ts) calls it too, for OUR OWN player. A
     * default of 'subsonic' here would file every first-party music listen as
     * third-party Subsonic traffic, and because `surface` is forward-only that
     * mislabel could never be repaired. Each caller states what it is.
     */
    surface: PlaySurface;
}

/**
 * Upsert the play_sessions row keyed by
 * `(source, source_session_id=${userId}:${trackId})` — the same bare key
 * the scrobble path uses. The first transcode request for a (user, track)
 * merges into the scrobble row (or creates it), flipping `play_method`
 * to `audio_transcode` and stamping container/bitrate/codec metadata.
 *
 * Returns the play_sessions.id (UUID) on success, or null when the upsert
 * fails. Callers should treat null as "fall back to direct-play or fail
 * the request" — the helper does not throw.
 *
 * Note: `upsertExternalSession` ON CONFLICT updates `play_method` (via
 * COALESCE(EXCLUDED.play_method, play_sessions.play_method)). Because we
 * pass a non-null `play_method: 'audio_transcode'` here, the COALESCE
 * picks the new value and the scrobble's `'direct'` is overwritten.
 */
export async function upsertTranscodeSession(
    args: UpsertTranscodeSessionArgs,
): Promise<string | null> {
    const { sql, authUserId, clientName, trackId, codec, bitrateKbps, timeOffset } = args;
    const source = args.source ?? 'subsonic';
    // Bare scrobble-style key. Identical to handleScrobble (ratings.ts:195)
    // and playback.ts:54, so this upsert MERGES into the scrobble row
    // rather than creating a twin.
    const sourceSessionId = `${authUserId}:${trackId}`;
    try {
        const { row } = await upsertExternalSession(sql, {
            source,
            surface: args.surface,
            source_session_id: sourceSessionId,
            media_id: trackId,
            user_id: authUserId,
            device_id: `${source}-${authUserId}`,
            client_name: clientName || 'Subsonic',
            status: 'ACTIVE',
            position_ms: timeOffset * 1000,
            play_method: 'audio_transcode',
            audio_codec: codec,
            // Container, not codec: 'm4a' is AAC-in-MP4 and must not be
            // recorded as mp3 just because it falls off the end of a chain.
            container:
                codec === 'opus'
                    ? 'ogg'
                    : codec === 'aac'
                      ? 'adts'
                      : codec === 'm4a'
                        ? 'mp4'
                        : 'mp3',
            bitrate_kbps: bitrateKbps,
        });
        await registerSubsonicDevice(sql, authUserId, clientName, source);
        // Close any prior music session that wasn't explicitly stopped —
        // covers headless clients that stream without scrobbling.
        const closed = await stopOtherActiveMusicSessions(sql, authUserId, source, sourceSessionId);
        if (closed.length > 0) {
            logger.debug('Closed superseded music sessions on transcode start', {
                userId: authUserId,
                newTrackId: trackId,
                closedCount: closed.length,
                closedIds: closed.map((c) => c.id),
            });
        }
        return row.id;
    } catch (err) {
        logger.error(
            'Failed to upsert play_sessions row for music transcode',
            err instanceof Error ? err : new Error(String(err)),
            { trackId },
        );
        return null;
    }
}
