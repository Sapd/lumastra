// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getLibraryGenres } from '$lib/server/database/queries/music.queries';
import { peekNowPlaying } from '$lib/server/services/radio-metadata';
import type { RadioMetadataSource, RadioStationApiItem } from '$lib/schemas/radio';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context.js';
import { buildImageRefs } from '$lib/shared/api-urls.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';

// Library-wide genre list (min 3 tracks) sits behind a full-library JSONB
// scan. It is not access-scoped, so cache it under one global key instead of
// paying the scan on every radio page load.
const RADIO_LIBRARY_GENRES_KEY = 'radio-library-genres-min-3';

const logger = Logger.for('RadioPage');

const SMART_RADIO_MOODS = [
    { label: 'Chill', genre: 'chill', emoji: '😌' },
    { label: 'Workout', genre: 'workout', emoji: '💪' },
    { label: 'Focus', genre: 'focus', emoji: '🎯' },
    { label: 'Party', genre: 'party', emoji: '🎉' },
    { label: 'Energetic', genre: 'energetic', emoji: '⚡' },
    { label: 'Jazz', genre: 'jazz', emoji: '🎷' },
    { label: 'Classical', genre: 'classical', emoji: '🎻' },
    { label: 'Lo-Fi', genre: 'lo-fi', emoji: '🌙' },
] as const;

export const load: PageServerLoad = async ({ locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql || !locals.user) {
        return { stations: [], moods: SMART_RADIO_MOODS, genres: [] };
    }

    // An unconfigured instance renders the page's own empty state ("No stations
    // yet") rather than a 404.
    //
    // This used to `error(404, 'Radio is not configured')` to mirror the nav
    // gate. That is the worst possible answer for a FRESH INSTALL, which is
    // exactly the state a new self-hosted user is in: nothing is configured, so
    // following the Radio entry handed them an error page instead of telling
    // them there is nothing here yet. The smart-radio moods below work without
    // any station, so the page is useful even when empty.
    try {
        // Mirror the gate on /api/music/radio: scope by library + age.
        // Without this, the radio page leaks station titles, genres,
        // and stream metadata for stations in denied library groups.
        const accessCtx = await buildSearchAccessContext(sql, locals.user);
        const denied = accessCtx.deniedGroupIds;
        const age = accessCtx.ageRating;
        const genresCache = cacheManager.for(CACHE_NAMESPACES.musicLibraryGenres);
        const [genres, rows] = await Promise.all([
            (async () => {
                const cached =
                    await genresCache.get<Array<{ genre: string; trackCount: number }>>(
                        RADIO_LIBRARY_GENRES_KEY,
                    );
                if (cached) return cached;
                const fresh = await getLibraryGenres(sql, 3);
                await genresCache.set(RADIO_LIBRARY_GENRES_KEY, fresh);
                return fresh;
            })(),
            sql<
                Array<{
                    id: string;
                    title: string;
                    custom_metadata: Record<string, unknown>;
                    custom_poster_url: string | null;
                }>
            >`
            SELECT mi.id, mi.title,
                   COALESCE(mi.custom_metadata, '{}'::jsonb) AS custom_metadata,
                   mi.custom_poster_url
            FROM media_items mi
            WHERE mi.media_type = 'radio'
              ${
                  denied && denied.length > 0
                      ? sql`AND (
                  NOT EXISTS (SELECT 1 FROM media_file_items WHERE media_item_id = mi.id)
                  OR EXISTS (
                      SELECT 1 FROM media_file_items mfi
                      JOIN media_files mf ON mf.id = mfi.file_id
                      WHERE mfi.media_item_id = mi.id
                        AND (mf.library_group_id IS NULL
                             OR mf.library_group_id != ALL(${denied}::uuid[]))
                  )
              )`
                      : sql``
              }
              ${
                  age && age.maxAgeRating !== null
                      ? sql`AND (
                  (mi.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR mi.age_rating <= ${age.maxAgeRating}
              )`
                      : sql``
              }
            ORDER BY mi.title ASC
        `,
        ]);

        const stationInputs = rows.map((row) => ({
            id: String(row.id),
            streamUrl: String(row.custom_metadata.stream_url ?? ''),
            metadataSource: row.custom_metadata.metadata_source as RadioMetadataSource | undefined,
        }));
        const snapshots = await Promise.all(stationInputs.map((s) => peekNowPlaying(s)));

        const stations: (RadioStationApiItem & { nowPlaying?: string | null })[] = rows.map(
            (row, i) => {
                const meta = row.custom_metadata;
                const snap = snapshots[i];
                const nowPlayingText = snap
                    ? snap.track.artist && snap.track.title
                        ? `${snap.track.artist} – ${snap.track.title}`
                        : (snap.track.title ?? null)
                    : meta.now_playing
                      ? String(meta.now_playing)
                      : null;
                return {
                    id: String(row.id),
                    type: 'radio' as const,
                    name: String(row.title),
                    genre: meta.genre ? String(meta.genre) : undefined,
                    nowPlaying: nowPlayingText ?? undefined,
                    images: row.custom_poster_url ? buildImageRefs(row.id, 'internal') : undefined,
                };
            },
        );

        return { stations, moods: SMART_RADIO_MOODS, genres };
    } catch (err) {
        logger.error('Failed to load radio stations', err as Error);
        return { stations: [], moods: SMART_RADIO_MOODS, genres: [] };
    }
};
