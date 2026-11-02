// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/home.ts — `GET /api/music` AND `GET /api/v1/music`.
 *
 * Returns the music home page: recently-played (tracks), recently-added
 * (ALBUMS — see buildRecentlyAddedAlbumsSection), and per-genre carousel
 * sections.
 *
 * This def is mounted on BOTH surfaces (see src/routes/api/music/+server.ts
 * and src/routes/api/v1/music/+server.ts), so it is NOT dashboard-only — an
 * earlier version of this header claimed otherwise, and the handler was
 * written to match that claim: it emitted raw DB rows that no external client
 * could decode. Anything surface-dependent here must come from `ctx.surface`.
 *
 * Response shape: bare object `{ sections: PageSection[] }`.
 * Errors → problem+json. DB-down → 503 dependency_unavailable.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import {
    getAlbums,
    getRecentlyPlayed,
    getTracksByGenre,
} from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import { loadLibraryGenreRows } from '$lib/server/utils/music-explore-loader.js';
import { getPinnedGenreNames } from '$lib/server/database/queries/user-pinned-genres.queries.js';
import { dayKey, loadGenreRails } from '$lib/server/services/music/genre-ranker.service.js';
import { MusicHomeSectionsResponseSchema } from '$lib/schemas/api-music-responses.js';
import {
    buildRecentlyPlayedSection,
    buildRecentlyAddedAlbumsSection,
    buildGenreTrackSection,
} from '$lib/server/utils/music-section-builder.js';
import {
    selectGenreTrackBatch,
    genreBatchRng,
} from '$lib/server/services/music/genre-plan.service.js';
import type { PageSection } from '$lib/types/server-driven-ui';

const logger = Logger.for('MusicHomeApiDef');

/** Tracks per genre rail. Matches the dashboard's own genre route. */
const GENRE_RAIL_SIZE = 20;
/**
 * Pool fetched per rail before cross-rail dedup and curation — headroom so a
 * rail whose tracks were claimed by a higher-ranked rail, or collapsed as
 * remix/live variants of each other, still fills rather than coming back short.
 */
