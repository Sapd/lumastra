// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repairs trickplay_params rows whose thumbnail height is the old 16:9 guess.
 *
 * Until providers reported `thumbnailHeight`, every row stored
 * `round(width * 9 / 16)`. For a 4:3 or scope source the sheets have taller
 * or shorter tiles, so each row offset landed between two thumbnails and the
 * preview showed the bottom of one frame above the top of the next. Each row
 * is measured once from its own sheets: the local manifest for generated
 * sheets, the first sheet's image header for Jellyfin's.
 */

import type postgres from 'postgres';
import {
    listUnmeasuredTrickplayParams,
    setTrickplayMeasuredHeight,
    type UnmeasuredTrickplayRow,
} from '../../../database/queries/trickplay-params.queries.js';
import { getTrickplayManifest } from '../../../services/trickplay-storage.service.js';

const BATCH_SIZE = 200;
// A stalled mount must not hold the run past its budget on one row.
const MEASURE_TIMEOUT_MS = 15_000;

function withTimeout(work: Promise<number | null>): Promise<number | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), MEASURE_TIMEOUT_MS);
    });
    return Promise.race([work.catch(() => null), timeout]).finally(() => clearTimeout(timer));
}

export interface TrickplayHeightRepairDeps {
    measure: (row: UnmeasuredTrickplayRow) => Promise<number | null>;
}

async function measureRow(row: UnmeasuredTrickplayRow): Promise<number | null> {
    if (row.source === 'local') {
        const manifest = await getTrickplayManifest(row.file_id, row.width, row.file_path);
        return manifest && manifest.width === row.width && manifest.height > 0
            ? manifest.height
            : null;
    }
    if (row.source === 'jellyfin-disk' && row.file_path) {
        // Lazy: the provider module registers itself on import.
        const { readJellyfinDiskThumbnailHeight } =
            await import('./trickplay-providers/jellyfin-disk.js');
        return readJellyfinDiskThumbnailHeight(row.file_path, row.width);
    }
    return null;
}

/**
 * Measure unmeasured rows until none are left, the budget runs out or the
 * signal aborts. A row that cannot be measured now (sheet unreadable, mount
 * hiccup) keeps its height and is retried on the next run.
 */
export async function repairTrickplayHeights(
    sql: postgres.Sql,
    opts: { budgetMs: number; signal?: AbortSignal },
    deps: TrickplayHeightRepairDeps = { measure: measureRow },
): Promise<{ measured: number; changed: number; unmeasurable: number }> {
    const deadline = Date.now() + opts.budgetMs;
    let after: { mediaItemId: string; fileId: string; width: number } | null = null;
    let measured = 0;
    let changed = 0;
    let unmeasurable = 0;

    while (!opts.signal?.aborted && Date.now() < deadline) {
        const rows = await listUnmeasuredTrickplayParams(sql, after, BATCH_SIZE);
        if (rows.length === 0) break;
        for (const row of rows) {
            if (opts.signal?.aborted || Date.now() >= deadline) break;
            after = { mediaItemId: row.media_item_id, fileId: row.file_id, width: row.width };
            const height = await withTimeout(deps.measure(row));
            if (height === null || !Number.isInteger(height) || height <= 0) {
                unmeasurable++;
                continue;
            }
            await setTrickplayMeasuredHeight(sql, after, height);
            measured++;
            if (height !== row.height) changed++;
        }
        if (rows.length < BATCH_SIZE) break;
    }
    return { measured, changed, unmeasurable };
}
