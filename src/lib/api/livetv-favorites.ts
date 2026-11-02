// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Frontend API client for Live TV channel favorites.
 */

import { apiGet, apiPut } from './client.js';
import { LiveTvFavoritesResponseSchema } from '$lib/schemas/livetv.js';

export function getLiveTvFavorites() {
    return apiGet('/api/livetv/favorites', LiveTvFavoritesResponseSchema);
}

export function setLiveTvFavorite(stationId: string, favorite: boolean) {
    return apiPut('/api/livetv/favorites', LiveTvFavoritesResponseSchema, {
        stationId,
        favorite,
    });
}
