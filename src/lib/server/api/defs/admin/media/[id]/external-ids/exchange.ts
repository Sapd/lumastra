// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Admin-only two-episode TMDB exchange. GET previews; POST confirms the reviewed snapshot. */
import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    createCatalogService,
    EpisodeTmdbExchangeError,
} from '$lib/server/services/catalog.service.js';
import {
    EpisodeTmdbExchangeConfirmSchema,
    EpisodeTmdbExchangePreviewSchema,
} from '$lib/schemas/episode-tmdb-exchange.js';
import { auditActor } from '$lib/server/utils/audit-log.js';

function problem(error: EpisodeTmdbExchangeError): Response {
    if (error.reason === 'changed' || error.reason === 'outside_owner') {
        return ApiProblem.conflict(error.message);
    }
    if (error.reason === 'not_found') return ApiProblem.notFound(error.message);
    return ApiProblem.validationFailed(error.message);
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({ otherId: z.uuid().optional() }),
        // mount applies this only to methods with bodies, not the GET preview.
        body: EpisodeTmdbExchangeConfirmSchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const firstId = adminMediaId(event);
            if (!firstId) return ApiProblem.notFound('Episode not found');
            const otherId = ctx.input!.query.otherId;
            if (!otherId) return ApiProblem.validationFailed('otherId is required');
            try {
                const preview = await createCatalogService(sql).previewEpisodeTmdbExchange(
                    firstId,
                    otherId,
                );
                return json(EpisodeTmdbExchangePreviewSchema.parse(preview));
            } catch (error) {
                if (error instanceof EpisodeTmdbExchangeError) return problem(error);
                throw error;
            }
        },
        POST: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const firstId = adminMediaId(event);
            if (!firstId) return ApiProblem.notFound('Episode not found');
            const { otherId, snapshot, undoReceiptId } = ctx.input!.body;
            try {
                const result = await createCatalogService(sql).exchangeEpisodeTmdbIds(
                    firstId,
                    otherId,
                    snapshot,
                    auditActor(event),
                    undoReceiptId,
                );
                return json(EpisodeTmdbExchangePreviewSchema.parse(result));
            } catch (error) {
                if (error instanceof EpisodeTmdbExchangeError) return problem(error);
                throw error;
            }
        },
    },
});
