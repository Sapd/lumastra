// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Plugin-owned pages: /p/<featureId>[/<pageId>]
//
// ⚠️ NOTHING STATIC MAY EVER BE ADDED UNDER `src/routes/p/`.
//
// A static sibling would permanently shadow any plugin whose feature id
// happened to match it, and the plugin author would have no way to know why
// their page 404s. `/api/plugins/*` already has this problem — its `holidays`
// and `webhook`-adjacent static children mean no feature may ever use those
// ids — which is exactly why this namespace was created fresh rather than
// nested there. A test pins that this directory keeps exactly one child.

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

/** Does this viewer satisfy the page's declared access rules? */
function mayView(
    access: { adminOnly?: boolean; groups?: string[] } | undefined,
    user: App.Locals['user'],
    isAdmin: boolean,
): boolean {
    if (!access) return true;
    if (access.adminOnly && !isAdmin) return false;
    if (access.groups?.length) {
        const groups = new Set(user?.userGroups ?? []);
        if (!access.groups.some((g) => groups.has(g))) return false;
    }
    return true;
}

export const load: PageServerLoad = async ({ params, locals }) => {
    const feature = taskRegistry.getAllFeatures().find((f) => f.id === params.featureId);
    const pageId = params.page ?? 'index';
    const declared = feature?.pages?.find((p) => p.id === pageId);

    // 404 rather than 403 on a denied page, matching the media-access
    // convention: a 403 confirms the page exists, which tells an unauthorized
    // viewer which plugins are installed.
    if (!feature || !declared || !mayView(declared.access, locals.user, localsIsAdmin(locals))) {
        throw error(404, 'Not found');
    }

    return {
        featureId: feature.id,
        page: { id: declared.id, title: declared.title, entry: declared.entry },
    };
};
