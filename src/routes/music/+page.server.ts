// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import type { PageSection } from '$lib/types/server-driven-ui';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    getRecentlyPlayed,
    getAlbums,
    getMostPlayedArtists,
    getTopArtistsByAlbumCount,
} from '$lib/server/database/queries/music.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    buildRecentlyPlayedSection,
    buildRecentlyAddedAlbumsSection,
    buildTopArtistsSection,
    buildQuickPicksSection,
    buildUserPlaylistsSection,
} from '$lib/server/utils/music-section-builder.js';
import { getQuickPicks } from '$lib/server/services/music/quick-picks.service.js';
import { MOOD_CHIPS } from '$lib/constants/music-moods.js';
import { pickDailyMoodShelves } from '$lib/server/services/music/mood-rotation.service.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
    type SearchAccessContext,
} from '$lib/server/utils/search-access-context.js';
import {
    getUserStations,
    type StationSummary,
} from '$lib/server/services/music/stations.service.js';
import { computeGenrePlanCached } from '$lib/server/services/music/genre-plan-cached.service';
import { loadGenreRails } from '$lib/server/services/music/genre-ranker.service.js';
import {
    getOwnedPlaylists,
    getSharedPlaylists,
} from '$lib/server/database/queries/playlists.queries.js';
import { getPinnedGenreNames } from '$lib/server/database/queries/user-pinned-genres.queries.js';
import { loadLibraryGenreRows } from '$lib/server/utils/music-explore-loader.js';
import { timeSection } from '$lib/server/utils/section-timing.js';
import { buildImageRefs } from '$lib/shared/api-urls.js';
import type { RadioStationApiItem } from '$lib/schemas/radio.js';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('MusicHomePage');

const EMPTY_STREAMED_SECTION: Promise<PageSection | null> = Promise.resolve(null);

// Number of rotating mood shelves shown per page load (see pickDailyMoodShelves).
const MOOD_SHELF_COUNT = 2;

const GENRE_CAROUSEL_LIMIT = 8;
const QUICK_PICKS_INITIAL_LIMIT = 24;

// Filter out scanner artifacts (cover art files, etc.)
const ARTIFACT_TITLES = new Set(['cover', 'folder', 'front', 'back']);

/**
 * The shelf renders through `RadioStationCard`, which is typed to
 * `RadioStationApiItem` and forwards `station.images` wholesale into the player
 * queue. This used to emit `{title, logoUrl}` instead, so every card on /music
 * rendered with no name and no artwork. Build the same shape the
 * `/api/music/radio/stations` def does.
 */
type RadioStationSummary = RadioStationApiItem;

const RADIO_SECTION_LIMIT = 12;

interface MoodShelfSummary {
    key: string;
    label: string;
}

