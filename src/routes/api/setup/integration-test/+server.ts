// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/setup/integration-test — admin-only: validate a TMDB or MDBList API
 * key by making one lightweight authenticated call to the provider, mirroring
 * /api/setup/embedding-test and /api/setup/assistant-test for the metadata
 * providers. A bad TMDB/MDBList key otherwise fails silently into "posters
 * missing later" — this surfaces it during setup.
 *
 * If `apiKey` is omitted/blank, falls back to the already-configured key
 * (config.TMDB_API_KEY / config.MDBLIST_API_KEY) so the wizard can also
 * re-verify a previously saved key. Both provider hosts are fixed constants
 * (no user-controlled URL), so there is no SSRF surface here.
 */

import { readBoundedJson } from '$lib/server/utils/bounded-body-reader';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import {
    describeSetupFetchFailure,
    setupProbeHttpError,
} from '$lib/server/utils/fetch-error-cause.js';
import { config } from '$lib/server/config.js';
import { probeTmdbKey } from '$lib/server/services/tmdb-key-probe.js';
import { isRecord, toStringOr } from '$lib/utils/data-extraction.js';

const ENDPOINT = '/api/setup/integration-test';
const PROVIDERS = ['tmdb', 'mdblist'] as const;
type IntegrationProvider = (typeof PROVIDERS)[number];
const PROBE_TIMEOUT_MS = 10_000;

interface IntegrationTestResult {
    ok: boolean;
    error?: string;
}

async function testMdblistKey(apiKey: string): Promise<IntegrationTestResult> {
    const url = `https://api.mdblist.com/lists/user?apikey=${encodeURIComponent(apiKey)}`;

    try {
        const res = await fetchWithTimeout(url, {}, PROBE_TIMEOUT_MS);
        if (res.status === 401) {
            return { ok: false, error: 'Invalid MDBList API key' };
        }
        if (!res.ok) {
            return { ok: false, error: setupProbeHttpError(res.status) };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, error: describeSetupFetchFailure(err, url, [apiKey]) };
    }
}

export const POST: RequestHandler = requireAdmin(
    withErrorHandler(async ({ request }) => {
        let body: unknown;
        try {
            body = await readBoundedJson(request);
        } catch {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }
        if (!isRecord(body)) {
            return ApiResponses.badRequest('Invalid request body', undefined, ENDPOINT);
        }

        const provider = toStringOr(body.provider, '') as IntegrationProvider;
        const apiKey = toStringOr(body.apiKey, '').trim();

        if (!PROVIDERS.includes(provider)) {
            return ApiResponses.badRequest('Unknown integration provider', undefined, ENDPOINT);
        }

        const configuredKey = provider === 'tmdb' ? config.TMDB_API_KEY : config.MDBLIST_API_KEY;
        const effectiveKey = apiKey || configuredKey.trim();

        if (!effectiveKey) {
            return json({ ok: false, error: 'No key configured' });
        }

        const result =
            provider === 'tmdb'
                ? await probeTmdbKey(effectiveKey)
                : await testMdblistKey(effectiveKey);
        return json(result);
    }),
);
