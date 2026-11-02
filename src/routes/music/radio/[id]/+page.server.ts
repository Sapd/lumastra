// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service.js';
import { error } from '@sveltejs/kit';
import { getNowPlaying } from '$lib/server/services/radio-metadata';
import type { RadioMetadataSource } from '$lib/schemas/radio';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { buildImageRefs } from '$lib/shared/api-urls.js';

export const load: PageServerLoad = async ({ params, locals }) => {
    const sql = await aiDbService.getSql();
    if (!sql || !locals.user) throw error(401);

    const rows = await sql<
        Array<{
            id: string;
            title: string;
            custom_metadata: Record<string, unknown>;
            custom_poster_url: string | null;
        }>
    >`
        SELECT id, title,
               COALESCE(custom_metadata, '{}'::jsonb) AS custom_metadata,
               custom_poster_url
        FROM media_items
        WHERE id = ${params.id}
          AND media_type = 'radio'
        LIMIT 1
    `;

    if (rows.length === 0) throw error(404, 'Station not found');

    // Gate by library + age. Without this, /music/radio/[uuid] reveals
    // station title, genre, description, and stream_url for any caller
    // who knows the UUID.
    if (!(await checkMediaAccess(sql, rows[0].id, locals.user))) {
        throw error(404, 'Station not found');
    }

    const row = rows[0];
    const meta = row.custom_metadata;
    const streamUrl = String(meta.stream_url ?? '');
    const metadataSource = meta.metadata_source as RadioMetadataSource | undefined;

    const nowPlaying = await getNowPlaying({
        id: row.id,
        streamUrl,
        metadataSource,
    });

    return {
        station: {
            id: String(row.id),
            type: 'radio' as const,
            name: String(row.title),
            genre: meta.genre ? String(meta.genre) : undefined,
            images: row.custom_poster_url ? buildImageRefs(row.id, 'internal') : undefined,
            description: meta.description ? String(meta.description) : undefined,
        },
        nowPlaying,
    };
};
