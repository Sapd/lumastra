// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /runs — list task runs.
 *
 * Dual-mounted def: backs both `/api/v1/runs` (token surface) and `/api/runs`
 * (internal forward-auth/cookie surface). This is the B1 facade port of the
 * former bespoke `/api/v1/runs/+server.ts` legacy handler. Execution, filters,
 * scope (`runs:read`) and query-validation status (HTTP 400) are preserved;
 * the HTTP list uses the standard items/page envelope.
 *
 * Auth scope: runs:read.
 *
 * NOTE: query validation is performed IN-HANDLER (not via the def `request`
 * slot) on purpose — the legacy route used `withValidation`, which rejects bad
 * query params with HTTP 400 via `ApiResponses.validationError`. mount()'s
 * declarative `request.query` slot would instead reject with HTTP 422. Keeping
 * the validation in-handler preserves the original 400 contract verbatim.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { problem } from '$lib/server/api/problem.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { getTaskDb } from '$lib/server/database/connection.js';
import type { Run, RunState } from '@sapd/lumastra-plugin-sdk';
import type postgres from 'postgres';
import { V1RunsQuerySchema } from '$lib/schemas/api-query-params.js';
import { toPublicRun } from '$lib/server/tasks/run-event.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { RunListResponseSchema } from '$lib/schemas/run.schema.js';
import { z } from 'zod';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder.js';
import { buildSeriesOwnedAgeRatingFilter } from '$lib/server/database/queries/builders/age-rating.builder.js';
import { deniesEverything } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { resolveScopeGatedAccessBoundary } from '$lib/server/utils/scope-gated-access-boundary.js';

const RunsQuerySchema = V1RunsQuerySchema.omit({ groupBy: true });

