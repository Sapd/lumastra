// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for the "new files aren't showing up" diagnostic.
 *
 * ## Why the schema lives under `components/` and not `$lib/schemas/`
 *
 * The endpoint def (`$lib/server/api/defs/admin/fix/library-scan-check.ts`) and
 * the page that renders it both import THIS module, so the response shape has
 * exactly one definition and cannot drift. `$lib/server/**` is unreachable from
 * the client, and the client's `apiGet` only `.strict()`s the TOP level — a
 * private client-side copy of the shape would silently strip any nested field
 * that drifted. One shared module is the only construction that removes that
 * failure mode entirely.
 */

import { z } from 'zod';

/**
 * Outcome of physically probing one library path from THIS process.
 *
 * `permission-denied` is kept distinct from `missing` because they have
 * completely different fixes and completely different emotional weight: one is
 * a chown, the other looks to the operator like the library deleted itself.
 * `timeout` is its own state because a hung NFS mount is neither — the kernel
 * never answered, and telling someone their path is "missing" when the mount is
 * merely stalled sends them to the wrong fix.
 */
export const PathProbeStateSchema = z.enum([
    'ok',
    'missing',
    'permission-denied',
    'not-a-directory',
    'timeout',
    'error',
    'remote',
    'disabled',
]);
export type PathProbeState = z.infer<typeof PathProbeStateSchema>;

export const PathProbeSchema = z.object({
    state: PathProbeStateSchema,
    /** Owning uid of the directory, when it could be stat'ed. */
    ownerUid: z.number().int().nullable(),
    /** Owning gid of the directory, when it could be stat'ed. */
    ownerGid: z.number().int().nullable(),
    /** Permission bits as a 4-digit octal string, e.g. `0755`. */
    mode: z.string().nullable(),
    /** errno or message — shown verbatim, never interpreted into prose. */
    detail: z.string().nullable(),
});

export const LastScanSchema = z.object({
    startedAt: z.string(),
    completedAt: z.string().nullable(),
    /** Files the walk saw. */
    totalFiles: z.number().int(),
    /**
     * Files that became NEW catalogue entries. Derived, not stored: the scanner
     * writes `matched = added + updated`, so `added = matched - updated`.
     */
    added: z.number().int(),
    updated: z.number().int(),
    unmatched: z.number().int(),
    errors: z.number().int(),
    /** Still running: no `completed_at`, and younger than the abandoned cutoff. */
    running: z.boolean(),
    /**
     * Crash-abandoned rather than finished: the errors column carries the
     * sentinel, or the run has been open past the cutoff
     * (`deriveScannerRunStatus`).
     */
    abandoned: z.boolean(),
});

/**
 * The scanner refused to remove missing files for this folder: its walk found
 * far fewer files than the library knows (`few_files`) or none (`no_files`).
 * `confirmedAt` is set once an admin confirmed that the files are gone; the
 * next scan then removes them once.
 */
export const CleanupHoldSchema = z.object({
    reason: z.enum(['few_files', 'no_files']),
    /** Files the last held walk found. */
    walked: z.number().int(),
    /** Files the library knows for this folder. */
    known: z.number().int(),
    firstHeldAt: z.string(),
    lastHeldAt: z.string(),
    confirmedAt: z.string().optional(),
});

export const ScanPathReportSchema = z.object({
    id: z.string(),
    path: z.string(),
    mediaType: z.string(),
    provider: z.string(),
    enabled: z.boolean(),
    /** Display name of the library group this path belongs to. */
    libraryName: z.string().nullable(),
    /**
     * Items CURRENTLY listed in that library. This is a live measurement, and it
     * is the whole basis for what the page is allowed to say when a path has
     * vanished — see the page's reassurance copy.
     */
    libraryItemCount: z.number().int().nullable(),
    probe: PathProbeSchema,
    /** The scanner-runs read failed, so a null `lastScan` means "unknown", not "never". */
    lastScanUnreadable: z.boolean(),
    lastScan: LastScanSchema.nullable(),
    /** Present while the scanner refuses stale cleanup for this folder. */
    cleanupHold: CleanupHoldSchema.optional(),
});

export const ScanScheduleSchema = z.object({
    /** `DISABLE_FILE_LIBRARY_SCAN` — kills scheduled AND manual scans. */
    globallyDisabled: z.boolean(),
    /** The `file-library-scan` scheduler row was paused by an operator. */
    paused: z.boolean(),
    pausedBy: z.string().nullable(),
    lastFiredAt: z.string().nullable(),
    nextFireAt: z.string().nullable(),
    /** True when no scheduler row exists yet (nothing has ever been scheduled). */
    neverScheduled: z.boolean(),
    /** The scheduler read failed; every other field is then a default, not a measurement. */
    unreadable: z.boolean(),
});

/**
 * Identity of the process doing the reading. Printing the REAL numbers is the
 * point: "permission denied" plus an actual uid turns a forum thread into a
 * single `chown`.
 */
export const ProcessIdentitySchema = z.object({
    /** `process.getuid()` — absent on Windows, where the concept does not apply. */
    uid: z.number().int().nullable(),
    gid: z.number().int().nullable(),
    containerized: z.boolean(),
    platform: z.string(),
});

/** Global pipeline state — where anything the scan found currently sits. */
export const PipelinePositionSchema = z.object({
    inFlight: z.number().int(),
    running: z.number().int(),
    failedLastHour: z.number().int(),
    deadLetterItems: z.number().int(),
    oldestPendingAgeSec: z.number().nullable(),
});

export const LibraryScanCheckSchema = z.object({
    generatedAt: z.string(),
    schedule: ScanScheduleSchema,
    process: ProcessIdentitySchema,
    paths: z.array(ScanPathReportSchema),
    /** Null when the pipeline summary could not be read — never a fabricated zero. */
    pipeline: PipelinePositionSchema.nullable(),
    /**
     * Set when the database was unreachable or the library paths could not be
     * read; the rest of the payload is then empty, and the page shows an error.
     */
    dbError: z.string().nullable(),
});

export type LibraryScanCheck = z.infer<typeof LibraryScanCheckSchema>;
export type CleanupHold = z.infer<typeof CleanupHoldSchema>;
export type ScanPathReport = z.infer<typeof ScanPathReportSchema>;
export type PathProbe = z.infer<typeof PathProbeSchema>;
