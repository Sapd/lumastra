// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /Shows/NextUp` query parameters (TvShowsController.GetNextUp).
 */

import { getParam } from './utils';

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

export interface NextUpQuery {
    limit: number;
    startIndex: number;
    seriesId: string | null;
    /**
     * A SeriesId was sent but is not an id at all: the answer is empty (it
     * names no series), never every series' next-up.
     */
    malformedSeriesId: boolean;
    /** A library or series id; anything not shaped like a Jellyfin id is ignored. */
    parentId: string | null;
    /**
     * `enableRewatching=false` sent explicitly: only unwatched next episodes.
     * Absent keeps Lumastra's model, which follows a re-watch (Jellyfin's
     * default is false, but clients that never send it predate the flag).
     */
    requireUnwatchedNext: boolean;
    /** `enableResumable=false`: drop next episodes already in progress (default true). */
    excludeResumable: boolean;
    /** `nextUpDateCutoff`: ignore series not watched since this instant. */
    minLastWatchedAt: Date | null;
}

function flag(url: URL, name: string): boolean | null {
    const v = getParam(url, name)?.trim().toLowerCase();
    return v === 'true' ? true : v === 'false' ? false : null;
}

export function parseNextUpQuery(url: URL): NextUpQuery {
    const parentId = getParam(url, 'ParentId');
    const seriesId = getParam(url, 'SeriesId');
    const cutoffRaw = getParam(url, 'NextUpDateCutoff');
    const cutoff = cutoffRaw ? new Date(cutoffRaw) : null;
    return {
        limit: Math.min(Math.max(1, parseInt(getParam(url, 'Limit') ?? '20', 10) || 20), 100),
        startIndex: Math.max(0, parseInt(getParam(url, 'StartIndex') ?? '0', 10) || 0),
        seriesId: seriesId && UUID_RE.test(seriesId) ? seriesId : null,
        malformedSeriesId: !!seriesId && !UUID_RE.test(seriesId),
        parentId: parentId && UUID_RE.test(parentId) ? parentId : null,
        requireUnwatchedNext: flag(url, 'EnableRewatching') === false,
        excludeResumable: flag(url, 'EnableResumable') === false,
        // 0001-01-01 (DateTime.MinValue, what some clients send) means no cutoff.
        minLastWatchedAt:
            cutoff && !isNaN(cutoff.getTime()) && cutoff.getUTCFullYear() > 1970 ? cutoff : null,
    };
}
