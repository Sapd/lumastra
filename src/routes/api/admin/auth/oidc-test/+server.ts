// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/auth/oidc-test
 *
 * Admin-only OIDC discovery probe for the saved active configuration. This is
 * the post-onboarding counterpart to /api/setup/oidc-test, which is intentionally
 * first-run-only and unauthenticated.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { isOidcConfigured, probeOidcDiscovery } from '$lib/server/services/oidc.service.js';

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        if (!isOidcConfigured()) {
            return json({
                ok: false,
                error: 'OIDC is not configured on this instance.',
                insecure: false,
                requestedScopes: [],
            });
        }

        return json(await probeOidcDiscovery());
    }),
);
