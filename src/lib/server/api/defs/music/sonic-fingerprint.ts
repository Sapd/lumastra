// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { resolveImageSets } from '$lib/server/services/image-descriptor/index.js';
import { musicSearchRowToTrack } from '$lib/server/utils/music-track-mapper.js';

/**
 * defs/music/sonic-fingerprint.ts
 *
 * GET /api/music/sonic-fingerprint
 *
 * Returns the user's "sonic fingerprint" as a PageSection ready for
 * SectionRenderer, or null when the user has insufficient play history or
 * no sonic embeddings yet.
 *
 * The fingerprint is a recency-weighted centroid of the user's most-played
 * tracks' MSCLAP-2023 audio embeddings, projected into kNN neighbours.
 *
 * Gating: features.sonicEmbeddings (FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS).
 * Auth:   any authenticated user.
 *
 * Response: bare PageSection | null (LazySection-compatible).
 *   null → user has no play history or embeddings not yet generated.
 *
 * Errors → application/problem+json.
 *   503 dependency_unavailable when the AI-DB is down (NEVER 200-empty).
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    buildSearchAccessContext,
    scopedCacheKey,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import {
    findSonicFingerprintNeighbors,
    type FingerprintNeighborRow,
} from '$lib/server/database/queries/sonic-fingerprint.queries.js';
import { buildSonicFingerprintSection } from '$lib/server/utils/music-section-builder.js';
import { PageSectionSchema } from '$lib/schemas/api-responses.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { MusicTrack } from '$lib/schemas/music.js';
import type { PageSection } from '$lib/types/server-driven-ui.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('SonicFingerprintDef');

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const querySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).optional().default(20),
});

// ---------------------------------------------------------------------------
// Cached shape stored in Valkey
// ---------------------------------------------------------------------------

interface CachedSection {
    section: PageSection | null;
}

// ---------------------------------------------------------------------------
// Row → MusicTrack transformer (for buildSonicFingerprintSection)
//
// The section builder uses only id/title/artist/albumId — it resolves images
// via resolveMusicImage(t.id) internally, so we don't attach images{} here.
// The response is the PageSection (not the tracks), so image handling is
// delegated entirely to the builder.
// ---------------------------------------------------------------------------

function rowToTrack(row: FingerprintNeighborRow, images: ImageSet): MusicTrack {
    return musicSearchRowToTrack(row, images);
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'feature', flag: 'sonicEmbeddings', then: { kind: 'user' } },
    visibility: 'public',

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get the "your sonic fingerprint" carousel',
            stability: 'beta',
            auth: 'bearer',
            description:
                "A carousel of tracks nearest the caller's own listening centroid: the recency-weighted mean of their most-played tracks' MSCLAP audio embeddings, projected back into the library as kNN neighbours. Returns `null` (HTTP 200) when the caller has too little play history or the library has no embeddings yet — render nothing in that case rather than an empty rail. Requires play reporting via `music/progress/*`; a client that never reports plays will always get `null`. Item ids are namespaced `sfp:<uuid>`; the playable id is `externalIds.internal`.",
            responses: {
                200: {
                    schema: PageSectionSchema.nullable(),
                    description: 'Carousel section, or null when there is nothing to show',
                },
                401: 'Authentication required',
                404: 'The sonicEmbeddings feature is not enabled',
                503: 'Database unavailable',
            },
        },
    },

    request: {
        query: querySchema,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = await aiDbService.getSql();
            if (!sql) {
                return ApiProblem.dependencyUnavailable('Database is not available');
            }

            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const limitParam = event.url.searchParams.get('limit');
            const limit = limitParam
                ? Math.min(Math.max(1, parseInt(limitParam, 10) || 20), 50)
                : 20;

            const accessCtx = await buildSearchAccessContext(sql, user);

            const fingerprintCache = cacheManager.for(CACHE_NAMESPACES.musicSonicFingerprint);
            const cacheKey = scopedCacheKey(
                // v2: items gained clickData.artistId + artists[] (clickable
                // credits) — cached v1 sections lack them.
                //
                // Keyed by surface because the section's image hrefs are: this
                // def is mounted on /api/music AND /api/v1/music, and sharing
                // one entry across both hands whichever caller loses the race a
                // set of URLs its auth gate rejects.
                `v4:sonic-fingerprint:${ctx.surface}:${user.userId}:limit=${limit}`,
                accessCtx,
            );

            const cached = await fingerprintCache.get<CachedSection>(cacheKey);
            if (cached) {
                logger.debug('Sonic fingerprint cache hit', { username: user.username });
                return json(cached.section);
            }

            // The query module takes a REQUIRED access boundary — this real
            // user's library/age scope, never a permissive default.
            const result = await findSonicFingerprintNeighbors(
                sql,
                user.userId,
                limit,
                searchAccessBoundary(accessCtx),
            );

            logger.debug('Sonic fingerprint computed', {
                username: user.username,
                seedCount: result.meta.seedCount,
                hasSufficientHistory: result.meta.hasSufficientHistory,
                accessDenied: result.meta.accessDenied,
                resultCount: result.tracks.length,
            });

            // A deny-everything boundary is an access outcome, not a "this user
            // has no play history" outcome — don't bake it into the negative
            // cache entry, which is keyed by an access suffix that cannot
            // currently distinguish the two.
            if (result.meta.accessDenied) return json(null);

            if (!result.meta.hasSufficientHistory || result.tracks.length === 0) {
                await fingerprintCache.set(cacheKey, { section: null });
                return json(null);
            }

            const imageSets = await resolveImageSets(
                sql,
                ctx.surface,
                result.tracks.map((row) => ({ id: row.media_id, mediaType: 'track' })),
            );
            const tracks = result.tracks.map((row) =>
                rowToTrack(row, imageSets.get(row.media_id) ?? {}),
            );
            const section = buildSonicFingerprintSection(tracks);

            await fingerprintCache.set(cacheKey, { section });

            return json(section);
        },
    },
});
