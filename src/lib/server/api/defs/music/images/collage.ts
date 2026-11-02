// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/images/collage.ts — GET music/images/collage?ids=…&size=…
 *
 * Server-rendered square cover collage (2x2, or one cover when fewer than four
 * distinct covers exist) for moods, taste stations, smart mixes and music
 * playlists. Those list responses carry a ready-made `collage`/`coverCollage`
 * href set built by `buildCollageRefs`; clients should use those rather than
 * assembling this URL themselves.
 *
 * Auth mirrors media/{id}/images/{role}: public raw-image endpoint. When the
 * request carries a real credential, ids the caller cannot access are dropped
 * before rendering (a fully denied list answers like a missing image). Without
 * a credential it serves artwork only for the given UUIDs — the same documented
 * trade-off as the per-item image route (UUIDs are not enumerable).
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { imageResponse } from '$lib/server/services/image-proxy/index.js';
import { noImageResponse, imageClientType } from '$lib/server/utils/placeholder-image.js';
import { checkMediaAccessBatch } from '$lib/server/middleware/media-access.js';
import { getDb } from '$lib/server/database/index.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';
import { Logger } from '$lib/server/utils/logger.js';
import { COVER_COLLAGE_MAX_IDS } from '$lib/shared/api-urls.js';

const logger = Logger.for('MusicCollageDef');

const CollageQuery = z.object({
    v: z.string().optional().describe('Opaque artwork revision; does not affect resolution.'),
    ids: z.string().meta({
        description: `Comma-separated media UUIDs in priority order (max ${COVER_COLLAGE_MAX_IDS}). Tracks resolve to their album cover; byte-identical covers are collapsed.`,
    }),
    size: z
        .enum(['thumb', 'card', 'full'])
        .optional()
        .meta({ description: 'Output edge: thumb=256px, card=512px (default), full=1024px' }),
});

export const def = defineEndpoint({
    auth: { kind: 'public' },
    raw: true,
    visibility: 'public',
    request: { query: CollageQuery },

    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get a cover collage',
            stability: 'beta',
            auth: 'none',
            query: CollageQuery,
            description:
                'Square webp collage of up to four covers. Four or more distinct covers render as a 2x2 grid; one to three render the first cover full-bleed. ' +
                'List responses (moods, taste stations, smart mixes, music playlists) already carry this URL as an href set — prefer those. ' +
                'Ids the caller cannot access are skipped when a credential is presented. ' +
                'A miss behaves like the media image route: 404 for native (bearer/PAT) clients, placeholder bytes for browsers, both with `X-Lumastra-Placeholder: 1`.',
            responses: {
                200: { binary: ['image/webp'], description: 'Collage image bytes' },
                400: 'Missing or malformed ids / size',
                404: 'No renderable cover among the ids',
                503: 'Database unavailable (when the access gate cannot be evaluated)',
            },
        },
    },

    handlers: {
        GET: async (event) => {
            const { url, request, locals } = event;

            const rawIds = (url.searchParams.get('ids') ?? '')
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);
            const ids = [...new Set(rawIds)];
            if (ids.length === 0 || ids.length > COVER_COLLAGE_MAX_IDS || !ids.every(isUuid)) {
                return ApiProblem.validationFailed([
                    {
                        field: 'ids',
                        message: `ids must be 1-${COVER_COLLAGE_MAX_IDS} comma-separated UUIDs`,
                    },
                ]);
            }

            const sizeParam = url.searchParams.get('size') ?? 'card';
            if (sizeParam !== 'thumb' && sizeParam !== 'card' && sizeParam !== 'full') {
                return ApiProblem.validationFailed([
                    { field: 'size', message: 'size must be thumb, card or full' },
                ]);
            }

            // musicCollageImages emits exactly 16 lowercase hex characters.
            const rawRevision = url.searchParams.get('v');
            const revision =
                rawRevision?.length === 16 && /^[0-9a-f]{16}$/.test(rawRevision)
                    ? rawRevision
                    : undefined;

            let allowed = ids;
            if (locals.user) {
                const sql = getDb();
                if (sql) {
                    const user = locals.user;
                    const accessible = await checkMediaAccessBatch(sql, ids, user);
                    allowed = ids.filter((id) => accessible.has(id));
                } else if (locals.principal?.isAdmin !== true) {
                    return ApiProblem.dependencyUnavailable('Unable to verify content access');
                }
            }

            try {
                const { getCoverCollage } =
                    await import('$lib/server/services/music/cover-collage.service.js');
                const result =
                    allowed.length > 0 ? await getCoverCollage(allowed, sizeParam, revision) : null;
                if (!result) {
                    return noImageResponse(imageClientType(request, url, locals.authMethod));
                }
                return imageResponse(
                    {
                        buffer: result.buffer,
                        contentType: result.contentType,
                        etag: result.etag,
                        // private: the rendered set depends on the viewer's access.
                        cacheControl: 'private, max-age=86400',
                    },
                    request,
                    { scope: 'private', bounded: true, hasRevision: revision !== undefined },
                );
            } catch (error) {
                logger.error('Failed to render cover collage', error as Error, { ids });
                return ApiProblem.internalError('Failed to render cover collage');
            }
        },
    },
});
