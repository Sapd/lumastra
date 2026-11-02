// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /api/admin/library-type-settings
 *
 * GET — list all library-type settings
 * PUT — upsert a library-type setting (clears in-process sidebar cache after write)
 *
 * Auth:    library:admin (scope gate via mount)
 * Surface: internal
 *
 * Response (GET): { settings: LibraryTypeSetting[] }
 * Response (PUT): { setting: LibraryTypeSetting }
 * 503 dependency_unavailable on DB down.
 *
 * Note: _invalidateNonEntLibraryCache is imported from the layout module
 * (src/routes/+layout.server.ts) because it resets an in-process module-level
 * variable — it cannot live inside $lib without pulling the entire layout into
 * the lib boundary. The def is therefore inlined here rather than in defs/.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { mount } from '$lib/server/api/mount.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getAllLibraryTypeSettings,
    upsertLibraryTypeSetting,
} from '$lib/server/database/queries/library-type-settings.queries.js';
import { _invalidateNonEntLibraryCache } from '../../../+layout.server.js';
import { NON_ENTERTAINMENT_LIBRARY_TYPES } from '$lib/shared/media-types.js';

const upsertBodySchema = z.object({
    mediaType: z.enum(NON_ENTERTAINMENT_LIBRARY_TYPES),
    displayName: z.string().nullable(),
    sidebarVisible: z.boolean(),
    icon: z.string().nullable(),
    sortOrder: z.number().int().min(0).default(0),
});

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['library:admin'] },
    visibility: 'internal',
    request: {
        body: upsertBodySchema,
    },
    handlers: {
        GET: async (_event, _ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const settings = await getAllLibraryTypeSettings(sql);
            return json({ settings });
        },

        PUT: async (_event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const setting = await upsertLibraryTypeSetting(sql, ctx.input!.body);
            _invalidateNonEntLibraryCache();
            return json({ setting });
        },
    },
});

const { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD } = mount(def, {
    surface: 'internal',
});
export { GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD };
