// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/dependency-check — admin-only: the same optional-dependency
 * reachability report the first-run wizard uses (music embedder, Live TV proxy,
 * *arr/download/request services, config-volume mount), plus — because a DB handle
 * is available here — media-library-path readability from this node.
 *
 * Powers the DependencyChecksPanel on the admin health page. Read-only and
 * non-blocking: a dead dependency is a warning, never an error.
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { runDependencyChecks } from '$lib/server/preflight/dependency-checks.js';

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const sql = await aiDbService.getSql();
        const checks = await runDependencyChecks(sql ?? undefined);
        return json({ checks });
    }),
);
