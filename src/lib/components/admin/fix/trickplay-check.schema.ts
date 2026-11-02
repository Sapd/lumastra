// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for `/admin/fix/seek-previews`.
 *
 * ## The number that makes this a diagnostic
 *
 * Counting stage rows by status answers "how is the work going". It cannot
 * answer "was the work ever queued" — an item with NO row contributes to no
 * bucket, so it is invisible to every status count and to the progress bar built
 * from them. Stage rows are seeded from the task registry snapshot at
 * item-creation time, so a stage registered later gets no row for pre-existing
 * items; a prod incident left 11,186 items with no trickplay coverage while
 * every dashboard read clean.
 *
 * `withoutRow` is therefore reported first and separately. It is the difference
 * between "not done yet" and "never asked for".
 *
 * ## Queue depth alone cannot say whether this is stuck
 *
 * Trickplay is genuinely slow — hours of ffmpeg on a fresh library is normal.
 * So `pending` is not evidence of a problem on its own, and this page defers to
 * the shared throughput gate rather than inventing a second opinion about
 * whether the pipeline is moving.
 */

import { z } from 'zod';

export const TrickplayCheckSchema = z.object({
    generatedAt: z.string(),
    /** The stage these counts describe, stated so the page cannot mislabel them. */
    stageId: z.string(),

    /** Items that should have seek previews: video items with files. */
    eligibleItems: z.number(),
    /** Of those, how many carry a stage row in any status. */
    withRow: z.number(),
    /**
     * Eligible items with NO stage row at all — never queued, invisible to every
     * status count. The silent-gap number this page exists to surface.
     */
    withoutRow: z.number(),

    completed: z.number(),
    pending: z.number(),
    running: z.number(),
    failedTransient: z.number(),
    failedPermanent: z.number(),
    skipped: z.number(),
    obsolete: z.number(),

    /** Whole percent of eligible items with previews generated. */
    coveragePercent: z.number(),

    /** Whether the generating task is switched off. Null when that could not be read. */
    taskPaused: z.boolean().nullable(),
    /** ISO 8601 — when a preview was last generated (stage completion), when known. */
    taskLastFiredAt: z.string().nullable(),
    /** The last-completion read failed, so a null `taskLastFiredAt` means unknown. */
    taskLastFiredUnreadable: z.boolean(),
    /** False when the task is not registered at all (e.g. disabled by config). */
    taskRegistered: z.boolean(),
    /** TRICKPLAY_ENABLED. Off (the default), no previews are generated at all. */
    generationEnabled: z.boolean(),
    /** TRICKPLAY_PROVIDER. `jellyfin_disk` serves Jellyfin's files and generates nothing. */
    provider: z.string(),
});
export type TrickplayCheck = z.infer<typeof TrickplayCheckSchema>;
