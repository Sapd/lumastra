// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    getTrickplayBacklogCounts,
    TRICKPLAY_PARAMS_PROCESSING_VERSION,
    type TrickplayBacklogCounts,
} from '$lib/server/database/queries/trickplay-params.queries.js';

const DISPLAY_REFRESH_MS = 30_000;
const DISPLAY_KEY = `v1:trickplay-coverage-display:${TRICKPLAY_PARAMS_PROCESSING_VERSION}`;
interface DisplayReading {
    key: string;
    expiresAt: number;
    promise: Promise<TrickplayBacklogCounts>;
}
const readings = new WeakMap<postgres.Sql, DisplayReading>();

/**
 * Poll the catalogue at most once per 30 seconds per web process/DB pool.
 * Only admin display callers use this bounded-staleness reading; task drains
 * and eligibility decisions keep calling the uncached query. Concurrent pages
 * share the pending read, failures are retried, and hits cannot extend its age.
 */
export async function getTrickplayDisplayCounts(
    sql: postgres.Sql,
): Promise<TrickplayBacklogCounts> {
    const cached = readings.get(sql);
    if (cached?.key === DISPLAY_KEY && Date.now() < cached.expiresAt) {
        return { ...(await cached.promise) };
    }
    const reading: DisplayReading = {
        key: DISPLAY_KEY,
        expiresAt: Infinity,
        promise: getTrickplayBacklogCounts(sql, TRICKPLAY_PARAMS_PROCESSING_VERSION),
    };
    readings.set(sql, reading);
    try {
        const counts = await reading.promise;
        reading.expiresAt = Date.now() + DISPLAY_REFRESH_MS;
        return { ...counts };
    } catch (error) {
        if (readings.get(sql) === reading) readings.delete(sql);
        throw error;
    }
}

/** Drop this pool's cached reading so the next display call queries again (tests). */
export function resetTrickplayDisplayCounts(sql: postgres.Sql): void {
    readings.delete(sql);
}
