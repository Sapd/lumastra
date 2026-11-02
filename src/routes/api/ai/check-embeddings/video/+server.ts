// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { aiDbService } from '$lib/server/services/database.service';
import { VideoEmbeddingStatsSchema, type EmbeddingSample } from '$lib/schemas/admin-types';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    getVideoEmbeddingStats,
    type EmbeddingItemRow,
} from '$lib/server/database/queries/embedding-stats.queries.js';

function mapItemRow(e: EmbeddingItemRow): EmbeddingSample & { createdAt?: string } {
    const provider = getPrimaryExternalIdProvider();
    return {
        id: e.id,
        externalIds: {
            internal: e.id,
            ...(e.primary_ext_id ? { [provider]: e.primary_ext_id } : {}),
        },
        title: e.title,
        mediaType: e.media_type,
        genres: e.genres,
        ...(e.created_at ? { createdAt: e.created_at.toISOString() } : {}),
    };
}

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            const { quality, coverage, recent, noExternalId, sample } =
                await getVideoEmbeddingStats(sql);

            const q = quality[0];
            const c = coverage[0];

            return json(
                VideoEmbeddingStatsSchema.parse({
                    dataQuality: {
                        withMdblistKeywords: Number(q.with_mdblist_keywords),
                        withMdblistScore: Number(q.with_mdblist_score),
                        withStreamingServices: Number(q.with_streaming_services),
                        missingGenres: Number(q.missing_genres),
                        missingOverview: Number(q.missing_overview),
                        missingActors: Number(q.missing_actors),
                        missingDirectors: Number(q.missing_directors),
                        veryShortOverview: Number(q.very_short_overview),
                        avgOverviewLength: Number(q.avg_overview_length),
                        avgActorCount: Number(q.avg_actor_count),
                        avgGenreCount: Number(q.avg_genre_count),
                    },
                    embeddingCoverage: {
                        libraryEmbeddings: Number(c.has_library_embedding),
                        primaryProviderEmbeddings: Number(c.has_discovery_embedding),
                        bothEmbeddings: Number(c.has_both_embeddings),
                        noEmbeddings: Number(c.no_embeddings),
                    },
                    recentItems: recent.map(mapItemRow),
                    sample: sample.map(mapItemRow),
                    noExternalIdItems: noExternalId.map((e) => ({
                        ...mapItemRow(e),
                        genres: null,
                    })),
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
