// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/library/paths.ts — GET /api/v1/library/paths
 *
 * Lists all configured library paths. Requires `tasks:admin` scope.
 *
 * Phase 3 port of the hand-written `src/routes/api/v1/library/paths/+server.ts`
 * (which did `authenticate()` + `requireScope(auth, 'tasks:read')`).
 *   - Response: bare `{ paths: LibraryPath[] }` object.
 *   - 503 `dependency_unavailable` when the AI database is down.
 *
 * v1-only: this def is HAND-MOUNTED from the bespoke v1 `+server.ts` (no marker),
 * so `gen-api-routes.ts`'s `discoverHandMountedDefs()` detects the import and
 * leaves it alone — no internal (`/api/library/paths`) twin is generated. Since
 * `/api/v1` is Bearer-only (forward-auth.ts's `handleApiV1Auth` never consults
 * forward-auth session headers), the true population reachable before this fix
 * was every Bearer credential (PAT / service token / device-flow JWT) whose
 * token carried `read` or `write` — NOT "every logged-in user" (a plain
 * forward-auth browser session cannot reach this endpoint at all, v1-only and
 * cookie-less).
 *
 * Auth WAS `tasks:read` scope, moved to `tasks:admin` (C5, 2026-09-18
 * fix-plan-4 Task 2 — this endpoint hands the operator's absolute host
 * filesystem layout, plus the full library-group inventory, to any such
 * credential; see `library-path.mapper.ts`'s `path`/`providerPath` fields).
 * Belt-and-braces on top of the load-bearing fix: `tasks:read`'s auto-grant
 * to every non-admin session was removed in the same task (principal.ts
 * `expandScopes` + tasks/api-auth.ts `scopeGranted` — see ledger.md "Shape C"
 * ruling), so `tasks:read` alone would already be admin-only in practice.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';
import { LibraryPathSchema } from '$lib/schemas/api-admin-library-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['tasks:admin'] },
    docs: {
        GET: {
            visibility: 'internal',
            tags: ['Library'],
            summary: 'List library paths',
            stability: 'stable',
            description: 'Returns all configured library paths. Requires `tasks:admin` scope.',
            responses: {
                200: {
                    // The handler maps rows through mapLibraryPathToApi (14 fields);
                    // the old inline schema declared 5 and required name/rootPath the
                    // mapper never emits. Reuse the canonical LibraryPathSchema.
                    schema: z.object({
                        paths: z
                            .array(LibraryPathSchema)
                            .meta({ description: 'Configured library paths' }),
                    }),
                    description: 'Library paths list',
                },
                401: 'Authentication required',
                403: 'Insufficient scope',
            },
        },
    },
    handlers: {
        GET: async () => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('AI database unavailable');
            const rows = await getAllLibraryPaths(sql);
            return json({ paths: rows.map(mapLibraryPathToApi) });
        },
    },
});
