// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/media/[id]/music-hierarchy.ts
 *
 * GET /api/admin/media/[id]/music-hierarchy
 *
 * Returns the full music hierarchy tree (artist → albums → tracks) for the
 * admin sidebar. Resolves to the artist root from album or track IDs.
 *
 * Auth: admin.  Surface: internal-only.
 *
 * Response: { ...MusicHierarchy, currentItemId, resolvedFromChild }
 * 503 dependency_unavailable when DB is down.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { adminMediaId } from '$lib/server/utils/admin-media-id.js';
import { getDb } from '$lib/server/database/connection.js';
import { getMusicHierarchy } from '$lib/server/database/queries/music-admin.queries.js';
import type postgres from 'postgres';

// ---------------------------------------------------------------------------
// Response schema — typed from MusicHierarchyResult + currentItemId/resolvedFromChild
// ---------------------------------------------------------------------------

const MusicHierarchyArtistSchema = z.object({
    id: z.string(),
    title: z.string(),
    custom_poster_url: z.string().nullable(),
    album_count: z.number().int(),
    track_count: z.number().int(),
});

const MusicHierarchyTrackSchema = z.object({
    id: z.string(),
    title: z.string().nullable(),
    sort_order: z.number().nullable(),
    runtime_seconds: z.number().nullable(),
    album_id: z.string(),
});

const MusicHierarchyAlbumSchema = z.object({
    id: z.string(),
    title: z.string(),
    year: z.number().nullable(),
    custom_poster_url: z.string().nullable(),
    track_count: z.number().int(),
    sort_order: z.number().nullable(),
    tracks: z.array(MusicHierarchyTrackSchema),
});

export const MusicHierarchyResponseSchema = z.object({
    artist: MusicHierarchyArtistSchema,
    albums: z.array(MusicHierarchyAlbumSchema),
    currentItemId: z.string(),
    resolvedFromChild: z.boolean(),
});

export type MusicHierarchyResponse = z.infer<typeof MusicHierarchyResponseSchema>;

// ---------------------------------------------------------------------------
// Artist-resolution helper (unchanged from original route)
// ---------------------------------------------------------------------------

async function resolveArtistId(sql: postgres.Sql, internalId: string): Promise<string | null> {
    const [row] = await sql<{ media_type: string; parent_id: string | null }[]>`
        SELECT media_type, parent_id
        FROM media_items
        WHERE id = ${internalId}
        LIMIT 1
    `;
    if (!row) return null;
    if (row.media_type === 'artist') return internalId;
    if (row.media_type === 'album') {
        if (!row.parent_id) return null;
        const [artistRow] = await sql<{ media_type: string }[]>`
            SELECT media_type FROM media_items WHERE id = ${row.parent_id} LIMIT 1
        `;
        return artistRow?.media_type === 'artist' ? row.parent_id : null;
    }
    if (row.media_type === 'track') {
        if (!row.parent_id) return null;
        const [albumRow] = await sql<{ media_type: string; parent_id: string | null }[]>`
            SELECT media_type, parent_id FROM media_items WHERE id = ${row.parent_id} LIMIT 1
        `;
        if (albumRow?.media_type !== 'album' || !albumRow.parent_id) return null;
        const [artistRow] = await sql<{ media_type: string }[]>`
            SELECT media_type FROM media_items WHERE id = ${albumRow.parent_id} LIMIT 1
        `;
        return artistRow?.media_type === 'artist' ? albumRow.parent_id : null;
    }
    return null;
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const internalId = adminMediaId(event);
            if (!internalId) return ApiProblem.notFound('Media item not found');

            const artistId = await resolveArtistId(sql, internalId);
            if (!artistId) return ApiProblem.notFound('Could not resolve artist from this item');

            const hierarchy = await getMusicHierarchy(sql, artistId);
            if (!hierarchy) return ApiProblem.notFound('Artist not found');

            return json({
                ...hierarchy,
                currentItemId: internalId,
                resolvedFromChild: artistId !== internalId,
            });
        },
    },
});
