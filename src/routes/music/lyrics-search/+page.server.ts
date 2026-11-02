// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';

/**
 * Lyrics Search page server load.
 *
 * Gated by features.lyricsSearch (FEATURE_MUSIC_LYRICS_SEARCH &&
 * aiRecommendations). Returns a 404 when the feature is disabled so the
 * route is invisible, consistent with the notFound convention used by other
 * feature-gated routes (e.g. Music Alchemy at /music/alchemy).
 *
 * The page itself is client-driven (search requests are GET from the browser
 * to /api/music/lyrics-search) so there is no data to load here beyond
 * the gate check.
 */
export const load: PageServerLoad = async () => {
    if (!features.lyricsSearch) {
        error(404, 'Lyrics Search is not enabled');
    }

    return {};
};
