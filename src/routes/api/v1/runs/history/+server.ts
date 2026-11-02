// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { problem } from '$lib/server/api/problem.js';
import { authenticate, requireScope } from '$lib/server/tasks/api-auth.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    historyTrimQuerySchema,
    historyTrimResponseSchema,
    type HistoryTrimResponse,
} from '$lib/schemas/admin.js';
import { Logger } from '$lib/server/utils/logger.js';
import { trimTaskHistory } from '$lib/server/services/task-history-trim.service.js';

const log = Logger.for('api.v1.runs.history');

// ── INTENTIONAL EXCEPTION: hand-written route (not defineEndpoint/mount) ───────
//
// Every sibling tasks/runs/queues route is a mount()ed def under
// `src/lib/server/api/defs/runs/` with an auto-generated `+server.ts`. This one
// deliberately keeps inline `authenticate()` + `requireScope(auth,'tasks:admin')`
// instead of porting to a def, because the port is non-trivial and higher-risk
// than the value:
//   1. It exercises the unusual DELETE-with-body legacy call style (query params
//      first, JSON body fallback) — awkward to express in a declarative
//      `request` slot without changing the accepted shape.
//   2. Preserving the exact status-code contract (400 on bad query, the
//      `kind: already-running | partial | complete` 200 envelope validated by
//      `buildResponse`) is fiddly under mount()'s declarative validation, which
//      defaults query-validation failures to 422 (see the note in
//      `defs/runs/index.ts` about the same 400-vs-422 divergence).
//   3. Porting means regenerating the whole v1 route surface via
//      `scripts/gen-api-routes.ts` — a broad, generated-file diff for one route.
// The inline auth below is correct and uses the same `tasks:admin` scope the def
// path would. Tracked for a future consolidation pass; do NOT "fix" piecemeal.

function buildResponse(body: HistoryTrimResponse, status = 200): Response {
    const parsed = historyTrimResponseSchema.safeParse(body);
    if (!parsed.success) {
        log.error('historyTrimResponseSchema validation failed', undefined, {
            issues: parsed.error.issues,
        });
        return problem('internal_error', { error: 'response schema validation failed' });
    }
    return Response.json(parsed.data, { status });
}

export const DELETE: RequestHandler = withErrorHandler(async (event) => {
    const auth = await authenticate(event);
    requireScope(auth, 'tasks:admin');

    // Collect query params from URL string first; fall back to JSON body to
    // preserve the previous DELETE-with-body call style for legacy clients.
    const qpRecord: Record<string, string> = {};
    const qpOlder = event.url.searchParams.get('olderThanDays');
    const qpTaskType = event.url.searchParams.get('taskType');
    if (qpOlder !== null) qpRecord.olderThanDays = qpOlder;
    if (qpTaskType !== null) qpRecord.taskType = qpTaskType;

    if (qpRecord.olderThanDays === undefined) {
        try {
            const body = (await readBoundedJson(event.request)) as Record<string, unknown>;
            if (body && typeof body.olderThanDays === 'number') {
                qpRecord.olderThanDays = String(body.olderThanDays);
            }
            if (typeof body?.taskType === 'string') {
                qpRecord.taskType = body.taskType;
            }
        } catch {
            // No body, invalid JSON — fall through to schema validation.
        }
    }

    const parsed = historyTrimQuerySchema.safeParse(qpRecord);
    if (!parsed.success) {
        return problem('validation_failed', {
            error: `Invalid query: ${parsed.error.issues.map((i) => i.message).join(', ')}`,
        });
    }
    const { olderThanDays, taskType } = parsed.data;

    const sql = getDb();
    if (!sql) {
        return problem('dependency_unavailable', { error: 'database unavailable' });
    }

    const signal: AbortSignal | undefined = event.request.signal ?? undefined;

    const result = await trimTaskHistory(sql, {
        olderThanDays,
        taskType: taskType ?? undefined,
        signal,
    });

    if (result.kind === 'already-running') {
        return buildResponse({
            kind: 'already-running',
            deleted: 0,
            message: result.message,
        });
    }
    if (result.kind === 'partial') {
        return buildResponse({
            kind: 'partial',
            deleted: result.deleted,
            message: result.message,
            reason: result.reason,
        });
    }
    return buildResponse({
        kind: 'complete',
        deleted: result.deleted,
        message: result.message,
    });
});
