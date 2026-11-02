// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LiveTvAiring, LiveTvNowNext } from '$lib/schemas/livetv.js';

/** Pick from a collapsed station schedule. Sorting also makes unsorted input safe. */
export function pickNowNext(airings: readonly LiveTvAiring[], nowMs: number): LiveTvNowNext {
    const ordered = airings.filter((airing) => {
        const start = Date.parse(airing.startTime);
        const end = Date.parse(airing.endTime);
        return Number.isFinite(start) && Number.isFinite(end) && end > start;
    }).sort(
        (a, b) => Date.parse(a.startTime) - Date.parse(b.startTime) ||
            Date.parse(a.endTime) - Date.parse(b.endTime) || a.id.localeCompare(b.id),
    );
    const current = ordered.find(
        (airing) => Date.parse(airing.startTime) <= nowMs && nowMs < Date.parse(airing.endTime),
    ) ?? null;
    const after = current ? Date.parse(current.endTime) : nowMs;
    const next = ordered.find((airing) => Date.parse(airing.startTime) >= after) ?? null;
    return { current, next };
}
