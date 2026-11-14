// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { getGuideEndDate } from '$lib/server/database/queries/livetv-programs.queries';

/**
 * `MAX(end_time)` over every visible channel's programs has no index that answers
 * it directly, and the apps poll /LiveTv/GuideInfo. The EPG end only moves when
 * an import runs, so one answer per replica per minute is plenty.
 */
const GUIDE_END_TTL_MS = 60_000;

let cached: { value: Date | null; expiresAt: number } | null = null;
let inFlight: Promise<Date | null> | null = null;

export async function getCachedGuideEndDate(sql: postgres.Sql): Promise<Date | null> {
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    if (!inFlight) {
        inFlight = getGuideEndDate(sql)
            .then((value) => {
                cached = { value, expiresAt: Date.now() + GUIDE_END_TTL_MS };
                return value;
            })
            .finally(() => {
                inFlight = null;
            });
    }
    return inFlight;
}

/** Tests only. */
export function resetGuideEndDateCache(): void {
    cached = null;
    inFlight = null;
}
