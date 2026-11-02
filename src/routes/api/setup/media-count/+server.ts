// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/setup/media-count — admin-only: how many active media items exist.
 *
 * The setup wizard calls this once the first scan reports terminal, to tell
 * "found N items" from "found nothing" (wrong folder / media type / empty mount)
 * — a scan can complete successfully having created zero items, which must NOT be
 * shown as "your library is ready". On the first library the global count equals
 * that library's items.
 *
 * It also reports whether the latest scan of each library had to add files
 * WITHOUT metadata because the metadata provider could not be asked (Windows
 * e2e S5 — every TMDB lookup 401'd while the wizard said "ready"):
 *
 *   { count, metadataUnavailable, metadataProviderError }
 *   metadataProviderError: 'tmdb_auth'           — TMDB rejected its API key
 *                          'provider_auth'       — another provider's key rejected
 *                          'provider_unavailable'— no metadata provider configured
 *                          null                  — matching ran normally
 */

import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import {
    countActiveMediaItems,
    getLatestScanMetadataProblem,
    type ScanMetadataProblem,
} from '$lib/server/database/queries/onboarding.queries.js';

const ENDPOINT = '/api/setup/media-count';

type WizardProviderError = 'tmdb_auth' | 'provider_auth' | 'provider_unavailable' | null;

function toWizardProviderError(problem: ScanMetadataProblem): WizardProviderError {
    if (problem.metadataUnavailable <= 0 || !problem.metadataProviderError) return null;
    if (problem.metadataProviderError === 'unavailable') return 'provider_unavailable';
    return problem.metadataProviderId?.startsWith('tmdb') ? 'tmdb_auth' : 'provider_auth';
}

export const GET: RequestHandler = requireAdmin(
    withErrorHandler(async () => {
        const sql = await aiDbService.getSql();
        if (!sql) {
            return ApiResponses.error('Database unavailable', undefined, 503, ENDPOINT);
        }
        const [count, problem] = await Promise.all([
            countActiveMediaItems(sql),
            getLatestScanMetadataProblem(sql),
        ]);
        return json({
            count,
            metadataUnavailable: problem.metadataUnavailable,
            metadataProviderError: toWizardProviderError(problem),
        });
    }),
);
