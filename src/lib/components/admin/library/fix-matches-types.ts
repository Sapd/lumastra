// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared types for the Fix-matches workbench (admin IA redesign, spec §3.2).
 * Lives under $lib so both the route's server load
 * (src/routes/admin/library/fix-matches/+page.server.ts) and
 * BrokenMatchPanel.svelte depend on the SAME shape without a route file
 * importing from another route file, or a $lib component reaching into
 * src/routes/.
 */

import type { BrokenMatchCause } from './fix-matches-cause.js';

/** One re-identification ("broken match") row, flattened for the page. */
export interface BrokenMatchRowView {
    mediaItemId: string;
    title: string;
    /**
     * The series a season/episode row belongs to. Identification happens at the
     * series level, so Fix match on such a row targets this id, not the row.
     */
    seriesId?: string;
    seriesTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    /** Canonical media type discriminator — use `type`, never `mediaType`. */
    type: string;
    stageId: string;
    errorMessage?: string;
    /** What kind of breakage this is — decides which action leads. */
    cause: BrokenMatchCause;
    deadSince: string;
    /** Release year, when known — disambiguation context for the Identify modal. */
    year?: number;
    /** Default (or first) file's path — disambiguation context for the Identify modal. */
    filePath?: string;
    seasonCount?: number;
    episodeCount?: number;
}

export interface BrokenMatchData {
    items: BrokenMatchRowView[];
    total: number;
    /** Active toolbar filters (from ?q= / ?type=), echoed so the panel can show them. */
    search: string;
    mediaType: 'movie' | 'series' | undefined;
    offset: number;
    pageSize: number;
    dbError: string | null;
}
