// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/library/sources/[id]/+page.server.ts
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals, params }) => {
    // Same gate as the overview page (`../+page.server.ts`): the RESOLVED
    // verdict, not a re-derivation from IdP groups — that misses both the
    // `admin_pinned` DB override and the in-app `admin` capability.
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }
    // The library itself is loaded client-side (same pattern as the
    // overview page) — this route only carries the id through.
    return { id: params.id };
};
