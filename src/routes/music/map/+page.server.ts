// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';
import { localsIsAdminOrArrManager } from '$lib/server/auth/locals-admin.js';

/**
 * Music Map — /music/map server load.
 *
 * Gated by features.musicMap (FEATURE_MUSIC_MAP && sonicEmbeddings).
 * Returns 404 when the feature is disabled.
 *
 * No map data is pre-loaded here; the client fetches /api/music/map via XHR so
 * the page is immediately interactive even before data arrives. We do surface
 * `isAdmin` so the empty-state can offer a "Compute now" trigger to operators.
 */
export const load: PageServerLoad = async ({ locals }) => {
    if (!features.musicMap) {
        error(404, 'Music Map is not enabled');
    }

    return {
        isAdmin: localsIsAdminOrArrManager(locals),
    };
};
