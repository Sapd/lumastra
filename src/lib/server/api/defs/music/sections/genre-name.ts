// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/music/sections/genre/[name]
 *
 * Genre track carousel section. Internal BFF — dashboard only.
 *
 * Three operating modes (driven by query params):
 *  1. ?exclude=<csv-ids>  — "Load more" path: return a fresh batch of
 *     curated tracks excluding already-shown IDs.
 *  2. ?ids=<csv-ids>      — Pre-planned track list. Respects an empty
 *     plan (returns null rather than falling back to unfiltered query).
 *  3. (no params)         — Unplanned fallback: a curated pick from the genre
 *     pool, seeded per (user, genre) so the same viewer gets the same batch
 *     back rather than a reshuffle on every request. Native clients take this
 *     path, having no server-rendered plan to pass `?ids=`.
 *
 * All three modes run the SAME curation (`selectGenreTrackBatch`): variant
 * collapsing, a per-batch album cap, title+artist dedup.
 *
 * Response: bare `PageSection | null` (the consumer, LazySection.svelte,
 * reads `await res.json() as PageSection | null` directly — NOT a wrapper —
 * for both the initial fetch and the `?exclude=` load-more batch).
 * DB-down → 503 dependency_unavailable.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { PageSectionSchema } from '$lib/schemas/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getTracksByGenre, getTracksByIds } from '$lib/server/database/queries/music.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleRows } from '$lib/server/utils/media-access-batch.js';
import {
    selectGenreTrackBatch,
    genreBatchRng,
} from '$lib/server/services/music/genre-plan.service.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { buildGenreTrackSection } from '$lib/server/utils/music-section-builder.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const logger = Logger.for('GenreSectionDef');

const GENRE_LIMIT = 28;
const FINAL_SLICE = 20;
const LOAD_MORE_DEFAULT = 20;
const LOAD_MORE_MAX = 40;
// `exclude` IDs are interpolated into a `::uuid[]` cast; a non-UUID value would
// make Postgres throw. Drop malformed values so a junk param degrades to no exclusion.

const ParamsSchema = z.object({
    name: z.string().min(1),
});

const QuerySchema = z.object({
    exclude: z.string().optional(),
    ids: z.string().optional(),
    limit: z.coerce.number().int().min(1).max(LOAD_MORE_MAX).optional(),
});

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get a genre carousel',
            stability: 'beta',
            auth: 'bearer',
            description:
                'A carousel of tracks for one genre. Supports three modes: `?exclude=<csv>` returns a fresh batch omitting already-shown ids (the "load more" path), `?ids=<csv>` renders a pre-planned track list, and no params picks from the genre pool. Every mode applies the same curation — remix/live variants collapsed to the original, an album cap, and title+artist dedup — and the pick is seeded per (caller, genre), so repeating the same request returns the SAME batch rather than reshuffling. The rail still moves as the library grows. Returns `null` (HTTP 200) when the genre yields nothing or a supplied plan is empty.',
            responses: {
                200: {
                    schema: PageSectionSchema.nullable(),
                    description: 'Carousel section, or null when there is nothing to show',
                },
                401: 'Authentication required',
                503: 'Database unavailable',
            },
        },
    },
    request: {
        params: ParamsSchema,
        query: QuerySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            if (!event.locals.user) return ApiProblem.unauthorized();

            const paramsResult = ParamsSchema.safeParse(event.params);
            if (!paramsResult.success) {
                return ApiProblem.validationFailed('Genre name is required');
            }
            const { name: genreName } = paramsResult.data;

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            // Both halves of the pick must be seeded from the same key, or the
            // stability is decorative: the SQL pool draw is what decides WHICH
            // candidates the seeded shuffle below gets to choose between.
            const poolSeed = `${event.locals.user.userId}::${genreName}`;

            try {
                // Every path serves tracks to this viewer, so every path
                // applies their boundary — including `?ids=`, whose ids come
                // from the client and so can name any track at all.
                const access = searchAccessBoundary(
                    await buildSearchAccessContext(sql, event.locals.user),
                );
                const excludeParam = event.url.searchParams.get('exclude');

                if (excludeParam !== null) {
                    // Load more path
                    const excludeIds = excludeParam
                        .split(',')
                        .map((s) => s.trim())
                        .filter((s) => UUID_RE.test(s));

                    const requested = Number.parseInt(
                        event.url.searchParams.get('limit') ?? '',
                        10,
                    );
                    const limit = Number.isFinite(requested)
                        ? Math.min(Math.max(requested, 1), LOAD_MORE_MAX)
                        : LOAD_MORE_DEFAULT;

                    const pool = await getTracksByGenre(
                        sql,
                        genreName,
                        access,
                        Math.max(limit * 3, GENRE_LIMIT),
                        excludeIds,
                        poolSeed,
                    );
                    const picked = selectGenreTrackBatch(
                        pool,
                        limit,
                        genreBatchRng(event.locals.user.userId, genreName),
                    );
                    const imageSets = await resolveImageSets(
                        sql,
                        ctx.surface,
                        picked.map((t) => ({ id: t.id, mediaType: 'track' })),
                    );
                    const section = buildGenreTrackSection(genreName, picked, imageSets);
                    return json(section);
                }

                const idsParam = event.url.searchParams.get('ids');

                if (idsParam !== null) {
                    // Pre-planned path — respect empty plan (don't fall back to
                    // unfiltered query which would bypass cross-section dedup).
                    const plannedIds = idsParam
                        .split(',')
                        .map((s) => s.trim())
                        .filter((s) => s.length > 0);
                    if (plannedIds.length === 0) {
                        return json(null);
                    }
                    const tracks = await filterAccessibleRows(
                        sql,
                        await getTracksByIds(sql, plannedIds),
                        access,
                    );
                    const imageSets = await resolveImageSets(
                        sql,
                        ctx.surface,
                        tracks.map((t) => ({ id: t.id, mediaType: 'track' })),
                    );
                    const section = buildGenreTrackSection(genreName, tracks, imageSets);
                    return json(section);
                }

                // Unplanned fallback path — the one a native client hits, since
                // it has no server-rendered plan to pass `?ids=`.
                //
                // This used to carry an INLINED copy of the curation instead of
                // calling the shared selector, and had drifted from it in three
                // ways: unseeded `Math.random` (so the rail reshuffled on every
                // request), an album cap re-rolled PER TRACK rather than once per
                // batch, and no remix/live collapsing or title+artist dedup at
                // all — so this path could serve "Song", "Song (Remix)" and
                // "Song (Live)" as three separate entries where every other
                // surface shows one. genre-plan.service.ts documents both
                // surfaces as applying identical curation; now they do.
                const raw = await getTracksByGenre(
                    sql,
                    genreName,
                    access,
                    GENRE_LIMIT,
                    null,
                    poolSeed,
                );
                const picked = selectGenreTrackBatch(
                    raw,
                    FINAL_SLICE,
                    genreBatchRng(event.locals.user.userId, genreName),
                );

                const imageSets = await resolveImageSets(
                    sql,
                    ctx.surface,
                    picked.map((t) => ({ id: t.id, mediaType: 'track' })),
                );
                const section = buildGenreTrackSection(genreName, picked, imageSets);
                return json(section);
            } catch (err) {
                logger.error('Genre section endpoint failed', err as Error, {
                    genre: genreName,
                });
                return ApiProblem.internalError('Failed to load genre section');
            }
        },
    },
});
