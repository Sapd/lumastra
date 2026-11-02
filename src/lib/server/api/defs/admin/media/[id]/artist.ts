// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/artist.ts
 *
 * GET   /api/admin/media/[id]/artist?q=...  — search artists by name
 * PATCH /api/admin/media/[id]/artist        — reparent album to existing artist
 * POST  /api/admin/media/[id]/artist        — create new artist and reparent album
 *
 * Auth: admin.  Surface: internal-only.
 *
 * GET response:  { artists: { id, title }[] }
 * PATCH response: { artistId, artistTitle }
 * POST response:  { artistId, artistTitle }
 * 503 dependency_unavailable when DB is down.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader.js';
import { z } from 'zod';
import { previewFolderCompilations } from '$lib/server/services/folder-compilation-repair.js';
import { CompilationRepairPreviewSchema } from '$lib/schemas/album-merge.js';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { ManualAlbumArtistAssignmentError } from '$lib/server/database/queries/artist-merge.queries.js';
import {
    albumArtistSnapshot,
    saveAlbumArtist,
} from '$lib/server/services/music/album-artist-edit.js';
import { MusicEditConflict } from '$lib/server/services/music/edit-recovery.js';
import { UUID_RE } from '$lib/utils/id-patterns.js';

// ---------------------------------------------------------------------------
// Response schemas
// ---------------------------------------------------------------------------

const ArtistItemSchema = z.object({
    id: z.string().guid(),
    title: z.string(),
});

export const ArtistSearchResponseSchema = z.object({
    artists: z.array(ArtistItemSchema),
    snapshot: z.string().optional(),
});

export const ArtistMutateResponseSchema = z.object({
    artistId: z.string().guid(),
    artistTitle: z.string(),
});

export type ArtistSearchResponse = z.infer<typeof ArtistSearchResponseSchema>;
export type ArtistMutateResponse = z.infer<typeof ArtistMutateResponseSchema>;

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const MAX_ARTIST_NAME_LENGTH = 255;

function assignmentProblem(err: unknown): Response | undefined {
    if (err instanceof MusicEditConflict) return ApiProblem.conflict(err.message);
    if (!(err instanceof ManualAlbumArtistAssignmentError)) return undefined;
    if (err.reason === 'not-album')
        return ApiProblem.validationFailed('Media item is not an album');
    return ApiProblem.notFound(
        err.reason === 'missing-artist' ? 'Artist not found' : 'Media item not found',
    );
}

