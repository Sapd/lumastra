// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/search.ts
 *
 * GET /api/admin/media/search?q=...
 *
 * Rich admin quick-nav search.  Returns up to 30 results with parent/child
 * context.  Media type uses canonical public discriminator ('series' not 'tv').
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { results: AdminSearchResult[] }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { searchAdminQuickNav } from '$lib/server/database/queries/search.queries.js';
import { unrestrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const AdminSearchResultSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    mediaType: z.string(),
    year: z.number().nullable(),
    seasonNumber: z.number().nullable(),
    episodeNumber: z.number().nullable(),
    parentId: z.string().nullable(),
    parentTitle: z.string().optional(),
    grandparentTitle: z.string().optional(),
    seasonCount: z.number().optional(),
    episodeCount: z.number().optional(),
    hasFile: z.boolean(),
});

export const AdminSearchResponseSchema = z.object({
    results: z.array(AdminSearchResultSchema),
});

export type AdminSearchResult = z.infer<typeof AdminSearchResultSchema>;
export type AdminSearchResponse = z.infer<typeof AdminSearchResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            q: z.string().max(200).optional(),
            mediaType: z
                .enum(['album', 'series'])
                .optional()
                .describe('Restrict results to albums or series before pagination.'),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const q = (ctx.input?.query?.q ?? '').trim();
            if (!q || q.length < 2) {
                return json(AdminSearchResponseSchema.parse({ results: [] }));
            }

            // Admin-only surface (`auth: { kind: 'admin' }`): unrestricted access is
            // stated explicitly rather than implied by an omitted argument.
            const rows = await searchAdminQuickNav(
                sql,
                q,
                unrestrictedAccess(),
                30,
                ctx.input?.query?.mediaType === 'series' ? 'tv' : ctx.input?.query?.mediaType,
            );

            const results: AdminSearchResult[] = rows.map((r) => ({
                id: r.id,
                title: r.title,
                mediaType: toPublicMediaType(r.media_type) ?? r.media_type,
                year: r.year,
                seasonNumber: r.season_number,
                episodeNumber: r.episode_number,
                parentId: r.parent_id,
                parentTitle: r.parent_title ?? undefined,
                grandparentTitle: r.grandparent_title ?? undefined,
                seasonCount: r.season_count ?? undefined,
                episodeCount: r.episode_count ?? undefined,
                hasFile: r.has_file,
            }));

            return json(AdminSearchResponseSchema.parse({ results }));
        },
    },
});
