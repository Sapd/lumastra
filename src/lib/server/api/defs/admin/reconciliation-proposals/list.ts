// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/reconciliation-proposals/list.ts
 *
 * GET /api/admin/reconciliation-proposals?seriesId=&limit=
 *
 * Open absolute-numbering proposals (`sync_quarantine` rows of reason
 * `absolute-numbering:proposed`): a file-backed episode that would move to the
 * position of a TMDB episode and adopt its identity. POST .../{quarantineId}/apply
 * applies one, POST .../{quarantineId}/dismiss rejects it for good.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: bare object { proposals: ReconciliationProposal[] }
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { listUnresolvedQuarantineByReason } from '$lib/server/database/queries/sync-quarantine.queries.js';
import {
    ABSOLUTE_NUMBERING_PROPOSED_REASON,
    ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER,
} from '$lib/server/services/absolute-numbering-reconciliation.service.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

const querySchema = z.object({
    seriesId: z.string().regex(UUID_RE, 'Invalid UUID').optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
});

function str(v: unknown): string | undefined {
    return typeof v === 'string' && v !== '' ? v : undefined;
}

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
            const entries = await listUnresolvedQuarantineByReason(sql, {
                provider: ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER,
                reason: ABSOLUTE_NUMBERING_PROPOSED_REASON,
                seriesId,
                limit,
            });

            const proposals = entries.flatMap((e) => {
                const p = e.payload;
                const fromSeason = p.fromSeason;
                const fromEpisode = p.fromEpisode;
                const toSeason = p.toSeason;
                const toEpisode = p.toEpisode;
                if (
                    typeof p.episodeId !== 'string' ||
                    typeof fromSeason !== 'number' ||
                    typeof fromEpisode !== 'number' ||
                    typeof toSeason !== 'number' ||
                    typeof toEpisode !== 'number'
                ) {
                    return [];
                }
                return [
                    {
                        id: e.id,
                        seriesId: e.expectedSeriesId ?? str(p.seriesMediaId),
                        seriesTitle: e.seriesTitle ?? undefined,
                        episodeId: p.episodeId,
                        fromSeason,
                        fromEpisode,
                        toSeason,
                        toEpisode,
                        currentTitle: str(p.currentTitle),
                        proposedTitle: str(p.proposedTitle),
                        evidence: str(p.evidence),
                        createdAt: e.createdAt.toISOString(),
                    },
                ];
            });

            return json({ proposals });
        },
    },
});
