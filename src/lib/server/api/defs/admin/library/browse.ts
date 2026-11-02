// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/library/browse.ts
 *
 * GET /api/admin/library/browse?path=<abs>
 *
 * Folder picker backend (Add folder / setup wizard). Lists SUBDIRECTORIES of
 * `path`, never files. With no `path`, returns the allowed roots that
 * currently exist. See `library-browse.service.ts` for the confinement model.
 *
 * Auth:    library:admin
 * Surface: internal
 *
 * Response (200): { path, entries }
 * 422 validation_failed — path relative, not a directory, or unreadable.
 * 403 forbidden — path resolves outside the allowed library mount roots.
 * 503 dependency_unavailable on DB down.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { getLibraryGroupById } from '$lib/server/database/queries/library-groups.queries.js';
import {
    getAllowedBrowseRoots,
    listBrowseEntries,
    type BrowseEntry,
} from '$lib/server/services/library-browse.service.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        query: z.object({
            path: z.string().min(1).optional(),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const { path } = ctx.input!.query!;

            const allowedRoots = await getAllowedBrowseRoots(sql);
            const result = await listBrowseEntries(path, allowedRoots);

            if (!result.ok) {
                return result.status === 403
                    ? ApiProblem.forbidden(result.message)
                    : ApiProblem.validationFailed(result.message);
            }

            // Annotate entries that are already a configured library folder —
            // the folder picker shows "already in <Library>" instead of letting
            // an operator pick a path that would collide with UNIQUE(path).
            const existingPaths = await getAllLibraryPaths(sql);
            const byPath = new Map(existingPaths.map((p) => [p.path, p]));
            const groupNameCache = new Map<string, string>();

            const entries: (BrowseEntry & { libraryGroupId?: string; libraryName?: string })[] = [];
            for (const entry of result.entries) {
                const existing = byPath.get(entry.path);
                if (!existing) {
                    entries.push(entry);
                    continue;
                }
                let libraryName = groupNameCache.get(existing.library_group_id);
                if (libraryName === undefined) {
                    const group = await getLibraryGroupById(sql, existing.library_group_id);
                    libraryName = group?.display_name ?? group?.name ?? 'Unknown library';
                    groupNameCache.set(existing.library_group_id, libraryName);
                }
                entries.push({
                    ...entry,
                    libraryGroupId: existing.library_group_id,
                    libraryName,
                });
            }

            return json({ path: result.path, entries });
        },
    },
});
