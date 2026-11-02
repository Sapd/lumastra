// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/catalog/series/search.ts — `series/search`.
 *
 * Contract (bare object — single resource or 404):
 *   GET /series/search?name=...  → canonical series item { id, type, ids, title, … }
 *
 * Returns 404 when no match found (never 200-empty).
 * Auth: user. Surface: internal (SPA convenience search).
 */

import { ImageSetSchema, InheritQuerySchema } from '$lib/schemas/api-image-descriptor.js';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { findSeriesByName } from '$lib/server/database/queries/media-lookup.queries.js';
import { getPlaybackPreferences } from '$lib/server/database/queries/user-preferences.queries.js';
import { getPrimaryExternalIdProvider } from '$lib/server/utils/provider-config.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { resolveImageSet } from '$lib/server/services/image-descriptor/index.js';

import { resolveMetadataLanguage } from '$lib/server/utils/metadata-language-resolve.js';
import { applyTranslationOverlay } from '$lib/server/utils/translation-overlay.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const SearchQuery = z
    .object({
        name: z.string().min(1, 'name is required').max(200),
    })
    .merge(InheritQuerySchema);

// ---------------------------------------------------------------------------
// Response schema — canonical media-item shape
// ---------------------------------------------------------------------------

export const SeriesSearchItemSchema = z.object({
    id: z.string(),
    type: z.literal('series'),
    ids: z.record(z.string(), z.string()),
    title: z.string(),
    year: z.number().int().optional(),
    overview: z.string().optional(),
    images: ImageSetSchema,
});

export type SeriesSearchItem = z.infer<typeof SeriesSearchItemSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',

    docs: {
        GET: {
            tags: ['Catalog'],
            summary: 'Search series by name',
            query: SearchQuery,
            responses: {
                200: { schema: SeriesSearchItemSchema, description: 'Search series by name' },
            },
        },
    },

    request: {
        query: SearchQuery,
    },

    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const nameRaw = event.url.searchParams.get('name') ?? '';
            if (nameRaw.length > 200) {
                return ApiProblem.validationFailed([
                    { field: 'query.name', message: 'name must be at most 200 characters' },
                ]);
            }
            if (!nameRaw.trim()) {
                return ApiProblem.validationFailed([
                    { field: 'query.name', message: 'name is required' },
                ]);
            }

            const accessCtx = await buildSearchAccessContext(sql, event.locals.user);
            // Pass the boundary through whole rather than destructuring the two
            // nullable fields — that spread was the adapter the required-by-shape
            // boundary exists to remove.
            const dbResult = await findSeriesByName(sql, nameRaw, searchAccessBoundary(accessCtx));

            if (!dbResult) {
                return ApiProblem.notFound('Series not found');
            }

            // Per-user metadata-language overlay (multilingual-media-metadata
            // spec §5), resolved ONCE per request; `dbResult` is a freshly-built
            // object from `findSeriesByName` (no cache in this handler) so it's
            // mutated in place.
            const userId = event.locals.user?.userId;
            if (userId && config.METADATA_ADDITIONAL_LANGUAGES.length > 0) {
                const langs = resolveMetadataLanguage(
                    await getPlaybackPreferences.one(sql, { userId }),
                );
                if (langs.titleLang || langs.textLang) {
                    await applyTranslationOverlay(sql, [dbResult], langs, {
                        id: (it) => it.internal_id,
                        setTitle: (it, v) => {
                            it.title = v;
                        },
                        setOverview: (it, v) => {
                            it.overview = v;
                        },
                    });
                }
            }

            const primaryProvider = getPrimaryExternalIdProvider();
            const ids: Record<string, string> = { internal: dbResult.internal_id };
            if (dbResult.primary_ext_id) ids[primaryProvider] = dbResult.primary_ext_id;

            const year = dbResult.release_date
                ? new Date(dbResult.release_date).getFullYear()
                : undefined;

            const surface = ctx.surface;

            return json({
                id: dbResult.internal_id,
                type: 'series' as const,
                ids,
                title: dbResult.title,
                year,
                overview: dbResult.overview ?? undefined,
                images: await resolveImageSet(
                    sql,
                    surface,
                    dbResult.internal_id,
                    'series',
                    ctx.input?.query?.inherit === 'none' ? { inherit: 'none' } : undefined,
                ),
            } satisfies SeriesSearchItem);
        },
    },
});
