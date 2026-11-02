// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for `/admin/fix/where-is-it` — "I added a film. Where is it?"
 *
 * ## The question the rest of this surface could not answer
 *
 * Every other explainer here takes a media UUID. That is fine when the item
 * exists — and useless in the case people actually report, where the thing was
 * copied to disk and never appeared, so there IS no UUID to paste. This one is
 * searched by NAME, which is the only identifier the operator has.
 *
 * ## Files and items are searched INDEPENDENTLY, and that is the whole design
 *
 * The valuable answer is almost always a mismatch between the two: a file on
 * disk with no library item, an item with no file, a file linked to an item that
 * was never identified. A search that started from `media_items` would miss
 * every one of those — the file that never became an item is invisible to it,
 * which is precisely the case being investigated.
 *
 * So a match can be anchored on a FILE with no item, on an ITEM with no file, or
 * on both, and the chain reports which.
 *
 * ## A chain of steps, each with a verdict
 *
 * The ingest path is a sequence, and the useful output is the FIRST step that did
 * not happen. Reporting a boolean "not found" would leave the operator exactly
 * where they started.
 */

import { z } from 'zod';

/** One step in the disk → library chain, in the order ingest performs it. */
export const TraceStepSchema = z.object({
    step: z.enum([
        /** A row in `media_files` whose path matches. */
        'file-on-disk',
        /** ffprobe has read the file (`probed_at`). */
        'file-probed',
        /** The file is linked to a library item. */
        'linked-to-item',
        /** The item carries a provider id — it was matched to real metadata. */
        'item-identified',
        /** The item is flagged as having files, which library surfaces require. */
        'item-visible',
        /** Per-item pipeline stages have run. */
        'stages-processed',
    ]),
    /** `ok` — happened. `blocked` — did not, and this is where it stopped. */
    status: z.enum(['ok', 'blocked', 'unknown']),
    /**
     * Which explanation applies, rendered by the page in the user's language
     * with `params`. Codes the page does not know fall back to `detail`.
     */
    code: z.string(),
    /** Values for the explanation (path, size in bytes, ISO dates, counts). */
    params: z.record(z.string(), z.union([z.string(), z.number()])),
    /** The same explanation in English: fallback for unknown codes, and for logs. */
    detail: z.string(),
});
export type TraceStep = z.infer<typeof TraceStepSchema>;

export const TraceStageSchema = z.object({
    stageId: z.string(),
    status: z.string(),
    attempt: z.number(),
    /** Last recorded error message, truncated. Null when the stage never failed. */
    lastError: z.string().nullable(),
});
export type TraceStage = z.infer<typeof TraceStageSchema>;

export const TraceMatchSchema = z.object({
    /** Present when a library item was found. Null for a file with no item. */
    mediaItemId: z.string().nullable(),
    title: z.string(),
    mediaType: z.string().nullable(),
    /** The file path this match is anchored on, when there is one. */
    filePath: z.string().nullable(),
    fileSizeBytes: z.number().nullable(),
    /** True when the scanner has flagged the file as gone from disk. */
    fileMissing: z.boolean(),

    /** The chain, in ingest order. */
    steps: z.array(TraceStepSchema),
    /**
     * The first step with `blocked`, or null when the chain completed. Computed
     * server-side so the page and the API cannot disagree about where it stopped.
     */
    stoppedAt: z.string().nullable(),
    /** Per-stage detail, only when the item reached the pipeline. */
    stages: z.array(TraceStageSchema),
});
export type TraceMatch = z.infer<typeof TraceMatchSchema>;

/** Side reads that failed; the answer is then incomplete in that respect, not empty. */
export const WhereIsItUnreadableSchema = z.enum([
    'quarantine',
    'schedule',
    'runs',
    'stages',
    'item-files',
]);
export type WhereIsItUnreadable = z.infer<typeof WhereIsItUnreadableSchema>;

export const WhereIsItSchema = z.object({
    generatedAt: z.string(),
    query: z.string(),

    /** Matches from either anchor, best first. Empty is a real and useful answer. */
    matches: z.array(TraceMatchSchema),
    /** True when the result set was capped, so the page can say so. */
    truncated: z.boolean(),

    /**
     * Quarantined provider payloads whose title matches. A quarantined item is
     * neither a file nor a library row, so it appears in no other search here —
     * and "it was rejected during sync" is a complete answer to the question.
     */
    quarantined: z.array(
        z.object({
            provider: z.string(),
            externalId: z.string(),
            mediaType: z.string(),
            reason: z.string(),
            createdAt: z.string(),
        }),
    ),

    /**
     * Context for the empty case. If nothing matched, the next question is always
     * "has the scanner even run?", so the answer travels with the miss instead of
     * requiring a second page.
     */
    lastScanCompletedAt: z.string().nullable(),
    /**
     * False when DISABLE_FILE_LIBRARY_SCAN is set or the scan task is paused.
     * Null when it could not be determined (no scheduler row yet, or the read
     * failed) — never a guessed `false`.
     */
    scanEnabled: z.boolean().nullable(),
    unreadable: z.array(WhereIsItUnreadableSchema),
});
export type WhereIsIt = z.infer<typeof WhereIsItSchema>;
