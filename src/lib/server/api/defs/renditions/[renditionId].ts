// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/renditions/[renditionId].ts — GET /api/v1/renditions/{renditionId}
 *
 * Poll target for an offline-download rendition. Returns progress while encoding
 * and the download URL once ready.
 *
 * Access is re-checked against the rendition's `media_item_id` on every poll
 * rather than trusted from whoever created it: renditions are shared between
 * users, so a rendition id must never become a capability that outlives the
 * requester's access to the title.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { config } from '$lib/server/config.js';
import { RenditionSchema } from '$lib/schemas/api-download-responses.js';
import {
    getRendition,
    touchRendition,
} from '$lib/server/database/queries/download-renditions.queries.js';
import { renditionToWire } from '$lib/server/services/download-rendition/wire.js';
import {
    prepareSlotMember,
    releasePrepareSlot,
} from '$lib/server/services/download-rendition/prepare-cap.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['media:read'] },

    docs: {
        GET: {
            tags: ['Media'],
            summary: 'Get offline-download rendition status',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Progress and, once ready, the download URL for a rendition requested via ' +
                "POST /media/{id}/renditions. Polling also refreshes the artifact's LRU position, " +
                'so a rendition a client is actively working through is not evicted underneath it.',
            responses: {
                200: { schema: RenditionSchema, description: 'Current rendition state' },
                401: 'Authentication required',
                404: 'Rendition not found, access denied, or the feature is disabled',
                503: 'Database unavailable',
            },
        },
    },

    handlers: {
        GET: async (event, ctx) => {
            if (!config.FEATURE_DOWNLOAD_RENDITIONS) {
                return ApiProblem.notFound('Rendition not found');
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const row = await getRendition(sql, event.params.renditionId ?? '');
            if (!row) return ApiProblem.notFound('Rendition not found');

            if (!(await checkMediaAccess(sql, row.media_item_id, event.locals.user))) {
                return ApiProblem.notFound('Rendition not found');
            }

            // Keep the artifact warm for as long as someone is watching it.
            await touchRendition(sql, row.id);

            // Release this poller's per-user prepare slot on a terminal
            // observation. The POST handler only ever releases when a
            // subsequent POST happens to land on `ready`/`failed`; the
            // documented, encouraged flow is to POLL here instead, and a
            // client that does exactly that would otherwise hold its slot
            // until the TTL lapses even though the work is long done,
            // needlessly starving its own next pool item under the default
            // cap of 1. Harmless to call on every poll — `releasePrepareSlot`
            // is a plain Valkey SREM, idempotent whether or not the slot is
            // still held.
            if (event.locals.user && (row.status === 'ready' || row.status === 'failed')) {
                await releasePrepareSlot(
                    event.locals.user.userId,
                    prepareSlotMember(row.file_id, row.rung_id, row.audio_index),
                );
            }

            return typedJson(RenditionSchema, renditionToWire(row, ctx.surface));
        },
    },
});
