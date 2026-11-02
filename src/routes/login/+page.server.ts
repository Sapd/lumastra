// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { redirect, isRedirect } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { adminExists } from '$lib/server/database/queries/users.queries.js';
import { sanitizeRedirect } from '$lib/server/utils/safe-redirect.js';
import { appPath } from '$lib/shared/api-urls.js';
import { listLoginProviders } from '$lib/server/services/plugin-auth-login-options.js';

export const load: PageServerLoad = async ({ locals, url, setHeaders }) => {
    const redirectTo = sanitizeRedirect(url.searchParams.get('redirect'), '/');

    // Already authenticated (valid session cookie populated locals.user) → leave.
    if (locals.user) throw redirect(303, redirectTo);

    let unavailable = false;
    try {
        const sql = await aiDbService.getSql();
        if (!sql) unavailable = true;
        else if (!(await adminExists(sql, config.ADMIN_GROUPS)))
            throw redirect(303, appPath('/setup'));
    } catch (error) {
        if (isRedirect(error)) throw error;
        unavailable = true;
    }
    if (unavailable) setHeaders({ 'Retry-After': '5', 'Cache-Control': 'no-store' });

    const nativeEnabled = config.AUTH_NATIVE_LOGIN_ENABLED;
    // Shared predicate — the forward-auth redirect gate sends anonymous page
    // loads here based on the SAME value. If the two ever disagree, visitors
    // ping-pong between /login and the page they came from.
    const oidcEnabled = config.AUTH_OIDC_LOGIN_AVAILABLE;

    // Operator-allowlisted auth plugins. Counted as a sign-in method below, or a
    // deployment whose ONLY login method is a plugin would bounce off this page
    // straight back to the page the visitor came from, forever.
    const pluginProviders = listLoginProviders();

    // No built-in sign-in method here (forward-auth-only deployment) → nothing to
    // log in to; hand back to the normal (forward-auth) flow.
    if (!unavailable && !nativeEnabled && !oidcEnabled && pluginProviders.length === 0) {
        throw redirect(303, redirectTo);
    }

    return {
        redirectTo,
        unavailable,
        nativeEnabled,
        oidcEnabled,
        oidcProviderName: config.AUTH_OIDC_PROVIDER_NAME,
        pluginProviders,
    };
};
