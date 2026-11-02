// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Continue Watching row invariants.
 *
 * Each invariant codifies "this should never be true of an item shown in the
 * Continue Watching row." They serve two purposes:
 *   1. Unit tests — lock the behavior of buildMergedWatchingSection and the
 *      CW query so regressions are caught before they ship.
 *   2. Admin drift detector — a live admin page can run these against current
 *      user state and surface users whose rows contain violations (usually
 *      a sign of a sync gap, a stuck migration, or a bug).
 */

import type { RowInvariant } from './types.js';
import { completionThresholdFor } from '../watch-constants.js';

const MUSIC_TYPES = new Set(['music', 'audio', 'podcast', 'track', 'album', 'artist']);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The subset of a user_media_state + media_items row that CW audits care
 * about. Mirrors ContinueWatchingRow; duplicated here to keep the audit
 * module free of a direct dependency on the DB query module (keeps the
 * invariants cheap to import in tests).
 */
export interface CWAuditItem {
    media_id: string;
    media_type: string;
    resume_position_ms: number;
    runtime_ms: number | null;
    is_watched: boolean;
    updated_at: string | null;
}

function ratio(item: CWAuditItem): number | null {
    if (!item.runtime_ms || item.runtime_ms <= 0) return null;
    return item.resume_position_ms / item.runtime_ms;
}

function hoursSince(iso: string | null): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) return null;
    return (Date.now() - ms) / (60 * 60 * 1000);
}

export const CW_INVARIANTS: readonly RowInvariant<CWAuditItem>[] = [
    {
        id: 'is-not-watched',
        description: 'Continue Watching must not contain rows already marked is_watched=true',
        check: (item) => item.is_watched === false,
    },
    {
        id: 'not-complete-by-ratio',
        description:
            'Progress must be below the runtime-aware completion threshold — items past that should have been auto-flipped to is_watched',
        check: (item) => {
            const r = ratio(item);
            if (r === null) return true; // unknown runtime — safety filter lets through
            const threshold = completionThresholdFor(item.media_type, item.runtime_ms ?? undefined);
            return r < threshold;
        },
    },
    {
        id: 'has-min-progress',
        description: 'Progress must be above the minimum (>= 0.10) when runtime is known',
        check: (item) => {
            const r = ratio(item);
            if (r === null) return true; // unknown runtime — SQL falls back to time floor
            return r >= 0.1;
        },
    },
    {
        id: 'not-music-type',
        description: 'Music-family media types do not belong in Continue Watching',
        check: (item) => !MUSIC_TYPES.has(item.media_type.toLowerCase()),
    },
    {
        id: 'not-stale-beyond-60d',
        description:
            'Rows not touched in 60+ days are likely abandoned and should not keep appearing',
        check: (item) => {
            const hours = hoursSince(item.updated_at);
            if (hours === null) return true;
            return hours < 60 * 24;
        },
    },
];

/**
 * Cross-reference invariants that need both CW and NU context.
 * Flags items whose presence in CW is shadowing a more appropriate NU card.
 */
export interface CWCrossRefItem extends CWAuditItem {
    series_id: string | null;
    season_number: number | null;
    episode_number: number | null;
}

export interface CWCrossRefContext {
    nextUpBySeries: Map<string, { season_number: number; episode_number: number }>;
    substantialRatio: number; // 0–1
    phantomStalenessMs: number;
}

export function detectPhantomShadows(
    cwItems: CWCrossRefItem[],
    ctx: CWCrossRefContext,
): CWCrossRefItem[] {
    const phantoms: CWCrossRefItem[] = [];
    const now = Date.now();
    for (const item of cwItems) {
        if (!item.series_id) continue;
        const nu = ctx.nextUpBySeries.get(item.series_id);
        if (!nu) continue;
        const cwOrder = (item.season_number ?? 0) * 10000 + (item.episode_number ?? 0);
        const nuOrder = nu.season_number * 10000 + nu.episode_number;
        if (cwOrder < nuOrder) continue; // backlog — legitimate CW win
        const r = ratio(item);
        const substantial = r !== null && r >= ctx.substantialRatio;
        const updatedMs = item.updated_at ? Date.parse(item.updated_at) : NaN;
        const fresh = !Number.isNaN(updatedMs) && now - updatedMs < ctx.phantomStalenessMs;
        if (!substantial && !fresh) phantoms.push(item);
    }
    return phantoms;
}

export { DAY_MS };
