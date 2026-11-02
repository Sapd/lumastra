// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';
import { localsIsAdminOrArrManager } from '$lib/server/auth/locals-admin.js';

/**
 * Sonic Collections page server load.
 *
 * Gated by features.musicClusters (FEATURE_MUSIC_CLUSTERS &&
 * FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS). Returns a 404 when
 * the feature is disabled so the route is invisible, consistent with the
 * notFound convention used by other feature-gated routes.
 *
 * The page is client-driven — cluster data is fetched from
 * /api/music/sonic-mixes — so there is no data to load here beyond the gate and
 * `isAdmin`, which gates an operator-only "regenerate" hint. It used to read
 * `$page.data.user.isAdmin`, which is not a field on AppUserInfo and was
 * therefore always undefined — the hint never rendered. Mirrors /music/map.
 */
export const load: PageServerLoad = async ({ locals }) => {
    if (!features.musicClusters) {
        error(404, 'Sonic Collections is not enabled');
    }

    return {
        isAdmin: localsIsAdminOrArrManager(locals),
    };
};
