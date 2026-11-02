// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/libraries-item.ts
 *
 * PATCH /api/admin/libraries/[id]
 *
 * Library settings save (the per-library page's "Settings" section):
 * name/icon/description/max_age_rating live on the `library_groups` row;
 * media_type/provider/fallback_providers are library-level facts fanned out
 * to EVERY `library_paths` row of the group in one transaction (see
 * `updateLibrary` in `library-update.service.ts`). All fields optional.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (200): { group, paths }
 * 404 not_found when the library does not exist.
 * 409 conflict when the library contains a remote-source folder (e.g.
 *     AudiobookShelf) and media_type/provider would change for it.
 * 422 validation_failed when media_type would change to audiobook for a
 *     folder library (audiobooks come only from AudiobookShelf).
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { libraryUpdateBodySchema } from '$lib/schemas/admin.js';
import {
    updateLibrary,
    RemoteLibraryConflictError,
    LocalAudiobookLibraryError,
} from '$lib/server/services/library-update.service.js';
import { mapLibraryGroupToApi } from '$lib/server/mappers/library-group.mapper.js';
import { mapLibraryPathToApi } from '$lib/server/mappers/library-path.mapper.js';
import { scopeGranted } from '$lib/server/tasks/api-auth.js';
import { auditLog, auditActor } from '$lib/server/utils/audit-log.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: libraryUpdateBodySchema,
        params: z.object({ id: z.string().min(1) }),
    },
    handlers: {
        PATCH: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const id = ctx.input!.params!.id;
            const body = ctx.input!.body;

            // Access is a separate privilege: PUT /api/admin/library-group-
            // permissions requires access:admin, and this endpoint only
            // library:admin. Folding access into the library save must not let
            // a library-only admin change who can see a library. No principal
            // (token-only caller) = cannot prove the scope = refused.
            if (body.allowed_groups !== undefined) {
                const scopes = event.locals.principal?.scopes ?? [];
                if (!scopeGranted(scopes, 'access:admin')) {
                    return ApiProblem.scopeRequired(['access:admin']);
                }
            }

            let result;
            try {
                result = await updateLibrary(sql, id, body);
            } catch (err) {
                if (err instanceof RemoteLibraryConflictError) {
                    return ApiProblem.conflict(err.message);
                }
                if (err instanceof LocalAudiobookLibraryError) {
                    return ApiProblem.validationFailed(err.message);
                }
                throw err;
            }
            if (!result) return ApiProblem.notFound('Library not found');

            if (body.allowed_groups !== undefined) {
                auditLog('library_group.update_permissions', id, auditActor(event), {
                    libraryGroupId: id,
                    allowedGroups: body.allowed_groups,
                });
            }

            return json({
                group: mapLibraryGroupToApi(result.group),
                paths: result.paths.map(mapLibraryPathToApi),
            });
        },
    },
});