const VALID_RUN_STATES: ReadonlySet<RunState> = new Set([
    'pending',
    'active',
    'cancelling',
    'completed',
    'failed',
    'cancelled',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve the media item a run acts upon.
 *
 * `scope.subjectId` is the explicit, indexed answer. The `input.mediaItemId`
 * fallback is retained deliberately: nine non-test source files pass
 * `mediaItemId` in input and only the media-page endpoints set `subject`, so
 * removing it now would strip titles from the rest of /admin/tasks/runs. Drop
 * the fallback once every startRun site sets `subject`.
 */
export function mediaItemIdForRun(run: {
    scope?: { subjectId?: string } | undefined;
    input: unknown;
}): string | undefined {
    const fromScope = run.scope?.subjectId;
    if (typeof fromScope === 'string' && UUID_RE.test(fromScope)) return fromScope;
    if (typeof run.input !== 'object' || run.input === null) return undefined;
    const id = (run.input as Record<string, unknown>).mediaItemId;
    return typeof id === 'string' && UUID_RE.test(id) ? id : undefined;
}

/**
 * `access` is REQUIRED (C4, 2026-09-18 fix-plan-4 Task 2). This used to
 * select `title` with no library-group or age predicate at all, grafting a
 * media title onto every run system-wide — including runs the caller never
 * triggered, for a media item in a library group (or above the age ceiling)
 * they are denied. (The 2026-09-13 P4 ruling that kept the list on every
 * non-admin session was reversed 2026-10-07: `runs:read` now comes only with
 * `tasks:admin`.) This fixes the join independently of the gate — see the
 * caller in `handlers.GET` for how the boundary is resolved from the request.
 */
export async function resolveRunMediaItems(
    sql: postgres.Sql,
    runs: Run[],
    access: MediaAccessBoundary,
): Promise<Map<string, { id: string; title: string; fileName?: string }>> {
    const ids = [
        ...new Set(
            runs
                .map((run) => mediaItemIdForRun(run))
                .filter((id): id is string => id !== undefined),
        ),
    ];
    if (ids.length === 0) return new Map();
    if (deniesEverything(access)) return new Map();

    const rows = await sql<Array<{ id: string; title: string }>>`
        SELECT
            mi.id::text AS id,
            mi.title
        FROM media_items mi
        WHERE mi.id = ANY(${ids}::uuid[])
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildSeriesOwnedAgeRatingFilter(sql, access.age)}
    `;

    return new Map(
        rows.map((row) => [
            row.id,
            {
                id: row.id,
                title: row.title,
            },
        ]),
    );
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Runs'],
            summary: 'List task runs',
            stability: 'beta',
            description:
                'Returns recent task runs, optionally filtered by task or state, with pagination. Requires `read` scope.',
            // Mirrors V1RunsQuerySchema, which is the authoritative contract —
            // this block had drifted (it documented an unimplemented `offset`
            // and omitted parentRunId/libraryGroupId/subjectId/cursor).
            query: z.object({
                taskId: z.string().optional().meta({ description: 'Filter by task id' }),
                state: z.string().optional().meta({
                    description: 'Filter by run state (comma-separated for multiple)',
                }),
                parentRunId: z
                    .string()
                    .optional()
                    .meta({ description: 'Filter to children of this run' }),
                libraryGroupId: z
                    .string()
                    .optional()
                    .meta({ description: 'Filter by library group id' }),
                subjectId: z.string().optional().meta({
                    description: 'Filter to runs acting on this subject (e.g. a media item id)',
                }),
                limit: z.coerce.number().optional().meta({ description: 'Max runs to return' }),
                cursor: z
                    .string()
                    .optional()
                    .meta({ description: 'Opaque pagination cursor from a previous response' }),
                since: z.string().optional().meta({
                    description: 'Only return runs started at or after this ISO timestamp',
                }),
            }),
            responses: {
                200: {
                    schema: RunListResponseSchema,
                    description: 'Paginated runs list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'scope', anyOf: ['runs:read'] },
    handlers: {
        GET: async (event) => {
            // Query validation — preserve the legacy withValidation() 400 path.
            // Object.fromEntries drops duplicate keys (last wins); the schema
            // uses comma-separated strings for multi-value fields, matching the
            // original middleware behaviour.
            const parsed = RunsQuerySchema.safeParse(Object.fromEntries(event.url.searchParams));
            if (!parsed.success) {
                // Field naming mirrors validate.ts formatZodError() for the
                // 'query' source verbatim: `query.<path>` (body is the only
                // source that special-cases an empty path).
                const errors = parsed.error.issues.map((issue) => ({
                    field: `query.${issue.path.join('.')}`,
                    message: issue.message,
                }));
                return ApiResponses.validationError(errors, event.url.pathname);
            }

            const {
                state: stateParam,
                taskId,
                parentRunId,
                libraryGroupId,
                subjectId,
                limit,
                cursor,
                since: sinceParam,
            } = parsed.data;

            const since = sinceParam ? new Date(sinceParam) : undefined;

            let state: RunState[] | undefined;
            if (stateParam) {
                const requested = stateParam
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                const unknown = requested.filter((s) => !VALID_RUN_STATES.has(s as RunState));
                if (unknown.length > 0) {
                    return problem('validation_failed', {
                        error: `Unknown state(s): ${unknown.join(', ')}. Valid: ${[...VALID_RUN_STATES].join(', ')}`,
                    });
                }
                state = requested as RunState[];
            }

            const result = await orchestrator.listRuns({
                state,
                taskId,
                parentRunId,
                libraryGroupId,
                subjectId,
                limit,
                cursor,
                since,
            });

            // Drop error.stack and the internal trigger.idempotencyKey (see tasks/run-event.ts).
            const safeRuns = result.runs.map(toPublicRun);

            // KNOWN ASYMMETRY (not fixed by this task — recorded per review round 1):
            // buildSearchAccessContext (search-access-context.ts:82-87) applies the
            // age filter from user.maxAgeRating regardless of isAdmin, unlike the
            // library-group axis, which short-circuits for admins
            // (library-group-permissions-cache.ts:121). An admin whose maxAgeRating
            // happens to be non-null will silently lose titles here for
            // over-rated items. Pre-existing semantics on a widely-used shared
            // helper; out of this task's scope/risk budget to change.
            const sql = getTaskDb();
            const mediaItems = sql
                ? await resolveRunMediaItems(
                      sql,
                      safeRuns,
                      await resolveScopeGatedAccessBoundary(sql, event.locals.user),
                  )
                : new Map();
            const runsWithMediaItems = safeRuns.map((run) => {
                const mediaItemId = mediaItemIdForRun(run);
                const mediaItem = mediaItemId ? mediaItems.get(mediaItemId) : undefined;
                return mediaItem ? { ...run, mediaItem } : run;
            });

            return typedJson(RunListResponseSchema, {
                items: runsWithMediaItems,
                page: {
                    limit,
                    hasMore: !!result.nextCursor,
                    ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
                },
            });
        },
    },
});
