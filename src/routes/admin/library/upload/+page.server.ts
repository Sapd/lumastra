// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/library/upload/+page.server.ts
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { aiDbService } from '$lib/server/services/database.service';
import { getAllLibraryPaths } from '$lib/server/database/queries/library-paths.queries';
import { UPLOADABLE_LIBRARY_TYPES } from '$lib/server/services/upload-session.service';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    const sql = await aiDbService.getSql();
    if (!sql) return { libraryPaths: [] };

    const allPaths = await getAllLibraryPaths(sql);
    const libraryPaths = allPaths
        .filter((p) => UPLOADABLE_LIBRARY_TYPES.has(p.media_type) && p.enabled)
        .map((p) => ({
            id: p.id,
            path: p.path,
            media_type: p.media_type,
        }));

    return { libraryPaths };
};
