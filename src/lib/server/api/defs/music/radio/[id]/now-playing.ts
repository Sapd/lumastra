// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/radio/[id]/now-playing.ts — GET /api/music/radio/{id}/now-playing
 * (also mounted at GET /api/v1/music/radio/stations/{id}/now-playing)
 *
 * Returns the live now-playing metadata for a radio station.
 *
 * Contract:
 *  - Bare object (single resource) — no envelope.
 *  - Shape: RadioNowPlaying (stationId, fetchedAt, source, track{}, show{}, dj{}, upNext{}).
 *  - DB unavailable → 503 dependency_unavailable.
 *  - Station not found or access denied → 404 not_found.
 *
 * Access: any authenticated user; access-gated by checkMediaAccess (library + age).
 * Surface: 'internal' on /api/music/radio, 'v1' on /api/v1/music/radio/stations.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getNowPlaying } from '$lib/server/services/radio-metadata/index.js';
import type { RadioMetadataSource } from '$lib/schemas/radio.js';
import { findArtistIdByName } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { RadioNowPlayingResponseSchema } from '$lib/schemas/api-music-responses';

const logger = Logger.for('MusicRadioNowPlayingDef');

interface StationRow {
    id: string;
    custom_metadata: Record<string, unknown>;
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get what a radio station plays now',
            stability: 'beta',
            auth: 'bearer',
            responses: {
                200: {
                    schema: RadioNowPlayingResponseSchema,
                    description:
                        'Live now-playing metadata (track, show, DJ, up-next). Bare object — no envelope.',
                },
                401: 'Authentication required',
                404: 'Station not found or access denied',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'user' },

    request: {
        params: z.object({ id: z.string().min(1) }),
    },

    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const stationId = event.params.id;
            if (!stationId) return ApiProblem.validationFailed('Missing station ID');

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is not available');

            const rows = (await sql`
				SELECT id, COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata
				FROM media_items
				WHERE id = ${stationId}
				  AND media_type = 'radio'
				  AND custom_metadata ? 'stream_url'
				LIMIT 1
			`) as unknown as StationRow[];

            if (rows.length === 0) return ApiProblem.notFound('Radio station not found');

            // Gate by library + age before exposing stream_url / metadata.
            if (!(await checkMediaAccess(sql, rows[0].id, user))) {
                return ApiProblem.notFound('Radio station not found');
            }

            const meta = rows[0].custom_metadata;
            const streamUrl = String(meta.stream_url ?? '');
            const metadataSource = meta.metadata_source as RadioMetadataSource | undefined;

            const result = await getNowPlaying({
                id: rows[0].id,
                streamUrl,
                metadataSource,
            });

            // Resolve artist name → internal artist UUID when the live artist
            // exists in our library so the UI can render it as a clickable
            // artist-modal link. No-op when name is missing or unmatched.
            if (result.track.artist) {
                const artistId = await findArtistIdByName(sql, result.track.artist);
                if (artistId) result.track.artistId = artistId;
            }

            logger.debug('Radio now-playing served', {
                username: user.username,
                stationId: rows[0].id,
                source: result.source,
            });

            // Bare object (single resource) — no envelope wrapper.
            return json(result);
        },
    },
});
