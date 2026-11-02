// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native exemplar: tmdb-metadata-sync.
 *
 * TUTORIAL: This shows the "external API" pattern — rate limiting, circuit
 * breaker, secret retrieval, and graceful degradation when the upstream is
 * down. The real TMDB metadata sync is now `tmdb-metadata-sync-task.ts`; this
 * exemplar re-implements the same outer shape in minimal form so a reader
 * can see how externalDeps + ctx.dep() + ctx.secrets fit together.
 *
 * What it does: pulls TMDB API key from secrets, calls /3/movie/popular,
 * and writes the count into a result. No database writes — keep the
 * exemplar focused on the SDK pattern, not on the underlying business
 * logic.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { tmdbAuthorizedRequest } from '../../../providers/implementations/tmdb/auth.js';

const inputSchema = z.object({
    /** Page to fetch from TMDB. Most callers use 1; >1 for paginating. */
    page: z.number().int().min(1).max(500).default(1),
});

interface TmdbPopularResponse {
    page: number;
    results: Array<{ id: number; title?: string; name?: string }>;
    total_pages?: number;
    total_results?: number;
}

export const tmdbMetadataSyncTask = defineTask<
    z.infer<typeof inputSchema>,
    { fetched: number; page: number }
>({
    id: 'tmdb-metadata',
    purpose: 'library',
    // SDK tutorial exemplar — hidden from admin task listings in production
    // and refused if triggered directly there via the `demo` flag.
    // The real TMDB metadata sync lives at `tmdb-metadata-sync-task.ts`
    // (id: 'tmdb-metadata-sync'); this demo only exists to show the
    // external-API pattern (rate limit + secrets + retry + cost).
    demo: true,
    name: 'TMDB Metadata Sync (demo)',
    version: '2.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { http: true, database: true, cache: true },

    // No schedule — demo. Operators can manual-trigger from /admin/tasks
    // in dev to watch the external-API pattern execute end-to-end.

    identityFor: (input) => `tmdb-popular-${input.page}`,
    scope: 'global',
    // Mass-enrichment / API-bound — drains via bulk pool so it can't
    // saturate the user-visible io path.
    resourceClass: 'bulk',

    // TUTORIAL: declare every external dependency. The runner builds a
    // per-dep rate limiter from `rps` and a per-dep circuit breaker from
    // `circuitBreaker`. ctx.dep('tmdb').fetch() then funnels through both.
    // No more ad-hoc `await sleep(throttleMs)` calls scattered through
    // your code.
    externalDeps: [
        {
            name: 'tmdb',
            rps: 40, // TMDB free tier: 40 req/s, 1000 req/min
            retryAfter: 'header',
            circuitBreaker: { failures: 5, cooldownMs: 60_000 },
        },
    ],

    inputSchema,

    // TUTORIAL: retry is declarative. The runner reads the error thrown
    // from execute and consults `retryOn` to decide whether to re-enqueue.
    // 'transient' kinds defined in @sapd/lumastra-plugin-sdk get retried by
    // default; arbitrary errors fall through to `retryOn`.
    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: (err) => {
            const msg = err instanceof Error ? err.message : String(err);
            return /5\d\d|ECONNRESET|ETIMEDOUT|ENOTFOUND/.test(msg);
        },
    },

    timeout: { hard: '5m', soft: '4m' },
    cost: { kind: 'api_calls' },

    async execute(ctx) {
        // TUTORIAL: secrets are fetched from the encrypted plugin_secrets
        // table, never from process.env at runtime. Every access is logged
        // for SOC2-style audit trails. The key path is plugin-namespaced
        // automatically.
        const apiKey = await ctx.secrets.get('tmdb_api_key').catch(() => '');
        if (!apiKey) {
            ctx.logger.warn('tmdb api key not configured; skipping');
            return {
                success: false,
                itemsProcessed: 0,
                result: { fetched: 0, page: ctx.input.page },
            };
        }

        // TUTORIAL: ctx.dep('tmdb').fetch is a wrapped fetch that honours
        // the rps cap from externalDeps and circuit-trips on repeated
        // failures. Treat it as fetch(): you still call .json(), check
        // .ok, etc. The wrapper preserves AbortSignal semantics.
        const url = new URL('https://api.themoviedb.org/3/movie/popular');
        url.searchParams.set('page', String(ctx.input.page));
        // A v3 key goes in ?api_key=, a v4 Read Access Token in a Bearer header.
        const request = tmdbAuthorizedRequest(url, apiKey, { Accept: 'application/json' });

        const response = await ctx.dep('tmdb').fetch(request.url, {
            signal: ctx.signal,
            headers: request.headers,
        });

        if (!response.ok) {
            // TUTORIAL: throwing here triggers the `retry` machinery
            // above. The runner inspects the error kind via retryOn.
            throw new Error(`tmdb popular returned ${response.status}`);
        }

        const data = (await response.json()) as TmdbPopularResponse;

        // TUTORIAL: the runner measures every HTTP attempt and records api_calls
        // in cost_breakdown automatically, including retries and redirects.

        ctx.reportProgress(data.results.length, data.results.length);

        ctx.logger.info('tmdb popular fetched', {
            page: data.page,
            count: data.results.length,
        });

        return {
            success: true,
            itemsProcessed: data.results.length,
            result: { fetched: data.results.length, page: data.page },
        };
    },
});

registry.registerTask(tmdbMetadataSyncTask);
