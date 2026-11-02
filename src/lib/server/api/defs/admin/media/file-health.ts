// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Admin-only physical-file health page and guarded selected-file recheck. */

import { FileHealthRecheckRequestSchema } from '$lib/schemas/file-health-recheck.js';
import { enqueueFileHealthRecheck } from '$lib/server/tasks/file-health-recheck.js';
import { getFileHealthSnapshot } from '$lib/server/database/queries/media-files.queries.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, problem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFileHealthPage } from '$lib/server/database/queries/file-health-page.queries.js';
import { FileHealthResponseSchema, FileHealthQuerySchema } from '$lib/schemas/admin-file-health.js';

export { FileHealthResponseSchema };
export type { FileHealthResponse } from '$lib/schemas/admin-file-health.js';
// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: { body: FileHealthRecheckRequestSchema, bodyMethods: ['POST'] },
    handlers: {
        POST: async (event, ctx) => {
            const parsed = FileHealthRecheckRequestSchema.safeParse(
                ctx.input?.body ?? (await event.request.json()),
            );
            if (!parsed.success) return problem('validation_failed', { error: 'Invalid file id' });
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            if (!(await getFileHealthSnapshot(sql, parsed.data.fileId)))
                return ApiProblem.notFound('File not found');
            const accepted = await enqueueFileHealthRecheck(parsed.data.fileId, event);
            if (accepted instanceof Response) return accepted;
            return json(accepted, { status: accepted.deduped ? 200 : 202 });
        },
        GET: async (event) => {
            const parsed = FileHealthQuerySchema.safeParse({
                scope: event.url.searchParams.get('scope') ?? undefined,
                cursor: event.url.searchParams.get('cursor') ?? undefined,
            });
            if (!parsed.success)
                return problem('validation_failed', {
                    error: 'Invalid file-health filter or cursor',
                });
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            return json(FileHealthResponseSchema.parse(await getFileHealthPage(sql, parsed.data)));
        },
    },
});
