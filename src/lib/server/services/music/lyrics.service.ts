// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lyrics resolution service — shared by the web UI and OpenSubsonic handlers.
 *
 * Request-path callers (GET /api/music/tracks/{id}/lyrics, getLyricsBySongId)
 * use readStoredLyrics(), which serves strictly from DB custom_metadata and
 * never touches LRCLIB.
 *
 * Background fetching is handled by the lyrics-lrclib-fetch scheduled task,
 * which calls resolveLyrics() in bulk (gated by FEATURE_MUSIC_LYRICS_FETCH
 * + FEATURE_AUTO_LYRICS).
 */

import type postgres from 'postgres';
import type { TrackDetailRow } from '$lib/server/database/queries/music.queries.js';
import {
    getLyrics,
    type LrcLibResult,
} from '$lib/server/providers/implementations/musicbrainz/lrclib.js';
import { features } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { writeLyricsSidecar } from '$lib/server/utils/music-scanner-utils.js';
import { findMediaFilePathForTrack } from '$lib/server/database/queries/media-files.queries.js';

const logger = Logger.for('LyricsService');

export interface ResolvedLyrics {
    plain: string | null;
    synced: string | null;
    source: string | null;
    fetchedAt: string | null;
}

interface StoredLyrics {
    plain?: string | null;
    synced?: string | null;
    source?: string;
    fetchedAt?: string;
}

interface LyricsRetry {
    attempts: number;
    nextRetryAt: string;
}

function readRetry(track: TrackDetailRow): LyricsRetry | null {
    const raw = track.custom_metadata?.lyricsRetry;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (!('attempts' in raw) || !('nextRetryAt' in raw)) return null;
    const { attempts, nextRetryAt } = raw;
    return typeof attempts === 'number' &&
        Number.isFinite(attempts) &&
        attempts >= 0 &&
        typeof nextRetryAt === 'string' &&
        Number.isFinite(Date.parse(nextRetryAt))
        ? { attempts: Math.floor(attempts), nextRetryAt }
        : null;
}

/** This global sweep has no per-track stage row. Keep retry state beside lyrics. */
async function recordRetry(
    sql: postgres.Sql,
    track: TrackDetailRow,
    failure: unknown,
): Promise<void> {
    const previous = readRetry(track);
    const attempts = (previous?.attempts ?? 0) + 1;
    const backoffMs = Math.min(24, 2 ** Math.min(attempts - 1, 5)) * 3_600_000;
    const hint =
        failure && typeof failure === 'object' && 'retryAfterMs' in failure
            ? failure.retryAfterMs
            : undefined;
    const delay =
        typeof hint === 'number' && Number.isFinite(hint) && hint >= 0
            ? Math.max(backoffMs, hint)
            : backoffMs;
    const status =
        failure &&
        typeof failure === 'object' &&
        'status' in failure &&
        typeof failure.status === 'number'
            ? failure.status
            : undefined;
    const retry = {
        attempts,
        ...(status !== undefined && { status }),
        failedAt: new Date().toISOString(),
        nextRetryAt: new Date(Date.now() + delay).toISOString(),
    };
    await sql`
        UPDATE media_items
        SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) || ${sql.json({ lyricsRetry: retry })}
        WHERE id = ${track.id} AND media_type = 'track'
          AND custom_metadata->'lyrics' IS NULL
    `;
}

function readStored(track: TrackDetailRow): StoredLyrics | null {
    const raw = track.custom_metadata?.lyrics;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw;
}

/**
 * Persist user-supplied lyrics for a track. Merges the given lyrics payload
 * into the track's `custom_metadata` JSONB field. This is the sole write
 * path for manual/user-provided lyrics; auto-fetched lyrics use the same
 * JSONB merge inside `resolveLyrics`.
 */
export async function saveUserLyrics(
    sql: postgres.Sql,
    trackId: string,
    lyricsPayload: {
        plain: string | null | undefined;
        synced: string | null | undefined;
        format?: string | null;
        source: string;
        fetchedAt: string | null | undefined;
    },
): Promise<void> {
    await sql`
        UPDATE media_items
        SET custom_metadata = (COALESCE(custom_metadata, '{}'::jsonb) - 'lyricsRetry') || ${sql.json(
            {
                lyrics: lyricsPayload,
            },
        )}
        WHERE id = ${trackId}
          AND media_type = 'track'
    `;
}

/**
 * Serve stored lyrics for a track from DB custom_metadata only.
 *
 * Never contacts LRCLIB. Returns null when no lyrics are cached (including
 * when the stored not-found marker is present). Use this on the request path
 * so the GET handler is never blocked by an external HTTP call.
 */
export function readStoredLyrics(track: TrackDetailRow): ResolvedLyrics | null {
    const stored = readStored(track);
    if (!stored) return null;
    if (stored.fetchedAt && !stored.plain && !stored.synced) return null;
    if (!stored.plain && !stored.synced) return null;
    return {
        plain: stored.plain ?? null,
        synced: stored.synced ?? null,
        source: stored.source ?? null,
        fetchedAt: stored.fetchedAt ?? null,
    };
}

