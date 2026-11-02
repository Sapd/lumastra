// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Set-series-progress response schema
 * (`POST /api/watched/series/[seriesId]/set-progress`).
 *
 * Split out of `$lib/schemas/api-admin-responses` (2026-09-25, fix round 1)
 * so `$lib/api/user`'s `setSeriesProgress()` — reachable from `/`'s critical
 * path via `+page.svelte:68` (`import * as userApi from '$lib/api/user'`) —
 * doesn't have to import that whole, much heavier schema file just for this
 * one response shape. Re-exported from `api-admin-responses.ts` so existing
 * importers are unaffected. The matching request schema
 * (`SetSeriesProgressRequestSchema`) is server-only (used by
 * `src/lib/server/api/defs/watched/series-set-progress.ts`) and stays in
 * `api-admin-responses.ts` — it does not affect any client bundle.
 */

import { z } from 'zod';

export const SetSeriesProgressResponseSchema = z.object({
    markedWatched: z.number(),
    markedUnwatched: z.number(),
});

export type SetSeriesProgressResponse = z.infer<typeof SetSeriesProgressResponseSchema>;