const GENRE_RAIL_FETCH = 60;

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    // OpenAPI docs for the /api/v1/music (public/native) surface. Migrated
    // verbatim from the retired src/routes/api/v1/music/_openapi.ts. `auth:
    // 'bearer'` + `stability: 'stable'` carried over → byte-identical published
    // security scheme and stability tier.
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get music home sections',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Server-driven music home: `music-recently-played` (tracks), `music-recently-added` (ALBUMS, newest first — `mediaType: album`; open the album on tap), then per-genre track rails. Until 2026-09-29 `music-recently-added` carried tracks, which let one large album import fill the whole rail; switch on `mediaType` per item rather than assuming a section’s item type.',
            responses: {
                200: {
                    schema: MusicHomeSectionsResponseSchema,
                    description: 'Music home page sections (server-driven UI)',
                },
                401: 'Authentication required',
                500: 'Internal server error',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            // Access context first: the genre rails are derived from an
            // access-filtered library scan, so it is an input now, not just a
            // post-filter.
            const accessCtx = await buildSearchAccessContext(sql, user);
            const access = searchAccessBoundary(accessCtx);

            // Which genres this viewer gets, and in what order — library size as
            // the prior, their own listening as the evidence. Replaces a
            // hardcoded eight-name list; see genre-ranker.service.ts.
            const [libraryGenres, pinnedRows] = await Promise.all([
                loadLibraryGenreRows(sql, accessCtx),
                getPinnedGenreNames.all(sql, { userId: user.userId }),
            ]);
            const rails = await loadGenreRails(
                sql,
                user.userId,
                accessCtx,
                pinnedRows.map((r) => r.genre),
                libraryGenres,
            );

            const genreOrderSeed = `${user.userId}:${dayKey(new Date())}`;

            const [recentlyPlayedRaw, recentlyAdded, ...genreResultsRaw] = await Promise.all([
                getRecentlyPlayed(sql, user.userId, 20),
                // Scoped in the query (boundary is an input), like the genre rails.
                getAlbums(sql, { sort: 'recent', limit: 20, access }),
                // TRACKS, not albums. These rails used to serve album rows,
                // which made them the only rows on this feed that were not
                // playable on tap — the dashboard's own genre carousels have
                // always served tracks via /music/sections/genre/{name}, and
                // no client rendered the album shape: the dashboard bypasses
                // this feed for genre entirely, and the native clients threw
                // the items away and re-requested that route per row.
                //
                // Every stored spelling, not just the display name — a rail
                // folds `Hip Hop`/`Hip-Hop` together and must fetch both.
                //
                // Access is an INPUT here rather than a post-filter: this
                // query applies the boundary itself, so the rows that come
                // back are already the ones this viewer may see.
                //
                // Seeded per viewer per day, matching how `loadGenreRails`
                // caches the rail LIST.
                ...rails.map((rail) =>
                    getTracksByGenre(
                        sql,
                        rail.variants,
                        access,
                        GENRE_RAIL_FETCH,
                        null,
                        genreOrderSeed,
                    ),
                ),
            ]);

            // Library + age scoping: getRecentlyPlayed is an unscoped catalog
            // query, so an age-restricted or library-limited user would
            // otherwise see tracks they can't access. Filter it through the
            // user's access boundary (mirrors /api/music/albums).
            //
            // Recently-added albums and the genre rails are NOT re-filtered
            // here: getAlbums / getTracksByGenre take the boundary as an
            // argument and apply it in the query.
            const recentlyPlayed = await filterAccessibleRows(sql, recentlyPlayedRaw, access);
            const genreResults = genreResultsRaw;

            logger.debug('Music home sections loaded', {
                username: user.username,
                recentlyPlayedCount: recentlyPlayed.length,
                recentlyAddedCount: recentlyAdded.length,
            });

            // Every section goes through music-section-builder — the same
            // transformers the SSR music page and every other section def use.
            // This endpoint used to push raw snake_case DB rows into `items`
            // and never set `type`, which failed the declared PageSection
            // contract (mount() logged RESPONSE CONFORMANCE) and would make a
            // strict generated client reject the whole response.
            const sections: PageSection[] = [];

            const pushSection = (section: PageSection | null) => {
                if (section) sections.push(section);
            };

            // ctx.surface, not a hardcoded default: this def is mounted on BOTH
            // /api/music (internal) and /api/v1/music (bearer). Image hrefs must
            // carry the caller's own prefix or the client can't fetch them.
            pushSection(buildRecentlyPlayedSection(recentlyPlayed, ctx.surface));
            pushSection(buildRecentlyAddedAlbumsSection(recentlyAdded, ctx.surface));

            // Cross-rail dedup, now over TRACK ids. A track tagged Electronic
            // AND Pop AND Rock would otherwise be served in all three: on the
            // production library 24% of genre-rail slots were repeats when
            // this was measured over albums, and the SSR path has always
            // carried seenTrackIds ACROSS genres via computeGenrePlan — this
            // endpoint was the odd one out.
            //
            // First rail wins, which means the highest-ranked one: the track
            // lands in the genre this viewer most demonstrably likes.
            //
            // Claimed AFTER curation, not before: selectGenreTrackBatch is
            // what decides which of the pool actually ships, and claiming the
            // whole pool would let one rail reserve tracks it never shows and
            // starve the rails below it.
            const claimedTracks = new Set<string>();
            const dedupedGenreResults = rails.map((rail, i) => {
                const pool = (genreResults[i] ?? []).filter((row) => !claimedTracks.has(row.id));
                // Same curation the dashboard's genre route runs: remix/live
                // variant collapsing, a per-batch album cap, title+artist
                // dedup. Seeded off the rail's normalised key so the batch is
                // stable for a viewer rather than reshuffling per request.
                const picked = selectGenreTrackBatch(
                    pool,
                    GENRE_RAIL_SIZE,
                    genreBatchRng(user.userId, rail.key),
                );
                for (const row of picked) claimedTracks.add(row.id);
                return picked;
            });

            // ImageSets for every genre-rail track, resolved once for this surface.
            const genreImageSets = await resolveImageSets(
                sql,
                ctx.surface,
                dedupedGenreResults.flat().map((row) => ({ id: row.id, mediaType: 'track' })),
            );

            for (let i = 0; i < rails.length; i++) {
                const items = dedupedGenreResults[i];
                if (items && items.length > 0) {
                    // Keyed on the NORMALISED key, not the display title: the
                    // dominant spelling can flip as a library grows, and a
                    // section id that moves with it breaks client state. The
                    // discovery rail gets its own id prefix so a client can
                    // style or dismiss it independently of a proven-taste rail.
                    const rail = rails[i];
                    pushSection(
                        buildGenreTrackSection(rail.title, items, genreImageSets, {
                            id: rail.discovery
                                ? `music-genre-discovery-${rail.key}`
                                : `music-genre-${rail.key}`,
                            title: rail.discovery ? `New to You: ${rail.title}` : rail.title,
                        }),
                    );
                }
            }

            return json({ sections });
        },
    },
});
