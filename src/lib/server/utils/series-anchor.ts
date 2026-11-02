// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Series Anchor — per-series CW vs NU arbitration.
 *
 * Pure function extracted from `section-builder.ts` so the rule can be
 * unit-tested in isolation and reused by any caller that needs to decide
 * "given a Continue Watching row and a Next Up row for the same series,
 * which one is the right anchor card?".
 *
 * Rule, in order:
 *   1. If only one side exists, that side wins.
 *   2. If CW is for an earlier episode than NU (`cwOrder < nuOrder`), the user
 *      may be catching up on a backlog episode — but only honor that when the
 *      resume is "substantial" (resumeRatio ≥ substantialPercent) or "fresh"
 *      (updatedAt within phantomStalenessDays). A stale, barely-started
 *      backlog row loses to NU, otherwise it outranks the correct next
 *      episode indefinitely.
 *   3. If CW is at-or-ahead of NU and is substantial OR fresh, CW wins —
 *      deliberate jump-ahead or recent activity should be honored.
 *   4. Otherwise CW is ahead-of-sequence + low-progress + stale → phantom
 *      scrub. NU wins.
 *
 * Unknown CW timestamp is treated as fresh: hiding a legitimate resume
 * because metadata is missing is worse than rendering a slightly stale
 * card the user can still dismiss.
 */
import { EPISODE_ORDER_MULTIPLIER } from '$lib/server/utils/jellyfin-units.js';
import type { ContinueWatchingItem } from './section-builder.js';

export type AnchorChoice = 'cw' | 'nu';

export interface SeriesAnchorConfig {
    /** Resume ratio (0..1) above which CW is "substantial". Default 0.20. */
    substantialPercent: number;
    /** Days within which CW is "fresh". Default 3. */
    phantomStalenessDays: number;
    /** Override for "now" — for deterministic tests. Defaults to Date.now(). */
    nowMs?: number;
}

/** The fields the rule reads; a full `ContinueWatchingItem` satisfies it. */
export type SeriesAnchorCandidate = Pick<
    ContinueWatchingItem,
    'seasonNumber' | 'episodeNumber' | 'resumeRatio' | 'updatedAt'
>;

export interface SeriesAnchorInput {
    cw?: SeriesAnchorCandidate | null;
    nu?: SeriesAnchorCandidate | null;
    config: SeriesAnchorConfig;
}

export interface SeriesAnchorResult {
    /** 'cw' | 'nu' | null when both inputs are null. */
    winner: AnchorChoice | null;
    /** Why the rule fired — useful for telemetry / debug, not for branching. */
    reason:
        | 'cw-only'
        | 'nu-only'
        | 'cw-backlog-catchup'
        | 'cw-substantial'
        | 'cw-fresh'
        | 'nu-phantom-scrub'
        | 'nu-stale-backlog'
        | 'none';
}

function episodeOrder(item: SeriesAnchorCandidate): number {
    const s = item.seasonNumber ?? 0;
    const e = item.episodeNumber ?? 0;
    return s * EPISODE_ORDER_MULTIPLIER + e;
}

/**
 * Parsed epoch ms, or null when the timestamp is absent/unparseable.
 *
 * These must stay distinguishable: `null` means "we don't know when this
 * happened" (treated as fresh, see docblock), whereas a real 1970-01-01
 * parses to `0` and is genuinely ancient. Returning 0 for both made an
 * unparseable timestamp and the epoch indistinguishable, so a corrupt
 * timestamp silently counted as fresh — which, now that freshness gates the
 * backlog-catchup branch, would let a stale backlog row outrank Next Up.
 */
function parseTs(iso: string | undefined): number | null {
    if (!iso) return null;
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? null : ms;
}

export function resolveSeriesAnchor(input: SeriesAnchorInput): SeriesAnchorResult {
    const { cw, nu, config } = input;

    if (cw && !nu) return { winner: 'cw', reason: 'cw-only' };
    if (nu && !cw) return { winner: 'nu', reason: 'nu-only' };
    if (!cw || !nu) return { winner: null, reason: 'none' };

    const substantialRatio = config.substantialPercent;
    const substantial = (cw.resumeRatio ?? 0) >= substantialRatio;

    const cwAt = parseTs(cw.updatedAt);
    const stalenessMs = config.phantomStalenessDays * 24 * 60 * 60 * 1000;
    const now = config.nowMs ?? Date.now();
    // Unknown CW timestamp → treat as fresh (see header docblock). A KNOWN
    // but ancient timestamp (including a real epoch value) is not fresh.
    const fresh = cwAt === null || now - cwAt < stalenessMs;

    const cwOrder = episodeOrder(cw);
    const nuOrder = episodeOrder(nu);
    if (cwOrder < nuOrder) {
        // Backlog catch-up, but only when the resume still looks like a live
        // intention. This used to win unconditionally, which meant a months-old
        // barely-started episode outranked the correct next episode forever —
        // the user finishes S07E19 and is offered S04E05 instead of S07E20.
        //
        // Same substantial/fresh test the ahead-of-sequence branch below
        // applies; an earlier episode is not more trustworthy than a later one
        // just because it is earlier.
        if (substantial || fresh) {
            return { winner: 'cw', reason: 'cw-backlog-catchup' };
        }
        return { winner: 'nu', reason: 'nu-stale-backlog' };
    }

    if (substantial) return { winner: 'cw', reason: 'cw-substantial' };
    if (fresh) return { winner: 'cw', reason: 'cw-fresh' };

    return { winner: 'nu', reason: 'nu-phantom-scrub' };
}
