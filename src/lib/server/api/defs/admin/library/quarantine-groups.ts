// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/quarantine-groups.ts
 *
 * GET /api/admin/library/quarantine-groups
 *
 * Per-series view of the unresolved `sync_quarantine` backlog for the
 * `/admin/library/quarantine` bulk triage surface. Rows concentrate in a
 * small number of series (a single reconciliation-backfill run over one
 * series can quarantine dozens of episodes at once) — nobody reviews
 * thousands of rows individually, so this groups by series and lets an
 * operator act on a whole group at once (see quarantine-groups-resolve.ts).
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response: bare object { groups: QuarantineSeriesGroup[] }
 * 503 dependency_unavailable on DB down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listUnresolvedQuarantineBySeries,
    listQuarantineDispositionHistory,
} from '$lib/server/database/queries/sync-quarantine.queries.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: { query: z.object({ historyAfter: z.uuid().optional() }) },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const groups = await listUnresolvedQuarantineBySeries(sql);

            const history = await listQuarantineDispositionHistory(
                sql,
                ctx.input?.query.historyAfter,
            );
            return json({
                history,
                groups: groups.map((g) => ({
                    seriesId: g.seriesId,
                    parentTmdbId: g.parentTmdbId,
                    seriesTitle: g.seriesTitle,
                    totalUnresolved: g.totalUnresolved,
                    fingerprint: g.fingerprint,
                    reasonCounts: g.reasonCounts,
                    oldestCreatedAt: g.oldestCreatedAt.toISOString(),
                    newestCreatedAt: g.newestCreatedAt.toISOString(),
                })),
            });
        },
    },
});