/**
 * Resolve lyrics for a track. Returns null only when no lyrics exist AND
 * auto-fetching is disabled or LRCLIB returns nothing.
 *
 * Side effects (DB write, optional disk sidecar) happen only on a cache miss.
 * Call this only from background tasks (lyrics-lrclib-fetch), not from the
 * request path.
 */
export async function resolveLyrics(
    sql: postgres.Sql,
    track: TrackDetailRow,
): Promise<ResolvedLyrics | null> {
    const stored = readStored(track);

    if (stored) {
        // Stored not-found marker — don't re-fetch
        if (stored.fetchedAt && !stored.plain && !stored.synced) return null;

        if (stored.plain || stored.synced) {
            return {
                plain: stored.plain ?? null,
                synced: stored.synced ?? null,
                source: stored.source ?? null,
                fetchedAt: stored.fetchedAt ?? null,
            };
        }
    }

    if (!features.autoLyrics) return null;
    const retry = readRetry(track);
    if (retry && Date.parse(retry.nextRetryAt) > Date.now()) return null;

    const artistName = track.artist_title;
    const trackTitle = track.title;
    if (!artistName || !trackTitle) {
        // Can't query LRCLIB without artist + title. Write the not-found marker
        // so callers (esp. the bulk lyrics-lrclib-fetch task, whose eligibility
        // is `custom_metadata->'lyrics' IS NULL`) don't re-attempt this track on
        // every run — otherwise such rows cycle forever.
        await sql`
            UPDATE media_items
            SET custom_metadata = (COALESCE(custom_metadata, '{}'::jsonb) - 'lyricsRetry') || ${sql.json(
                {
                    lyrics: {
                        plain: null,
                        synced: null,
                        // No source: nothing was consulted. This marker exists only
                        // to stop the bulk task retrying a track it can never
                        // resolve (no artist/title to query with).
                        source: null,
                        fetchedAt: new Date().toISOString(),
                    },
                },
            )}
            WHERE id = ${track.id} AND media_type = 'track'
        `;
        return null;
    }

    logger.debug('Fetching lyrics from LRCLIB', {
        trackId: track.id,
        artist: artistName,
        title: trackTitle,
    });

    // Plugin providers first, then the builtin. First non-empty answer wins:
    // an operator who installed a provider did so because they wanted it
    // consulted, and falling through to the builtin when it has nothing keeps
    // today's behaviour for every track a plugin cannot help with.
    const { fetchLyricsFromPlugins } =
        await import('$lib/server/plugins/runtime/lyrics-providers.js');
    const fromPlugin = await fetchLyricsFromPlugins({
        trackId: track.id,
        title: trackTitle,
        artist: artistName,
        album: track.album_title ?? null,
        durationSeconds: track.runtime_seconds ? Number(track.runtime_seconds) : null,
    });

    let result: LrcLibResult | null = fromPlugin;
    if (!result) {
        try {
            result = await getLyrics({
                artistName,
                trackTitle,
                albumName: track.album_title ?? undefined,
                duration: track.runtime_seconds ? Number(track.runtime_seconds) : undefined,
            });
        } catch (failure) {
            // A fault is not an authoritative miss. Persist the next attempt
            // before rethrowing, so neither another slice nor another pass spins.
            await recordRetry(sql, track, failure);
            throw failure;
        }
    }

    const fetchedAt = new Date().toISOString();
    const sourceLabel = fromPlugin ? (fromPlugin.providerId ?? 'plugin') : 'lrclib';

    if (!result || (!result.plainLyrics && !result.syncedLyrics)) {
        await sql`
            UPDATE media_items
            SET custom_metadata = (COALESCE(custom_metadata, '{}'::jsonb) - 'lyricsRetry') || ${sql.json(
                {
                    lyrics: {
                        plain: null,
                        synced: null,
                        source: sourceLabel,
                        fetchedAt,
                    },
                },
            )}
            WHERE id = ${track.id} AND media_type = 'track'
        `;
        return null;
    }

    const payload: ResolvedLyrics = {
        plain: result.plainLyrics ?? null,
        synced: result.syncedLyrics ?? null,
        // Which provider actually answered, not a hardcoded label — with more
        // than one source, "where did these lyrics come from" is a question a
        // user can now reasonably ask.
        source: sourceLabel,
        fetchedAt,
    };

    await sql`
        UPDATE media_items
        SET custom_metadata = (COALESCE(custom_metadata, '{}'::jsonb) - 'lyricsRetry') || ${sql.json({ lyrics: payload } as unknown as Record<string, never>)}
        WHERE id = ${track.id} AND media_type = 'track'
    `;

    if (features.saveLyricsToDisk) {
        try {
            const filePath = await findMediaFilePathForTrack(sql, track.id);
            if (filePath) {
                const written = await writeLyricsSidecar(filePath, {
                    synced: result.syncedLyrics,
                    plain: result.plainLyrics,
                });
                if (written) {
                    logger.info('Lyrics saved to disk', {
                        trackId: track.id,
                        path: written,
                    });
                }
            }
        } catch (err) {
            logger.warn('Failed to save lyrics to disk', {
                trackId: track.id,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Lyrics fetched from LRCLIB and cached', {
        trackId: track.id,
        hasSynced: !!payload.synced,
        hasPlain: !!payload.plain,
    });

    return payload;
}
