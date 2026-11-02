// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';

/**
 * Music Alchemy — Mixing Desk page server load.
 *
 * Gated by features.musicAlchemy (FEATURE_MUSIC_ALCHEMY && FEATURE_MUSIC_CLUSTERING).
 * Returns a 404 when the feature is disabled so the route is invisible, consistent
 * with the notFound convention used by other feature-gated routes.
 *
 * The page itself is client-driven (brew requests are POST from the browser to
 * /api/music/alchemy/brew) so there is no data to load here beyond the gate check.
 */
export const load: PageServerLoad = async () => {
    if (!features.musicAlchemy) {
        error(404, 'Music Alchemy is not enabled');
    }

    return {};
};
