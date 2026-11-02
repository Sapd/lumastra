// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';

/**
 * Song Paths page — /music/path
 *
 * Gated by features.sonicEmbeddings (FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS).
 * Returns 404 when disabled so the route is invisible — consistent with the
 * notFound convention used by all other feature-gated routes.
 *
 * No server data to load: the page is fully client-driven (the path query is
 * a GET from the browser to /api/music/path).
 */
export const load: PageServerLoad = async () => {
    if (!features.sonicEmbeddings) {
        error(404, 'Song Paths requires Sonic Embeddings to be enabled');
    }

    return {};
};