async function loadRadioStations(
    sql: Awaited<ReturnType<typeof aiDbService.getSql>>,
    accessCtx: SearchAccessContext,
): Promise<RadioStationSummary[]> {
    if (!sql) return [];
    // Same library + age scope as /music/radio and /api/music/radio/stations;
    // this shelf listed every station to everyone (2026-10-07 entry-point review).
    const age = accessCtx.ageRating;
    try {
        const rows = await sql<
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
              ${buildLibraryAccessFilter(sql, accessCtx.deniedGroupIds, 'mi')}
              ${
                  age && age.maxAgeRating !== null
                      ? sql`AND (
                  (mi.age_rating IS NULL AND ${age.allowUnrated}::boolean)
                  OR mi.age_rating <= ${age.maxAgeRating}
              )`
                      : sql``
              }
            ORDER BY mi.title ASC
            LIMIT ${RADIO_SECTION_LIMIT}
        `;
        return rows.map((row) => {
            const meta = row.custom_metadata;
            return {
                id: String(row.id),
                type: 'radio' as const,
                name: String(row.title),
                genre: meta.genre ? String(meta.genre) : undefined,
                nowPlaying: meta.now_playing ? String(meta.now_playing) : undefined,
                images: row.custom_poster_url
                    ? buildImageRefs(String(row.id), 'internal')
                    : undefined,
            };
        });
    } catch (err) {
        logger.warn('Failed to load radio stations for /music', {
            error: err instanceof Error ? err.message : String(err),
        });
        return [];
    }
}

export const load: PageServerLoad = async ({ locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql || !locals.user) {
        return {
            sections: [] as PageSection[],
            moodChips: MOOD_CHIPS,
            moodShelves: [] as MoodShelfSummary[],
            libraryGenres: [] as {
                genre: string;
                trackCount: number;
                albumCount: number;
            }[],
            pinnedGenreNames: [] as string[],
            radioStations: [] as RadioStationSummary[],
            tasteStations: Promise.resolve([] as StationSummary[]),
            topArtistsSection: EMPTY_STREAMED_SECTION,
            recentlyAddedAlbumsSection: EMPTY_STREAMED_SECTION,
            quickPicksSection: EMPTY_STREAMED_SECTION,
            genrePlan: {} as Record<string, string[]>,
            genreCarouselNames: [] as string[],
            isAdmin: false,
        };
    }

    const userId = locals.user.userId;
    const accessCtx = await buildSearchAccessContext(sql, locals.user);

    // Deterministic per (UTC date, user) mood rotation — same picks all day,
    // rotates the next day. Pure/local, so computed outside the try block's
    // DB-dependent work.
    const moodRotationDateKey = new Date().toISOString().slice(0, 10);
    const moodShelves: MoodShelfSummary[] = pickDailyMoodShelves(
        MOOD_CHIPS,
        moodRotationDateKey,
        String(userId),
        MOOD_SHELF_COUNT,
    ).map((chip) => ({ key: chip.genre, label: chip.label }));

    try {
        // Streamed — independent of Tier 1 data, so kicked off first.
        // getUserStations calls getUserTasteClusters which on a cache miss runs
        // k-means over 50 embedding vectors (CPU-bound) then N label queries.
        // Awaiting it in Promise.all made it the dominant bottleneck on every
        // cold page load. Now it streams like topArtistsSection.
        const tasteStationsPromise: Promise<StationSummary[]> = timeSection(
            'taste-stations',
            't2',
            async () => {
                const result = await getUserStations(sql, userId, locals.user).catch((err) => {
                    logger.debug('Failed to load taste stations', {
                        error: err instanceof Error ? err.message : String(err),
                    });
                    return null;
                });
                return result ?? [];
            },
        ).catch((err) => {
            logger.warn('Tier 2 taste-stations failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return [];
        });

        // Streamed Tier 2 — unchanged from Phase 1 (kicked off before Tier 1 so they
        // run concurrently with the critical path).
        const topArtistsSection: Promise<PageSection | null> = timeSection(
            'top-artists',
            't2',
            async () => {
                const primary = (
                    await getMostPlayedArtists(
                        sql,
                        userId,
                        16,
                        accessCtx.deniedGroupIds,
                        accessCtx.ageRating,
                    )
                ).slice(0, 12);
                if (primary.length > 0) return buildTopArtistsSection(primary);
                const fallback = (
                    await getTopArtistsByAlbumCount(
                        sql,
                        16,
                        accessCtx.deniedGroupIds,
                        accessCtx.ageRating,
                    )
                ).slice(0, 12);
                return buildTopArtistsSection(fallback, {
                    title: 'Popular Artists',
                    id: 'music-popular-artists',
                });
            },
        ).catch((err) => {
            logger.warn('Tier 2 top-artists failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        });

        const recentlyAddedAlbumsSection: Promise<PageSection | null> = timeSection(
            'recently-added-albums',
            't2',
            async () => {
                const albums = await getAlbums(sql, {
                    sort: 'recent',
                    limit: 20,
                    access: searchAccessBoundary(accessCtx),
                });
                return buildRecentlyAddedAlbumsSection(albums);
            },
        ).catch((err) => {
            logger.warn('Tier 2 recently-added-albums failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        });

        // Awaited Tier 1 — cheap, personal.
        const [
            recentlyPlayed,
            ownedPlaylists,
            sharedPlaylists,
            libraryGenres,
            pinnedGenreRows,
            radioStations,
        ] = await Promise.all([
            timeSection('recently-played', 't1', () => getRecentlyPlayed(sql, userId, 20)),
            // The access boundary used to be omitted here, so the playlist
            // cover collages on /music rendered poster art from library groups
            // the viewer cannot access. Now required by the signature.
            timeSection('owned-playlists', 't1', () =>
                getOwnedPlaylists(sql, userId, 'music', searchAccessBoundary(accessCtx)),
            ),
            timeSection('shared-playlists', 't1', () =>
                getSharedPlaylists(sql, userId, 'music', searchAccessBoundary(accessCtx)),
            ),
            // Library-wide (per access scope), slow-changing data behind a
            // full-track JSONB scan (~700ms-1.9s). Cached + single-flighted out
            // of the awaited tier-1 critical path — shared with /music/explore
            // via loadLibraryGenreRows so there's one implementation of this
            // scan, not a duplicated copy.
            timeSection('library-genres', 't1', () => loadLibraryGenreRows(sql, accessCtx)),
            timeSection('pinned-genres', 't1', () => getPinnedGenreNames.all(sql, { userId })),
            timeSection('radio-stations', 't1', () => loadRadioStations(sql, accessCtx)),
        ]);

        const filteredPlayed = recentlyPlayed.filter(
            (t) => !ARTIFACT_TITLES.has(t.title.toLowerCase()),
        );
        const recentlyPlayedIds = filteredPlayed.map((t) => t.id);

        // Streamed Tier 2 — Quick Picks. Depends on recentlyPlayedIds (derived
        // from the awaited Tier 1 block above), so declared here. Runs
        // concurrently with the genre plan compute below.
        const quickPicksSection: Promise<PageSection | null> = timeSection(
            'quick-picks',
            't2',
            async () => {
                const tracks = await getQuickPicks(
                    sql,
                    userId,
                    QUICK_PICKS_INITIAL_LIMIT,
                    recentlyPlayedIds,
                    {
                        deniedGroupIds: accessCtx.deniedGroupIds,
                        ageRating: accessCtx.ageRating,
                    },
                );
                return buildQuickPicksSection(tracks);
            },
        ).catch((err) => {
            logger.warn('Tier 2 quick-picks failed', {
                error: err instanceof Error ? err.message : String(err),
            });
            return null;
        });

        // Taste-ranked, pinned-first, from the library's real genres — see
        // genre-ranker.service.ts. The hardcoded fallback list this used to fall
        // back to is gone; an empty library now yields no rails, which is
        // honest, rather than eight rails that render empty.
        const pinnedNames = pinnedGenreRows.map((r) => r.genre);
        const genreRails = await loadGenreRails(sql, userId, accessCtx, pinnedNames, libraryGenres);
        const genreCarouselNames = genreRails.slice(0, GENRE_CAROUSEL_LIMIT).map((r) => r.title);

        // Phase 3: Quick Picks is streamed, so its IDs aren't available
        // synchronously. The genre plan excludes recently-played only.
        // Per the spec's "Tier 2 overlap caveat", genre carousels may
        // occasionally contain a track that's also in Quick Picks.
        // Rare in practice — recently-played is the dominant overlap source,
        // and Phase 2.5's filterStaleExclusions post-filter still catches
        // recently-played additions on cached plans.
        const genrePlan = await timeSection('genre-plan', 't1', () =>
            computeGenrePlanCached(sql, userId, {
                recentlyPlayedIds,
                genreCarouselNames,
                access: searchAccessBoundary(accessCtx),
            }),
        );

        // Build sections[] — only contains awaited sections now.
        // Top Artists + Recently Added Albums stream; BYL + Smart Mixes +
        // genre carousels are lazy-loaded on the client.
        const sections: PageSection[] = [];

        const rpSection = buildRecentlyPlayedSection(filteredPlayed);
        if (rpSection) sections.push(rpSection);

        const allPlaylists = [...ownedPlaylists, ...sharedPlaylists];
        const playlistSection = buildUserPlaylistsSection(allPlaylists);
        if (playlistSection) sections.push(playlistSection);

        return {
            sections,
            moodChips: MOOD_CHIPS,
            moodShelves,
            libraryGenres: libraryGenres.map((g) => ({
                genre: g.genre,
                trackCount: g.track_count,
                albumCount: g.album_count,
            })),
            pinnedGenreNames: pinnedNames,
            radioStations,
            tasteStations: tasteStationsPromise,
            topArtistsSection,
            recentlyAddedAlbumsSection,
            quickPicksSection,
            genrePlan,
            genreCarouselNames,
            isAdmin: localsIsAdmin(locals),
        };
    } catch (err) {
        logger.error('Failed to load music home', err as Error);
        return {
            sections: [] as PageSection[],
            moodChips: MOOD_CHIPS,
            // Mood rotation is pure/local (computed above, no DB) — keep the
            // shelves alive even when Tier-1 queries fail; their endpoint is
            // independent of whatever broke here.
            moodShelves,
            libraryGenres: [] as {
                genre: string;
                trackCount: number;
                albumCount: number;
            }[],
            pinnedGenreNames: [] as string[],
            radioStations: [] as RadioStationSummary[],
            tasteStations: Promise.resolve([] as StationSummary[]),
            topArtistsSection: EMPTY_STREAMED_SECTION,
            recentlyAddedAlbumsSection: EMPTY_STREAMED_SECTION,
            quickPicksSection: EMPTY_STREAMED_SECTION,
            genrePlan: {} as Record<string, string[]>,
            genreCarouselNames: [] as string[],
            isAdmin: localsIsAdmin(locals),
        };
    }
};
