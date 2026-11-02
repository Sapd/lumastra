// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/music/tracks/[id]/lyrics.ts
 *
 * GET  /api/music/tracks/{id}/lyrics — fetch track lyrics (any authed user)
 * PUT  /api/music/tracks/{id}/lyrics — upload/replace lyrics (admin only)
 *
 * GET response: bare object { lyrics, syncedLines? } per contract.
 * PUT response: 204 No Content on success.
 * Errors: problem+json incl. 503 dependency_unavailable on DB-down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { parseLRC } from '$lib/server/utils/lrc-parser.js';
import { readStoredLyrics, saveUserLyrics } from '$lib/server/services/music/lyrics.service.js';
import { LyricsUploadRequestSchema } from '$lib/schemas/music.js';
import { LyricsResponseSchema } from '$lib/schemas/music';

const logger = Logger.for('MusicLyricsV1Def');

const paramsSchema = z.object({ id: z.string().min(1) });

function buildSyncedLines(syncedText: string): Array<{ startMs: number; text: string }> {
    const parsed = parseLRC(syncedText);
    return parsed.lines.map((line) => ({ startMs: line.startMs, text: line.text }));
}

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Music'],
            summary: 'Get track lyrics',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Returns the lyrics for a track as a bare object (`lyrics` plus optional parsed ' +
                '`syncedLines`). A known track with no lyrics returns 200 with `lyrics: null` and no ' +
                '`syncedLines`; 404 is only for an unknown or inaccessible track. A down database ' +
                'returns `503 dependency_unavailable`.',
            responses: {
                200: {
                    schema: LyricsResponseSchema,
                    description: 'Track lyrics; lyrics is null when the track has none',
                },
                401: 'Authentication required',
                404: 'Track not found',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
        PUT: {
            tags: ['Music'],
            summary: 'Upload or replace track lyrics (admin)',
            stability: 'stable',
            auth: 'bearer',
            description:
                'Uploads or replaces lyrics for a track. Admin only. Returns 204 on success.',
            body: LyricsUploadRequestSchema,
            responses: {
                204: 'Lyrics updated',
                401: 'Authentication required',
                404: 'Track not found',
                422: 'Validation failed',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: {
        GET: { kind: 'user' },
        PUT: { kind: 'admin' },
    },
    request: {
        params: paramsSchema,
    },
    visibility: 'public',
    handlers: {
        GET: async (event) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const trackId = event.params.id;
            if (!trackId) return ApiProblem.validationFailed('Missing track ID');

            const track = await getTrackDetail(sql, trackId);
            if (!track) return ApiProblem.notFound('Track not found');

            if (!(await checkMediaAccess(sql, track.id, user))) {
                return ApiProblem.notFound('Track not found');
            }

            const lyrics = readStoredLyrics(track);
            // A known, accessible track without lyrics is not a 404: answer 200 with null.
            if (!lyrics) return json({ lyrics: null });

            const syncedLines = lyrics.synced ? buildSyncedLines(lyrics.synced) : undefined;

            // Bare object — no success/timestamp wrapper.
            return json({ lyrics, syncedLines });
        },

        PUT: async (event) => {
            const user = event.locals.user;
            if (!user) return ApiProblem.unauthorized();

            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const trackId = event.params.id;
            if (!trackId) return ApiProblem.validationFailed('Missing track ID');

            const track = await getTrackDetail(sql, trackId);
            if (!track) return ApiProblem.notFound('Track not found');

            let body: unknown;
            try {
                body = await event.request.json();
            } catch {
                return ApiProblem.validationFailed('Request body must be valid JSON');
            }

            const parsed = LyricsUploadRequestSchema.safeParse(body);
            if (!parsed.success) {
                return ApiProblem.validationFailed(
                    parsed.error.issues.map((e) => ({
                        field: e.path.join('.'),
                        message: e.message,
                    })),
                );
            }

            const { plain, synced, source, format } = parsed.data;
            const lyricsSource = source ?? 'user';

            await saveUserLyrics(sql, trackId, {
                plain: plain ?? null,
                synced: synced ?? null,
                format,
                source: lyricsSource,
                fetchedAt: new Date().toISOString(),
            });

            logger.info('Lyrics updated', {
                username: user.username,
                trackId,
                source: lyricsSource,
            });

            return new Response(null, { status: 204 });
        },
    },
});
