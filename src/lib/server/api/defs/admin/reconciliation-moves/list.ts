// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/reconciliation-moves/list.ts
 *
 * GET /api/admin/reconciliation-moves?seriesId=&limit=
 *
 * Episodes the absolute-numbering and season-structure reconciliation applied,
 * newest first, undone ones included. Each row carries the position the episode
 * sat at before and the one it was moved to; POST .../{id}/undo reverses it.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: bare object { moves: ReconciliationMove[] }
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listReconciliationMoves } from '$lib/server/database/queries/episode-reconciliation-moves.queries.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const querySchema = z.object({
    seriesId: z.string().regex(UUID_RE, 'Invalid UUID').optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
});

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        query: querySchema,
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { seriesId, limit } = ctx.input!.query;
            const moves = await listReconciliationMoves(sql, { seriesId, limit });

            return json({
                moves: moves.map((m) => ({
                    id: m.id,
                    seriesId: m.seriesId,
                    seriesTitle: m.seriesTitle ?? undefined,
                    episodeId: m.episodeId ?? undefined,
                    episodeTitle: m.episodeTitle ?? undefined,
                    service: m.service,
                    evidence: m.evidence ?? undefined,
                    tmdbEpisodeId: m.tmdbEpisodeId,
                    fromSeason: m.fromSeason,
                    fromEpisode: m.fromEpisode,
                    toSeason: m.toSeason,
                    toEpisode: m.toEpisode,
                    appliedAt: m.appliedAt.toISOString(),
                    undoneAt: m.undoneAt?.toISOString(),
                    undoneBy: m.undoneBy ?? undefined,
                })),
            });
        },
    },
});
