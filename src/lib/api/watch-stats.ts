// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch stats read — `getWatchStats()` only.
 *
 * Split out of `$lib/api/admin` (2026-09-25, fix round 1) so
 * `PopularMediaStats.svelte` — mounted on `/browse` — doesn't have to pull in
 * the whole admin API client module just to show the popular-media widget.
 * Re-exported from `$lib/api/admin` so other importers keep working.
 */

import { apiGet } from './client.js';
import { WatchStatsResponseSchema } from '$lib/schemas/api-watch-stats-response.js';

export function getWatchStats(options?: { type?: string; limit?: number; timeframe?: string }) {
    return apiGet('/api/watch-stats', WatchStatsResponseSchema, {
        params: {
            type: options?.type,
            limit: options?.limit,
            timeframe: options?.timeframe,
        },
    });
}
