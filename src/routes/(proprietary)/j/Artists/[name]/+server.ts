// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Artists/{name} — one artist by name (ArtistsController.GetArtistByName).
// Exact, case-insensitive match against top-level artists the caller can see
// (the predicate GET /Artists lists with); 404 otherwise, so a name that only
// exists in a denied library reads the same as an unknown one.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    mapRowToMediaItem,
    serializeBaseItem,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { findVisibleArtistByName } from '$lib/server/proprietary/jellyfin-compat/music-mix.queries';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('JellyfinCompat:ArtistByName');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, params } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }
    const name = params.name?.trim();
    if (!name) {
        return ApiResponses.badRequest('Artist name is required');
    }

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const row = await findVisibleArtistByName(sql, name, access.boundary);
        if (!row) {
            return ApiResponses.notFound('Artist not found');
        }
        const item = mapRowToMediaItem(row);
        await applyJellyfinContentLanguage(sql, locals.user?.userId, [item]);
        const dto = serializeBaseItem(item);
        await enrichItemsWithProviderIds(sql, [dto]);
        return json(dto);
    } catch (e) {
        logger.warn('Failed to load artist by name', { error: e });
        return ApiResponses.error('Failed to load artist');
    }
});
