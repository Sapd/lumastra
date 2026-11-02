// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for the library-wide ingest funnel.
 *
 * `where-is-it` answers "where did THIS one stop?". This is the same question
 * asked of the whole library, which is the difference between a tool that
 * answers reported problems and one that finds unreported ones.
 *
 * ## A drop is not automatically a problem
 *
 * Measured on production: 100% of music tracks carry no provider id, because
 * tracks are not identified that way in this system. Reported as a drop, that is
 * a fabricated 28,258-file problem on a healthy library. So identification is
 * only evaluated for types where it is expected, and `identified: null` means
 * "not applicable" — never zero, never a finding.
 */

import { z } from 'zod';

/**
 * Per-type steps. There is no "linked" step: a file only gets a media type by
 * reaching an active entry, so within a segment every file is linked by
 * construction. Files that reach none are the library-wide `orphanFiles` and
 * `removedEntryFiles` counts instead.
 */
export const FunnelStepSchema = z.enum(['probed', 'identified', 'visible']);
export type FunnelStep = z.infer<typeof FunnelStepSchema>;

export const FunnelSegmentSchema = z.object({
    mediaType: z.string(),
    present: z.number(),
    probed: z.number(),
    /** Equal to `present` by construction (see FunnelStepSchema); the base for the later steps. */
    linked: z.number(),
    /** Null when a provider id is not expected for this type. Never zero-for-null. */
    identified: z.number().nullable(),
    visible: z.number(),
});
export type FunnelSegment = z.infer<typeof FunnelSegmentSchema>;

/** One place files are being lost, with enough context to act on it. */
export const FunnelFindingSchema = z.object({
    mediaType: z.string(),
    step: FunnelStepSchema,
    /** How many files of this type did not reach this step. */
    dropped: z.number(),
    /** The population the drop is measured against, so a share is computable. */
    outOf: z.number(),
});
export type FunnelFinding = z.infer<typeof FunnelFindingSchema>;

export const IngestFunnelSchema = z.object({
    generatedAt: z.string(),
    /** Files the scanner flagged as gone from disk. Not a funnel drop. */
    missingFiles: z.number(),
    /**
     * Files on disk that were never linked to any library entry — the scan
     * picked them up but nothing was created from them (a naming, encoding or
     * permission problem). Called out separately because they belong to no
     * media type, so they would vanish from a per-type view.
     */
    orphanFiles: z.number(),
    /**
     * Files linked only to entries that are no longer active (removed, merged
     * or replaced). Usually expected after a cleanup or a rematch, so reported
     * apart from `orphanFiles`, which usually needs a fix.
     */
    removedEntryFiles: z.number(),
    segments: z.array(FunnelSegmentSchema),
    /** Every non-zero drop, biggest first. Empty means nothing is being lost. */
    findings: z.array(FunnelFindingSchema),
});
export type IngestFunnel = z.infer<typeof IngestFunnelSchema>;

/**
 * Turn raw segment counts into the drops worth showing.
 *
 * Pure and exported so the rules below are unit-testable without a database —
 * they are the part most likely to be got wrong later, and getting them wrong
 * means either a fabricated problem or a hidden one.
 *
 * Rules:
 *  - `identified: null` yields NO finding. Not applicable is not a failure.
 *  - Each step is measured against the population that reached the PREVIOUS
 *    step, not against the total. Files that never linked cannot also be
 *    reported as unidentified and invisible; that would triple-count one fault
 *    and put the largest number on the least specific cause.
 *  - Zero drops are omitted entirely rather than listed as clean rows.
 */
export function findingsFor(segments: readonly FunnelSegment[]): FunnelFinding[] {
    const out: FunnelFinding[] = [];
    for (const s of segments) {
        if (s.present - s.probed > 0) {
            out.push({
                mediaType: s.mediaType,
                step: 'probed',
                dropped: s.present - s.probed,
                outOf: s.present,
            });
        }
        // Measured against `linked`, the population that reached an entry.
        if (s.identified !== null && s.linked - s.identified > 0) {
            out.push({
                mediaType: s.mediaType,
                step: 'identified',
                dropped: s.linked - s.identified,
                outOf: s.linked,
            });
        }
        if (s.linked - s.visible > 0) {
            out.push({
                mediaType: s.mediaType,
                step: 'visible',
                dropped: s.linked - s.visible,
                outOf: s.linked,
            });
        }
    }
    return out.sort((a, b) => b.dropped - a.dropped);
}

/** Which count a sample request drills into: a funnel step, or a library-wide count. */
export const FunnelSampleKindSchema = z.enum([
    'orphans',
    'missing',
    'removed-entry',
    'probed',
    'identified',
    'visible',
]);
export type FunnelSampleKind = z.infer<typeof FunnelSampleKindSchema>;

export const FunnelSampleSchema = z.object({
    fileId: z.string(),
    filePath: z.string(),
    mediaItemId: z.string().nullable(),
    title: z.string().nullable(),
    mediaType: z.string().nullable(),
    showTitle: z.string().nullable(),
    seasonNumber: z.number().nullable(),
    episodeNumber: z.number().nullable(),
    /**
     * Latest scan issue on the file. For a file that never linked this is often
     * why; a file of a removed entry usually has none.
     */
    issueType: z.string().nullable(),
    issueDetail: z.string().nullable(),
});
export type FunnelSample = z.infer<typeof FunnelSampleSchema>;

export const IngestFunnelSamplesSchema = z.object({
    samples: z.array(FunnelSampleSchema),
    /** More files match than were returned. */
    truncated: z.boolean(),
});
export type IngestFunnelSamples = z.infer<typeof IngestFunnelSamplesSchema>;
