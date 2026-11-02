// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';
import { requireDevTools } from '$lib/server/admin/require-dev-tools.js';
import { appPath } from '$lib/shared/api-urls.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }
    requireDevTools();

    if (!features.sonicEmbeddings) {
        throw redirect(302, appPath('/admin'));
    }

    return {
        title: 'Sonic Embeddings',
        featureEnabled: true,
    };
};
