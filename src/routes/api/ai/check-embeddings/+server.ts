// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { EmbeddingOverviewStatsSchema } from '$lib/schemas/admin-types';
import { getEmbeddingOverviewStats } from '$lib/server/database/queries/embedding-stats.queries.js';

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            // Admin dashboard read — run on the dedicated admin pool, isolated from
            // the playback hot path on the web pool.
            const sql = getAdminDb();

            if (!sql) {
                return ApiProblem.dependencyUnavailable(
                    'AI admin database is currently unavailable',
                );
            }

            const { mediaTypeCounts, sourceCounts, overviewCounts } =
                await getEmbeddingOverviewStats(sql);

            const overview = overviewCounts[0];
            const totalItems = mediaTypeCounts.reduce((sum, r) => sum + parseInt(r.count, 10), 0);

            return json(
                EmbeddingOverviewStatsSchema.parse({
                    totalItems,
                    mediaTypeBreakdown: mediaTypeCounts.map((r) => ({
                        mediaType: r.media_type,
                        count: parseInt(r.count, 10),
                    })),
                    embeddingSourceBreakdown: sourceCounts.map((r) => ({
                        source: r.source,
                        count: parseInt(r.count, 10),
                    })),
                    withoutExternalId: parseInt(overview?.without_external_id ?? '0', 10),
                    inLibrary: parseInt(overview?.in_library ?? '0', 10),
                    requestableOnly: parseInt(overview?.requestable_only ?? '0', 10),
                }),
            );
        },
    },
});

const { GET } = mount(def, { surface: 'internal' });
export { GET };
