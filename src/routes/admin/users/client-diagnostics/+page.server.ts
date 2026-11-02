// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * /admin/users/client-diagnostics — supplies RedactOptions roots for the
 * per-incident "Copy for GitHub" inside PlaybackIncidentDetail.svelte.
 * Mirrors transcode-failures/+page.server.ts (and the former
 * playback-incidents/+page.server.ts) exactly.
 */

import type { PageServerLoad } from './$types';
import type { RedactOptions } from '$lib/shared/transcode-failure-report.js';
import { getDb } from '$lib/server/database/connection.js';
import { getEnabledLibraryPaths } from '$lib/server/database/queries/library-paths.queries.js';
import { config } from '$lib/server/config.js';
import { redirect } from '@sveltejs/kit';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals }) => {
    // Own gate, not only the admin layout's: SvelteKit runs this load in
    // parallel with the layout, so without it the library roots and the
    // transcode dir were read (and returned) for any signed-in user.
    if (!localsIsAdmin(locals)) redirect(303, appPath('/'));

    const sql = getDb();
    const libraryPaths = sql ? await getEnabledLibraryPaths(sql) : [];

    const roots: RedactOptions = {
        libraryRoots: libraryPaths.map((p) => p.path),
        transcodeRoot: config.FFMPEG_TRANSCODE_DIR,
    };

    return {
        isAdmin: true,
        roots,
    };
};
