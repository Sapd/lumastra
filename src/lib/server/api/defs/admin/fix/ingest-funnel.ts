// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/ingest-funnel — how far files get, and where they stop.
 *
 * GET /api/admin/fix/ingest-funnel → IngestFunnel.
 * Auth: admin. Errors: problem+json.
 *
 * ## Finds problems nobody reported
 *
 * Every other page on this surface answers a question the operator brought.
 * This one asks the question for them: the same joins `where-is-it` uses per
 * title, aggregated. A drop-off here is a bug that would otherwise be
 * discovered one title at a time, months apart, each reported as "this one film
 * is missing".
 *
 * ## Segmented, because an unsegmented funnel lies
 *
 * Measured on production before this existed: 28,997 files linked to an entry
 * with no provider id — of which 28,258 were music tracks, 100% of the library's
 * tracks, because tracks are not identified that way at all. The headline would
 * have been a fabricated 29k problem, and the real finding underneath it (726
 * episodes, 7 movies) would have been invisible.
 *
 * Identification is therefore evaluated only for types where a provider id is
 * expected, and `identified: null` means not-applicable rather than zero.
 *
 * ~210ms over 79k files on production; on-demand only, never on a loop.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { loadIngestFunnel } from '$lib/server/database/queries/ingest-funnel.queries.js';
import { findingsFor, type IngestFunnel } from '$lib/components/admin/fix/ingest-funnel.schema.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not configured');

            const funnel = await loadIngestFunnel(sql);

            const payload: IngestFunnel = {
                generatedAt: new Date().toISOString(),
                missingFiles: funnel.missingFiles,
                orphanFiles: funnel.orphanFiles,
                removedEntryFiles: funnel.removedEntryFiles,
                segments: funnel.segments,
                // Computed server-side from the same segments the page renders,
                // so the summary and the table can never tell different stories.
                findings: findingsFor(funnel.segments),
            };

            return json(payload);
        },
    },
});
