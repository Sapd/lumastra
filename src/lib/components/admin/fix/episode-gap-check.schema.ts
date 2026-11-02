// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for `/admin/fix/missing-episodes`.
 *
 * ## Measured live from the episode catalog
 *
 * series-sync writes every episode the provider lists as a catalog row and the
 * scanner marks the ones with a file, so "the provider lists 24, you have 19" is
 * a count over current rows (`getEpisodeGapsFromCatalog`). The page used to read
 * `series_health_reports`, whose only writer had lost its only caller — it said
 * "0 of N series analysed" on every instance, forever.
 *
 * ## What the page must not flatter
 *
 *   - `unmeasuredSeries`: series with files but no provider episode list at all.
 *     They cannot show a gap, which is not the same as having none.
 *   - `conflictedSeries`: series holding a file the provider never matched. Their
 *     "missing" rows are usually on disk under another numbering, so they are
 *     counted and sent to `wrong-match`, never listed as missing.
 *   - The catalog is as fresh as the last series-sync, so its last run and paused
 *     state travel with the data.
 *
 * Shared by the endpoint def and the page — one definition, no drift.
 */

import { z } from 'zod';

export const EpisodeGapSeriesSchema = z.object({
    seriesId: z.string(),
    title: z.string(),
    /** Aired, non-special episodes with a file. */
    held: z.number(),
    /** Aired, non-special episodes the provider lists that have no file. */
    missing: z.number(),
    /** Seasons with at least one missing episode. */
    seasonsAffected: z.number(),
});
export type EpisodeGapSeries = z.infer<typeof EpisodeGapSeriesSchema>;

export const EpisodeGapCheckSchema = z.object({
    generatedAt: z.string(),

    /** Active series with at least one episode on disk — the denominator. */
    seriesWithFiles: z.number(),
    /** Of those, series with no provider episode list to compare against. */
    unmeasuredSeries: z.number(),
    /** Of those, series whose files the provider never matched (see header). */
    conflictedSeries: z.number(),
    /** Series with a real, countable shortfall. */
    seriesWithGaps: z.number(),
    /** Missing episodes summed over `seriesWithGaps`, not just the listed ones. */
    missingTotal: z.number(),

    /** Whether the task that refreshes the episode catalog is switched off. */
    syncPaused: z.boolean(),
    /** ISO 8601 — when that task last ran, when known. */
    syncLastFiredAt: z.string().nullable(),
    /** The run history could not be read, so a null `syncLastFiredAt` means unknown, not never. */
    syncLastRunUnreadable: z.boolean(),

    /** Biggest gaps first. Capped server-side: evidence, not an inventory. */
    gaps: z.array(EpisodeGapSeriesSchema),
    /** True when `gaps` was truncated, so the page can say so rather than imply completeness. */
    gapsTruncated: z.boolean(),
});
export type EpisodeGapCheck = z.infer<typeof EpisodeGapCheckSchema>;
