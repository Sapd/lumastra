// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';

/**
 * Text-to-Sound Search page server load.
 *
 * Gated by features.textToSound (FEATURE_MUSIC_TEXT_SOUND &&
 * sonicEmbeddings). Returns a 404 when the feature is disabled so the route
 * is invisible, consistent with the notFound convention used by other
 * feature-gated routes (e.g. Lyrics Search at /music/lyrics-search).
 *
 * The page itself is client-driven (search requests go from the browser to
 * GET /api/music/text-search) so there is no data to load here beyond the
 * gate check.
 */
export const load: PageServerLoad = async () => {
    if (!features.textToSound) {
        error(404, 'Sound Search is not enabled');
    }

    return {};
};
