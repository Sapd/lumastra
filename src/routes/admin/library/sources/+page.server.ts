// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/library/+page.server.ts
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals, url }) => {
    // Same gate as the /admin layout: the RESOLVED verdict. Re-deriving it from
    // IdP groups misses both non-group admin paths — the `admin_pinned` DB
    // override and the in-app `admin` capability (see buildUserPermissions).
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }
    // The Library Types tab moved to Settings → Homepage & navigation; keep old
    // links (`?tab=types`, which the Tabs component wrote into the URL) working.
    if (url.searchParams.get('tab') === 'types') {
        throw redirect(308, appPath('/admin/settings/homepage?tab=library-types'));
    }
    return {};
};