function isUniqueViolation(err: unknown): boolean {
    return (err as { code?: string } | null)?.code === '23505';
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        query: z.object({
            q: z.string().max(200).optional(),
            compilationPreview: z.literal('1').optional(),
        }),
    },
    handlers: {
        GET: async (event, ctx) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            if (ctx.input?.query?.compilationPreview === '1') {
                const id = adminMediaId(event);
                if (!id) return ApiProblem.notFound('Album not found');
                return json(
                    CompilationRepairPreviewSchema.parse(await previewFolderCompilations(sql, id)),
                );
            }
            const q = (ctx.input?.query?.q ?? '').trim();
            const escaped = q.replace(/[%_\\]/g, '\\$&');
            const qFilter = escaped
                ? sql`AND LOWER(title) LIKE LOWER(${'%' + escaped + '%'}) ESCAPE '\\'`
                : sql``;
            const artists = await sql<{ id: string; title: string }[]>`
                SELECT id, title FROM media_items
                WHERE media_type = 'artist'
                  AND status = 'active'
                  AND title IS NOT NULL AND parent_id IS NULL AND canonical_id IS NULL AND NOT is_dismissed
                  ${qFilter}
                ORDER BY title
                LIMIT 20
            `;
            const id = adminMediaId(event);
            const snapshot = id ? await albumArtistSnapshot(sql, id) : undefined;
            return json(ArtistSearchResponseSchema.parse({ artists, snapshot }));
        },

        PATCH: async (event) => {
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                return ApiProblem.validationFailed('Invalid request body');
            }
            if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
                return ApiProblem.validationFailed('Request body must be a JSON object');
            }
            const body = rawBody as Record<string, unknown>;

            const artistId = typeof body.artistId === 'string' ? body.artistId : null;
            if (!artistId) return ApiProblem.validationFailed('artistId is required');
            if (!UUID_RE.test(artistId))
                return ApiProblem.validationFailed('artistId must be a valid UUID');

            const [albumRow] = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${internalId} AND status = 'active'
            `;
            if (!albumRow) return ApiProblem.notFound('Media item not found');
            if (albumRow.media_type !== 'album')
                return ApiProblem.validationFailed('Media item is not an album');

            const [artistRow] = await sql<{ id: string; title: string }[]>`
                SELECT id, COALESCE(title, '') AS title FROM media_items
                WHERE id = ${artistId} AND media_type = 'artist' AND status = 'active'
            `;
            if (!artistRow) return ApiProblem.notFound('Artist not found');

            let artistTitle: string;
            try {
                artistTitle = (
                    await saveAlbumArtist(
                        sql,
                        internalId,
                        username,
                        { artistId },
                        typeof body.snapshot === 'string' ? body.snapshot : undefined,
                    )
                ).artistTitle;
            } catch (err) {
                const invalid = assignmentProblem(err);
                if (invalid) return invalid;
                // uq_music_album_parent_title: the target artist already has an
                // album with this title (the usual case when merging duplicates).
                if (isUniqueViolation(err)) {
                    return ApiProblem.conflict(
                        'The artist already has an album with this title; merge the albums instead',
                    );
                }
                throw err;
            }
            return json(ArtistMutateResponseSchema.parse({ artistId, artistTitle }));
        },

        POST: async (event) => {
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            let rawBody: unknown;
            try {
                rawBody = await readBoundedJson(event.request);
            } catch {
                return ApiProblem.validationFailed('Invalid request body');
            }
            if (!rawBody || typeof rawBody !== 'object' || Array.isArray(rawBody)) {
                return ApiProblem.validationFailed('Request body must be a JSON object');
            }
            const body = rawBody as Record<string, unknown>;

            const artistName = typeof body.artistName === 'string' ? body.artistName.trim() : null;
            if (!artistName) return ApiProblem.validationFailed('artistName is required');
            if (artistName.length > MAX_ARTIST_NAME_LENGTH) {
                return ApiProblem.validationFailed(
                    `artistName must be at most ${MAX_ARTIST_NAME_LENGTH} characters`,
                );
            }

            const [albumRow] = await sql<{ media_type: string }[]>`
                SELECT media_type FROM media_items WHERE id = ${internalId} AND status = 'active'
            `;
            if (!albumRow) return ApiProblem.notFound('Media item not found');
            if (albumRow.media_type !== 'album')
                return ApiProblem.validationFailed('Media item is not an album');

            let newArtistId: string;
            try {
                newArtistId = (
                    await saveAlbumArtist(
                        sql,
                        internalId,
                        username,
                        { artistName },
                        typeof body.snapshot === 'string' ? body.snapshot : undefined,
                    )
                ).artistId;
            } catch (err) {
                const invalid = assignmentProblem(err);
                if (invalid) return invalid;
                // uq_music_artist_norm_title: an artist with the same normalized
                // name ('AC/DC' vs 'ACDC') already exists. The UI offers create
                // only when its search shows no exact match, which it cannot
                // see past its first page of results.
                if (isUniqueViolation(err)) {
                    return ApiProblem.conflict(
                        'An artist with this name already exists; assign the album to it instead',
                    );
                }
                throw err;
            }

            return json(
                ArtistMutateResponseSchema.parse({
                    artistId: newArtistId,
                    artistTitle: artistName,
                }),
            );
        },
    },
});
