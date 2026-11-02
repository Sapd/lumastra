// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import {
    describeSetupFetchFailure,
    setupProbeHttpError,
} from '$lib/server/utils/fetch-error-cause.js';
import { tmdbAuthorizedRequest } from '$lib/server/providers/implementations/tmdb/auth.js';
import * as m from '$lib/paraglide/messages';

const PROBE_TIMEOUT_MS = 10_000;
export type TmdbKeyProbeResult = { ok: true } | { ok: false; retryable: boolean; error: string };

export async function probeTmdbKey(apiKey: string): Promise<TmdbKeyProbeResult> {
    const { url, headers } = tmdbAuthorizedRequest(
        'https://api.themoviedb.org/3/configuration',
        apiKey,
    );

    try {
        const res = await fetchWithTimeout(url, { headers }, PROBE_TIMEOUT_MS);
        if (res.status === 401) {
            return { ok: false, retryable: false, error: m.setup_tmdb_invalid_key() };
        }
        if (!res.ok) {
            return { ok: false, retryable: true, error: setupProbeHttpError(res.status) };
        }
        return { ok: true };
    } catch (err) {
        return { ok: false, retryable: true, error: describeSetupFetchFailure(err, url, [apiKey]) };
    }
}
