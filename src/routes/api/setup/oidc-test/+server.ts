// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/setup/oidc-test — first-run only: probe the configured OIDC issuer's
 * discovery document so the wizard can verify reachability + config BEFORE the
 * operator commits to signing in (parity with the Jellyfin "Test connection"
 * button and the live forward-auth identity check).
 *
 * Guard: this runs on step 1 of onboarding, BEFORE any admin exists, so it can't
 * use requireAdmin. Instead it is first-run-only — inert (404) once an admin
 * exists, mirroring the /setup page's own redirect guard, so it never becomes an
 * unauthenticated discovery-probe surface post-onboarding.
 *
 * It probes only the configured AUTH_OIDC_ISSUER, but before setup that value
 * may come from any visitor (`/api/setup/oidc-config` is public then), so the
 * probe is rate-limited per IP like the other unauthenticated setup endpoints.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { adminExists } from '$lib/server/database/queries/users.queries.js';
import { probeOidcDiscovery, isOidcConfigured } from '$lib/server/services/oidc.service.js';
import { config } from '$lib/server/config.js';
import { getClientIpStrict } from '$lib/server/utils/client-ip.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';

const ENDPOINT = '/api/setup/oidc-test';

export const GET: RequestHandler = withErrorHandler(async (event) => {
    // First-run only: once an admin exists onboarding is closed — don't expose an
    // unauthenticated discovery probe.
    const sql = await aiDbService.getSql();
    if (!sql) {
        return ApiResponses.error('Database unavailable', undefined, 503, ENDPOINT);
    }
    if (await adminExists(sql, config.ADMIN_GROUPS)) {
        return ApiResponses.notFound('setup', ENDPOINT);
    }

    const gate = await checkRateLimit(`setup-oidc:ip:${getClientIpStrict(event)}`, 30, 15 * 60);
    if (!gate.allowed) return ApiResponses.rateLimited(gate.resetAt * 1000, ENDPOINT);

    if (!isOidcConfigured()) {
        return json({
            ok: false,
            error: 'OIDC is not configured on this instance.',
            insecure: false,
            requestedScopes: [],
        });
    }

    const result = await probeOidcDiscovery();
    return json(result);
});
