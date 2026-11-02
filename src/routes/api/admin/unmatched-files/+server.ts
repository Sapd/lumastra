// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/unmatched-files
 *
 * Lists media items with no external provider IDs ("personal media").
 * Supports search, filter by media type/library group, and sort order.
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    listPersonalMediaItems,
    countPersonalMediaItems,
    getPersonalMediaLibraryGroups,
} from '$lib/server/database/queries/media-items.queries.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(100).optional(),
    offset: z.coerce.number().int().min(0).optional(),
    q: z.string().max(200).optional(),
    sort: z.enum(['title', 'episodes', 'added']).optional(),
    mediaType: z.enum(['movie', 'series']).optional(),
    libraryGroupId: z.string().guid().optional(),
    disposition: z.enum(['unresolved', 'kept']).optional(),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        query: QuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const {
                limit: limitParam,
                offset: offsetParam,
                q,
                sort: sortParam,
                mediaType,
                libraryGroupId,
                disposition,
            } = ctx.input!.query;

            const limit = Math.min(limitParam ?? 50, 100);
            const offset = offsetParam ?? 0;
            const search = q?.trim() || undefined;
            const sort = sortParam ?? 'title';

            const filterOpts = {
                search,
                // internal queries still use 'tv'; map canonical 'series' if needed
                mediaType: mediaType === 'series' ? 'tv' : mediaType,
                libraryGroupId,
                disposition,
            };

            const [items, total, libraryGroups] = await Promise.all([
                listPersonalMediaItems(sql, { limit, offset, sort, ...filterOpts }),
                countPersonalMediaItems(sql, filterOpts),
                getPersonalMediaLibraryGroups(sql),
            ]);

            return json({
                ...paginate(items, { limit, offset, hasMore: items.length >= limit, total }),
                libraryGroups,
            });
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
