// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/setup/dependency-check — admin-only: probe the optional sibling
 * services/containers this instance is configured to use (music embedder, Live TV
 * proxy, *arr/download/request services) plus the config-volume mount, so the
 * first-run wizard can surface "configured but unreachable → this feature won't
 * work" hints. Reached at step 3, after the admin is created (session exists), so
 * requireAdmin is appropriate here.
 *
 * Read-only and non-blocking: never writes config, unconfigured services are
 * omitted, and a dead dependency is a warning — it never fails the request.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { runDependencyChecks } from '$lib/server/preflight/dependency-checks.js';

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const checks = await runDependencyChecks();
        return json({ checks });
    }),
);
