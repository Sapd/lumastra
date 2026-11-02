// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/unmatched-files/[id]/match
 *
 * Manually links a personal media item to a metadata provider entry.
 * Body: { provider: string; externalId: string; mediaType: 'movie' | 'series' }
 *
 * This adds a row to external_ids, making the item no longer "personal".
 *
 * On conflict (the provider ID is already owned by another item) the response is
 * a 409 problem+json with additional `conflictMediaId` + `fileMediaId` fields
 * that the IdentifyModal reads to offer a merge path.
 *
 * Auth: media:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMediaItemType } from '$lib/server/database/queries/media-items.queries.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import {
    createCatalogService,
    ExternalIdOwnedByAnotherItemError,
} from '$lib/server/services/catalog.service.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('admin.unmatched-files.match');

// ---------------------------------------------------------------------------
// Request schemas
// ---------------------------------------------------------------------------

const ParamsSchema = z.object({
    id: z.string().regex(UUID_RE, 'Invalid UUID'),
});

const BodySchema = z.object({
    provider: z.string().min(1),
    externalId: z.string().min(1),
    /** Canonical discriminator: 'series' (not 'tv'). Legacy 'tv' accepted for backcompat. */
    type: z.enum(['movie', 'series', 'tv']),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:admin'] },
    visibility: 'internal',
    request: {
        params: ParamsSchema,
        body: BodySchema,
    },
    handlers: {
        POST: async (event, ctx) => {
            const { id } = ctx.input!.params;
            const { provider, externalId, type: rawType } = ctx.input!.body;

            // Normalize to internal 'tv' for legacy query compatibility
            const mediaType: 'movie' | 'tv' = rawType === 'movie' ? 'movie' : 'tv';

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const storedType = await getMediaItemType(sql, id);
            if (storedType === null) return ApiProblem.notFound('Media item not found');
            // External ids are keyed by (provider, id, media_type): a TV id on a
            // movie row (or the reverse) is exactly the composite-key
            // corruption CLAUDE.md warns about, and afterMatched would then run
            // series sync against a movie. Changing an item's type is a
            // separate operation, not a side effect of matching.
            const storedMatches =
                mediaType === 'movie' ? isMovie(storedType) : isSeries(storedType);
            if (!storedMatches) {
                return ApiProblem.validationFailed(
                    `This item is a ${storedType}; it can only be matched to a ${
                        isMovie(storedType) ? 'movie' : isSeries(storedType) ? 'series' : storedType
                    } result.`,
                );
            }

            const catalogService = createCatalogService(sql);
            try {
                await catalogService.upsertExternalId(
                    id,
                    {
                        provider,
                        id: externalId,
                        mediaType,
                        source: 'manual',
                        confidence: 1.0,
                    },
                    true,
                );
            } catch (err) {
                if (err instanceof ExternalIdOwnedByAnotherItemError) {
                    // The error names the owning item, so the UI can offer a
                    // merge path without a second lookup that could race.
                    const conflictMediaId = err.ownerMediaId;

                    return json(
                        {
                            code: 'conflict',
                            error: err.message,
                            status: 409,
                            conflict: 'already-mapped',
                            conflictMediaId,
                            fileMediaId: id,
                        },
                        {
                            status: 409,
                            headers: { 'Content-Type': 'application/problem+json' },
                        },
                    );
                }
                throw err;
            }

            // The match is committed at this point. A failure in the
            // follow-up hooks (cache clear, metadata-sync enqueue) used to turn
            // into a 500, so the admin was told the match failed and retried
            // although the id was already written.
            try {
                await MediaLifecycleService.afterMatched(id, mediaType, {
                    enqueueMetadataSync: true,
                    manual: true,
                });
            } catch (err) {
                logger.warn('afterMatched failed after a committed manual match', {
                    mediaItemId: id,
                    error: err instanceof Error ? err.message : String(err),
                });
            }

            return json({ mediaItemId: id });
        },
    },
});

export const { POST } = mount(def, { surface: 'internal' });
