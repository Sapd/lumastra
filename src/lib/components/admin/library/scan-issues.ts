// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turns a library's scan-run error samples into operator-facing groups for
 * the Issues section.
 *
 * `error_samples` rows are written as `"<absolute file path>: <reason>"` by
 * the scanner (see `src/lib/server/tasks/builtin/native/media-sources/file-
 * scanner.ts` and its `_helpers/file-scanner/*` writers, which call
 * `onError?.(...)` with the reason text classified below). A path can itself
 * contain `": "` (a folder literally named that), so a sample is split at
 * the LAST `": "` rather than the first.
 */

export type ScanIssueCause =
    | 'non_utf8_filename'
    | 'control_character_filename'
    | 'permission_denied'
    | 'ffprobe_failure'
    | 'playlist_container'
    | 'filesystem_fault'
    | 'legacy_unspecified'
    | 'other';

export interface ScanIssueFile {
    path: string;
    /** The raw reason text this file's sample carried — shown verbatim for 'other'. */
    reason: string;
}

export interface ScanIssueGroup {
    cause: ScanIssueCause;
    /** Distinct files in this group, across every folder's runs. */
    count: number;
    /** Sorted by path, deduped by path (a file re-erroring across folders counts once). */
    files: ScanIssueFile[];
}

export interface ScanIssuesSummary {
    groups: ScanIssueGroup[];
    /** Sum of each run's `errors` count — the authoritative total, not the sample count. */
    totalErrors: number;
    /** `totalErrors` minus how many samples were actually written — 0 when nothing was capped. */
    unsampled: number;
}

/** The subset of `ScannerRun` this module reads — kept narrow so callers don't need the full type. */
export interface ScanIssueRun {
    errors: number;
    errorSamples: readonly string[];
}

/**
 * The writer's per-run cap (`SCANNER_RUN_ERROR_SAMPLE_LIMIT` in
 * `src/lib/server/database/queries/file-scanner-runs.queries.ts`), copied
 * here rather than imported — that module is server-only and this one is
 * bundled into the client.
 */
export const SCAN_ISSUE_SAMPLE_LIMIT = 20;

const REPLACEMENT_CHAR = '�';

/** Fixed display order — most actionable / most common causes first. */
const CAUSE_ORDER: readonly ScanIssueCause[] = [
    'permission_denied',
    'non_utf8_filename',
    'control_character_filename',
    'ffprobe_failure',
    'playlist_container',
    'filesystem_fault',
    'legacy_unspecified',
    'other',
];

/** Splits `"<path>: <reason>"` at the LAST `": "` — a path may itself contain `": "`. */
/**
 * How every reason the scanner writes BEGINS (video-processor.ts `onError`,
 * file-scanner.ts, shared.ts processItems). Several carry their own `": "`
 * (`ffprobe failed: <detail>`), so a plain last-`": "` split glued
 * `": ffprobe failed"` onto the file path. A known reason start is found
 * first; the last `": "` is only the fallback for a reason this list lacks.
 */
const KNOWN_REASON_STARTS = [
    'ffprobe failed',
    'filename is not valid UTF-8',
    'Filename contains a control character',
    'permission denied',
    'identified as a playlist/reference container',
    'probe failed transiently',
    'a filesystem read failed',
    'audio tag/probe processing failed',
    'file processing failed',
    'processing failed',
] as const;

export function splitScanIssueSample(sample: string): ScanIssueFile {
    let idx = -1;
    for (const start of KNOWN_REASON_STARTS) {
        idx = Math.max(idx, sample.lastIndexOf(`: ${start}`));
    }
    if (idx === -1) idx = sample.lastIndexOf(': ');
    if (idx === -1) return { path: sample, reason: '' };
    return { path: sample.slice(0, idx), reason: sample.slice(idx + 2) };
}

/**
 * Classifies one sample into a cause with an operator fix.
 *
 * This searches the FULL raw sample (`"<path>: <reason>"`), not the
 * `reason` half `splitScanIssueSample` derives — the scanner's own reason
 * text often has its own colon (`"ffprobe failed: ${probeOutcome.error}"`),
 * so splitting at the last `": "` (required so a path containing `": "`
 * doesn't get mangled) can cut a keyword like "ffprobe failed" back onto the
 * path side. The keyword phrases below are distinctive enough that matching
 * them anywhere in the sample, path included, doesn't misfire.
 *
 * Order matters: the stat/hash fault message ("...permission denied, I/O
 * error, or timeout)") itself contains the substring "permission denied" as
 * part of its own description, so filesystem-fault is checked before the
 * permission-denied test to keep it out of that bucket.
 */
export function classifyScanIssue(sample: string, path: string): ScanIssueCause {
    if (sample.includes('not valid UTF-8') || path.includes(REPLACEMENT_CHAR)) {
        return 'non_utf8_filename';
    }
    if (/control character/i.test(sample)) return 'control_character_filename';
    if (/stat\/hash/i.test(sample)) return 'filesystem_fault';
    if (/EACCES|EPERM|permission denied/i.test(sample)) return 'permission_denied';
    if (/ffprobe failed/i.test(sample)) return 'ffprobe_failure';
    if (/playlist\/reference container/i.test(sample)) return 'playlist_container';
    if (/:\s*file processing failed\s*$/i.test(sample)) return 'legacy_unspecified';
    return 'other';
}

/**
 * Groups every run's error samples by cause, deduping a file that appears in
 * more than one folder's samples to a single entry.
 */
export function groupScanIssues(runs: readonly ScanIssueRun[]): ScanIssuesSummary {
    let totalErrors = 0;
    let sampledCount = 0;
    const byCause = new Map<ScanIssueCause, Map<string, string>>();

    for (const run of runs) {
        if (run.errors > 0) totalErrors += run.errors;
        for (const sample of run.errorSamples) {
            sampledCount += 1;
            const { path, reason } = splitScanIssueSample(sample);
            const cause = classifyScanIssue(sample, path);
            let files = byCause.get(cause);
            if (!files) {
                files = new Map();
                byCause.set(cause, files);
            }
            if (!files.has(path)) files.set(path, reason);
        }
    }

    const groups: ScanIssueGroup[] = CAUSE_ORDER.filter((cause) => byCause.has(cause)).map(
        (cause) => {
            const files = byCause.get(cause);
            const sorted = [...(files ?? new Map())]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([path, reason]) => ({ path, reason }));
            return { cause, count: sorted.length, files: sorted };
        },
    );

    return { groups, totalErrors, unsampled: Math.max(0, totalErrors - sampledCount) };
}

/** A file's path relative to whichever folder it's under, or the full path when none matches. */
export function relativeToLibraryFolder(filePath: string, folderPaths: readonly string[]): string {
    for (const folder of folderPaths) {
        const withSlash = folder.endsWith('/') ? folder : `${folder}/`;
        if (filePath.startsWith(withSlash)) return filePath.slice(withSlash.length);
    }
    return filePath;
}
