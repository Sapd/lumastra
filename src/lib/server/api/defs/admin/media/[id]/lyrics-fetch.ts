// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/lyrics-fetch.ts
 *
 * POST /api/admin/media/[id]/lyrics-fetch
 *
 * Fetches lyrics from LRCLIB for a track and stores them in custom_metadata.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { fetched: boolean, hasPlain: boolean, hasSynced: boolean }
 * 503 dependency_unavailable when DB is down.
 * 404 when track not found or lyrics not available.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    captureCuratedOutput,
    saveCuratedOutput,
    CuratedOutputConflict,
} from '$lib/server/services/curated-output.service.js';
import { getLyrics } from '$lib/server/providers/implementations/musicbrainz/lrclib.js';

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const LyricsFetchResponseSchema = z.object({
    undoId: z.uuid().optional(),
    fetched: z.boolean(),
    hasPlain: z.boolean(),
    hasSynced: z.boolean(),
});

export type LyricsFetchResponse = z.infer<typeof LyricsFetchResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        POST: async (event) => {
            const sql = await aiDbService.getSql();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const mediaItemId = adminMediaId(event);
            if (!mediaItemId) return ApiProblem.notFound('Track');

            const [track] = await sql`
                SELECT mi.title, mi.runtime_seconds, mi.parent_id
                FROM media_items mi
                WHERE mi.id = ${mediaItemId} AND mi.media_type = 'track'
            `;
            if (!track) return ApiProblem.notFound('Track');

            let artistName: string | null = null;
            let albumName: string | null = null;

            if (track.parent_id) {
                const [album] = await sql`
                    SELECT title, parent_id FROM media_items
                    WHERE id = ${track.parent_id} AND media_type = 'album'
                `;
                if (album) {
                    albumName = album.title as string | null;
                    if (album.parent_id) {
                        const [artist] = await sql`
                            SELECT title FROM media_items
                            WHERE id = ${album.parent_id} AND media_type = 'artist'
                        `;
                        if (artist) artistName = artist.title as string | null;
                    }
                }
            }

            if (!artistName || !track.title) {
                return ApiProblem.validationFailed(
                    'Cannot fetch lyrics: missing artist name or track title',
                );
            }

            const before = await captureCuratedOutput(sql, mediaItemId, 'lyrics');
            const result = await getLyrics({
                artistName,
                trackTitle: track.title as string,
                albumName: albumName ?? undefined,
                duration: track.runtime_seconds ? Number(track.runtime_seconds) : undefined,
            });

            // A hit with neither plain nor synced text is not lyrics: storing it
            // would replace existing lyrics with nothing and report success.
            if (!result || (!result.plainLyrics && !result.syncedLyrics)) {
                return ApiProblem.notFound('Lyrics not found on LRCLIB');
            }

            const lyricsPayload = {
                plain: result.plainLyrics ?? null,
                synced: result.syncedLyrics ?? null,
                source: 'lrclib' as const,
                fetchedAt: new Date().toISOString(),
            };

            let undoId: string;
            try {
                undoId = await saveCuratedOutput(
                    sql,
                    mediaItemId,
                    'lyrics',
                    lyricsPayload,
                    event.locals.user?.username ?? 'admin',
                    before,
                );
            } catch (error) {
                if (error instanceof CuratedOutputConflict)
                    return ApiProblem.conflict(error.message);
                throw error;
            }

            return json(
                LyricsFetchResponseSchema.parse({
                    fetched: true,
                    undoId,
                    hasPlain: !!result.plainLyrics,
                    hasSynced: !!result.syncedLyrics,
                }),
            );
        },
    },
});
