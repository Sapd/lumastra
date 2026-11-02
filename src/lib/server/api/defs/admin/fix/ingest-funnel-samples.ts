// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/ingest-funnel/samples — the files behind one funnel count.
 *
 * GET /api/admin/fix/ingest-funnel/samples?kind=…&mediaType=… → IngestFunnelSamples.
 * Auth: admin. Errors: problem+json.
 *
 * The funnel says "10 files reached no library entry"; a count with no way to
 * see which ten leaves the operator exactly where a user report would have.
 * This lists them, using the same per-file predicates the count was made with.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { loadIngestFunnelSamples } from '$lib/server/database/queries/ingest-funnel.queries.js';
import {
    FunnelSampleKindSchema,
    type IngestFunnelSamples,
} from '$lib/components/admin/fix/ingest-funnel.schema.js';

/** Evidence to act on, not an inventory — the full list is one trace away. */
const MAX_SAMPLES = 100;

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            kind: FunnelSampleKindSchema,
            mediaType: z.string().trim().min(1).max(40).optional(),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const { kind, mediaType } = ctx.input!.query;
            // One extra row tells us whether there are more without a second COUNT.
            const rows = await loadIngestFunnelSamples(
                sql,
                kind,
                mediaType ?? null,
                MAX_SAMPLES + 1,
            );

            const payload: IngestFunnelSamples = {
                samples: rows.slice(0, MAX_SAMPLES),
                truncated: rows.length > MAX_SAMPLES,
            };
            return json(payload);
        },
    },
});
