// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/health/index.ts
 *
 * GET /api/admin/media/[id]/health
 *
 * Returns a series' health, measured live: episodes held vs. the provider's
 * list (`getSeriesEpisodeCoverage`), chapter count, and ordering health.
 * POST /health/analyze adds the unlinked-episode list for the ordering.
 *
 * This used to return a `series_health_reports` row and `null` without one.
 * Nothing has written that table since March, so the report — including the
 * ordering health riding on it — was null for every series.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { report: HealthReport | null }
 * 503 dependency_unavailable when DB is down.
 */

import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    coverageHealthStatus,
    getSeriesEpisodeCoverage,
} from '$lib/server/database/queries/series-health.queries.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import { countEpisodesWithChapters } from '$lib/server/database/queries/episode-chapters.queries.js';
import {
    MediaHealthResponseSchema,
    type MediaHealthResponse,
} from '$lib/schemas/api-media-responses.js';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Ordering health helper (extracted from original route)
// ---------------------------------------------------------------------------

interface OrderingHealthRow {
    ordering_type: string;
    ordering_provider: string | null;
    ordering_group_id: string | null;
    total: string;
    linked: string;
}

async function getOrderingHealth(
    sql: postgres.Sql,
    seriesId: string,
): Promise<{
    isActive: boolean;
    orderingType: string | null;
    provider: string | null;
    groupId: string | null;
    linked: number;
    unlinked: number;
    total: number;
    linkRatio: number;
} | null> {
    const rows = await sql<OrderingHealthRow[]>`
        SELECT
            seo.ordering_type,
            seo.ordering_provider,
            seo.ordering_group_id,
            COUNT(*)::text AS total,
            COUNT(eo.episode_media_id)::text AS linked
        FROM series_episode_ordering seo
        JOIN episode_orderings eo
            ON eo.series_media_id = seo.media_id
            AND eo.ordering_type = seo.ordering_type
            AND eo.ordering_group_id = seo.ordering_group_id
        WHERE seo.media_id = ${seriesId}
            AND seo.ordering_type != 'standard'
        GROUP BY seo.ordering_type, seo.ordering_provider, seo.ordering_group_id
    `;
    if (!rows[0]) return null;
    const total = parseInt(rows[0].total, 10);
    const linked = parseInt(rows[0].linked, 10);
    return {
        isActive: true,
        orderingType: rows[0].ordering_type,
        provider: rows[0].ordering_provider,
        groupId: rows[0].ordering_group_id,
        linked,
        unlinked: total - linked,
        total,
        linkRatio: total > 0 ? linked / total : 0,
    };
}

// ---------------------------------------------------------------------------
// Response schema — single source in $lib/schemas/api-media-responses.
// Also referenced by the v1 _openapi.ts at routes/api/v1/media/[id]/health.
// ---------------------------------------------------------------------------

export const HealthGetResponseSchema = MediaHealthResponseSchema;

export type HealthGetResponse = MediaHealthResponse;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const [coverage, chaptersAvailable, orderingHealth] = await Promise.all([
                getSeriesEpisodeCoverage(sql, getPrimaryExternalIdProvider(), internalId),
                countEpisodesWithChapters(sql, internalId),
                getOrderingHealth(sql, internalId),
            ]);
            // Not a series, or a series with no episode rows: nothing to judge.
            if (!coverage && !orderingHealth) {
                return json(HealthGetResponseSchema.parse({ report: null }));
            }

            const report = {
                computed: false as const,
                status: coverage ? coverageHealthStatus(coverage) : 'unknown',
                episodeCountLocal: coverage?.episodesHeld ?? 0,
                episodeCountProvider: coverage?.episodesListed ?? 0,
                seasonCountLocal: coverage?.seasonsHeld ?? 0,
                seasonCountProvider: coverage?.seasonsListed ?? 0,
                seasonComparisons: [] as never[],
                mismatchedSeasons: [] as never[],
                // The snapshot's episode-group suggestion came from the deleted TMDB analyser.
                suggestedGroupId: null,
                suggestedGroupName: null,
                suggestedConfidence: null,
                groupScores: [] as never[],
                chaptersAvailable,
                orderingHealth,
            };

            return json(HealthGetResponseSchema.parse({ report }));
        },
    },
});
