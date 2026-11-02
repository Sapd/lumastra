// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/radio/metadata/preview.ts
 *
 * POST /api/admin/radio/metadata/preview
 *   Preview parsed now-playing output for a candidate metadata-source mapping.
 *   Fetches the metadata URL live and resolves field paths; when that yields
 *   nothing, falls back to ICY metadata from `streamUrl`. Station-less, so the
 *   create form can preview before the station exists — nothing is cached or
 *   saved.
 *
 * Auth: admin.  Surface: internal.
 * Scope: { kind: 'admin' } — internal admin BFF; no v1 surface.
 *
 * POST response: bare RadioNowPlaying object (stationId is the nil UUID).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { previewNowPlaying } from '$lib/server/services/radio-metadata/index.js';
import { RadioMetadataPreviewRequestSchema, RadioNowPlayingSchema } from '$lib/schemas/radio.js';

/** Placeholder id for the preview record; no station row exists yet. */
const PREVIEW_STATION_ID = '00000000-0000-0000-0000-000000000000';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: RadioMetadataPreviewRequestSchema,
    },
    handlers: {
        POST: async (_event, ctx) => {
            const { streamUrl, metadataSource } = ctx.input!.body;
            const result = await previewNowPlaying({
                id: PREVIEW_STATION_ID,
                streamUrl: streamUrl ?? '',
                metadataSource,
            });
            return json(RadioNowPlayingSchema.parse(result));
        },
    },
});
