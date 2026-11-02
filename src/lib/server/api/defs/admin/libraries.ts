// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/libraries.ts
 *
 * POST /api/admin/libraries
 *
 * Composite "create a library" endpoint: creates a library group + its paths
 * in one transaction. Powers the fresh-install setup wizard.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (201): { group, paths }
 * 503 dependency_unavailable on DB down.
 * 422 validation_failed on bad input (empty/duplicate paths etc.).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { librarySetupBodySchema } from '$lib/schemas/admin.js';
import {
    createLibrary,
    LibrarySetupValidationError,
} from '$lib/server/services/library-setup.service.js';
import { mapLibraryGroupToApi } from '$lib/server/mappers/library-group.mapper.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: librarySetupBodySchema,
    },
    handlers: {
        POST: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            try {
                const { group, paths } = await createLibrary(sql, ctx.input!.body);
                return json(
                    {
                        group: mapLibraryGroupToApi(group),
                        paths: paths.map(mapLibraryPathToApi),
                    },
                    { status: 201 },
                );
            } catch (err) {
                // Only the operator-fixable rejections are 4xx. Anything else
                // (DB down, a failure after the commit) used to be reported as
                // a 422 with a raw message — and as "create failed" when the
                // library had in fact been created.
                if (!(err instanceof LibrarySetupValidationError)) throw err;
                return err.conflict
                    ? ApiProblem.conflict(err.message)
                    : ApiProblem.validationFailed(err.message);
            }
        },
    },
});
