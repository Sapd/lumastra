// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/external-ids.ts
 *
 * GET    /api/admin/media/[id]/external-ids  — list all external IDs
 * PUT    /api/admin/media/[id]/external-ids  — add / update an external ID
 * DELETE /api/admin/media/[id]/external-ids?provider=tmdb — remove an external ID
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response:  { externalIds: ExternalIdRow[] }
 * PUT response:  { updated: boolean }
 * DELETE response: { deleted: boolean }
 * 503 dependency_unavailable when DB is down.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import { ExternalIdOwnedByAnotherItemError } from '$lib/server/services/catalog.service.js';
import type { MediaType } from '$lib/server/providers/provider-types.js';
import {
    ExternalIdsGetResponseSchema,
    ExternalIdMutateResponseSchema,
    ExternalIdDeleteResponseSchema,
    type ExternalIdsGetResponse,
} from '$lib/schemas/api-media-responses.js';

// ---------------------------------------------------------------------------
// Request schema (response schemas are single-sourced from
// $lib/schemas/api-media-responses; also used by the v1 _openapi.ts).
// ---------------------------------------------------------------------------

export {
    ExternalIdsGetResponseSchema,
    ExternalIdMutateResponseSchema,
    ExternalIdDeleteResponseSchema,
};
export type { ExternalIdsGetResponse };

export const UpsertExternalIdSchema = z.object({
    provider: z.string().min(1).max(50),
    externalId: z.string().min(1).max(255),
});

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            provider: z.string().optional(),
        }),
    },
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const ids = await sql`
                SELECT id::text AS id, external_id, provider, is_primary
                FROM external_ids
                WHERE media_id = ${internalId}
                ORDER BY provider
            `;

            return json(ExternalIdsGetResponseSchema.parse({ externalIds: ids }));
        },

        PUT: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            // Parse body manually — no def-level `request.body`: mount() applies a
            // declared body schema to every method that can carry one, including
            // DELETE (see mount.ts `methodCanHaveBody`), and this DELETE reads its
            // `provider` from the query string, not the body.
            let provider: string, externalId: string;
            try {
                const rawBody: unknown = await readBoundedJson(event.request);
                const parsed = UpsertExternalIdSchema.safeParse(rawBody);
                if (!parsed.success) {
                    return ApiProblem.validationFailed(
                        parsed.error.issues.map((i) => ({
                            field: i.path.join('.'),
                            message: i.message,
                        })),
                    );
                }
                ({ provider, externalId } = parsed.data);
            } catch {
                return ApiProblem.validationFailed('Invalid request body');
            }

            const [mediaItem] = await sql<Array<{ media_type: string }>>`
                SELECT media_type FROM media_items WHERE id = ${internalId}
            `;
            if (!mediaItem) return ApiProblem.notFound('Media item not found');

            const catalogService = createCatalogService(sql);
            let updated: boolean;
            try {
                // An admin editing an id by hand is operator intent, and
                // upsertExternalId skips a disagreeing write while the current row is
                // fresh (the convergence guard). `source: 'manual'` exempts this call
                // from that guard, so a correction made right after a scan — the usual
                // moment — is not dropped. The returned flag is reported verbatim
                // rather than assumed: this endpoint used to answer `{updated: true}`
                // unconditionally, which is how a silently dropped write looked
                // identical to a successful one.
                updated = await catalogService.upsertExternalId(internalId, {
                    provider,
                    id: externalId,
                    mediaType: mediaItem.media_type as MediaType,
                    source: 'manual',
                });
            } catch (err) {
                // The id is already held by a DIFFERENT media item — the unique key
                // forbids taking it. This is the commonest admin correction (moving an
                // id off the wrong item), and it threw straight out of the handler as
                // an unhandled 500 on a route that documents 4xx. Answer 409 and name
                // the owner so the admin can go clear it there first.
                if (err instanceof ExternalIdOwnedByAnotherItemError) {
                    return ApiProblem.conflict(
                        `${provider}:${externalId} is already assigned to media item ${err.ownerMediaId}. Remove it there first.`,
                    );
                }
                throw err;
            }

            return json(ExternalIdMutateResponseSchema.parse({ updated }));
        },

        DELETE: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const provider = event.url.searchParams.get('provider');
            if (!provider) {
                return ApiProblem.validationFailed('Provider is required');
            }

            const [mediaItem] = await sql<Array<{ media_type: string }>>`
                SELECT media_type FROM media_items WHERE id = ${internalId}
            `;
            if (!mediaItem) return ApiProblem.notFound('Media item not found');

            const catalogService = createCatalogService(sql);
            const deletedCount = await catalogService.deleteExternalId(
                internalId,
                provider,
                mediaItem.media_type as MediaType,
            );
            // Same rule as PUT: report what happened. A provider the item has
            // no id for (or one stored under another media_type) deleted
            // nothing, and answering { deleted: true } hid that.
            if (deletedCount === 0) {
                return ApiProblem.notFound('External id not found for this item');
            }

            return json(ExternalIdDeleteResponseSchema.parse({ deleted: true }));
        },
    },
});
