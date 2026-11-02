// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/lists/index.ts — GET /lists + POST /lists
 *
 * GET /lists
 *   Auth: user (age-restriction check inside handler).
 *   Response: { items, page, syncing } — replaces old { lists, syncing }.
 *   Errors: problem+json (replaces bare { error } + old ApiResponses.error).
 *
 * POST /lists
 *   Auth: admin.
 *   Triggers a full sync of all curated lists; returns { accepted: true } 202.
 *   Errors: problem+json.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem, paginate } from '$lib/server/api/problem.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { CachedList } from '$lib/server/ai/list-sync.js';
import { CuratedListSyncResponseSchema } from '$lib/schemas/api-list-responses.js';
import { z } from 'zod';

const CuratedListSchema = z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().nullable().optional(),
    source: z.string().meta({ description: 'List source (e.g. "mdblist")' }),
    listPath: z.string().meta({ description: 'Provider-relative path identifying the list' }),
    itemCount: z.number().int().optional(),
    lastSyncedAt: z
        .string()
        .nullable()
        .optional()
        .meta({ description: 'ISO timestamp of the last successful sync, or null' }),
});

export const CuratedListsResponseSchema = z.object({
    items: z.array(CuratedListSchema),
    page: z.object({ limit: z.number().int(), offset: z.number().int(), hasMore: z.boolean() }),
    syncing: z
        .boolean()
        .optional()
        .meta({ description: 'True if a sync is currently in progress' }),
    cached: z
        .boolean()
        .optional()
        .meta({ description: 'True if the response was served from cache' }),
});

// Canonical sync-acknowledgement shape lives in the schema module (single
// source of truth); imported above as CuratedListSyncResponseSchema.

const logger = Logger.for('ListsDef');
const listsCache = cacheManager.for(CACHE_NAMESPACES.curatedLists);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toListItem(list: CachedList) {
    return {
        id: list.list_id,
        name: list.name,
        description: list.description,
        source: list.source,
        listPath: list.list_path,
        itemCount: list.item_count,
        lastSyncedAt:
            list.last_synced_at instanceof Date
                ? list.last_synced_at.toISOString()
                : (list.last_synced_at ?? null),
    };
}

// ---------------------------------------------------------------------------
// Endpoint definition
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Lists'],
            summary: 'List curated lists',
            stability: 'stable',
            auth: 'bearer',
            description: 'Returns all curated lists synced from external providers.',
            responses: {
                200: { schema: CuratedListsResponseSchema, description: 'Curated lists' },
                401: 'Authentication required',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        POST: {
            visibility: 'internal',
            tags: ['Lists'],
            summary: 'Trigger curated list sync',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Triggers an admin-only sync of curated lists from configured providers. Returns 202.',
            responses: {
                202: { schema: CuratedListSyncResponseSchema, description: 'Sync accepted' },
                401: 'Authentication required',
                403: 'Admin required',
                503: 'Task queue unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'user' },
        POST: { kind: 'admin' },
    },
    handlers: {
        /**
         * GET /lists
         *
         * Returns all available curated lists.
         * Response: { items, page, syncing } collection envelope.
         * Age-restricted users are rejected (403 forbidden).
         */
        GET: async (event, _ctx) => {
            if (event.locals.user?.isAgeRestricted) {
                return ApiProblem.forbidden('Lists are not available for age-restricted profiles');
            }

            try {
                const { getCachedLists, getListDefinitions, shouldRefreshLists, syncAllLists } =
                    await import('$lib/server/ai/list-sync.js');

                const needsRefresh = await shouldRefreshLists();

                if (needsRefresh) {
                    logger.info('Lists are stale, triggering background refresh');
                    listsCache.delete('metadata:global').catch(() => {
                        /* Cache invalidation is best-effort */
                    });
                    syncAllLists(30).catch((err) =>
                        logger.error('Background list sync failed', err),
                    );
                }

                const cacheKey = 'metadata:global';
                const cached = await listsCache.get<CachedList[]>(cacheKey);
                if (cached && cached.length > 0) {
                    const items = cached.map(toListItem);
                    return json({
                        ...paginate(items, { limit: items.length, offset: 0, hasMore: false }),
                        syncing: needsRefresh,
                        cached: true,
                    });
                }

                let lists = await getCachedLists();

                if (lists.length === 0) {
                    const definitions = getListDefinitions();
                    const items = definitions.map((d) => ({
                        id: d.list_id,
                        name: d.name,
                        description: d.description,
                        source: 'mdblist',
                        listPath: d.list_path,
                        itemCount: 0,
                        lastSyncedAt: null,
                    }));
                    return json({
                        ...paginate(items, { limit: items.length, offset: 0, hasMore: false }),
                        syncing: needsRefresh,
                    });
                }

                if (lists.length > 0) {
                    await listsCache.set(cacheKey, lists);
                }

                const items = lists.map(toListItem);
                return json({
                    ...paginate(items, { limit: items.length, offset: 0, hasMore: false }),
                    syncing: needsRefresh,
                });
            } catch (err) {
                logger.error('Failed to get lists', err as Error);
                return ApiProblem.internalError('Failed to retrieve curated lists');
            }
        },

        /**
         * POST /lists
         *
         * Trigger a full sync of all curated lists (admin-only).
         * Returns 202 { accepted: true } immediately; sync runs in background.
         */
        POST: async (_event, _ctx) => {
            try {
                const { syncAllLists } = await import('$lib/server/ai/list-sync.js');

                logger.info('Manual list sync triggered via API');

                // Fire and forget — sync runs in background
                syncAllLists(50).catch((err) =>
                    logger.error('Manual list sync failed', err as Error),
                );

                // Invalidate cache so next GET picks up fresh data
                listsCache.delete('metadata:global').catch(() => {
                    /* best-effort */
                });

                return json({ accepted: true }, { status: 202 });
            } catch (err) {
                logger.error('Failed to trigger list sync', err as Error);
                return ApiProblem.internalError('Failed to trigger list sync');
            }
        },
    },
});
