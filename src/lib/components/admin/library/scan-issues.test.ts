// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    classifyScanIssue,
    groupScanIssues,
    relativeToLibraryFolder,
    splitScanIssueSample,
    SCAN_ISSUE_SAMPLE_LIMIT,
} from './scan-issues';

describe('splitScanIssueSample', () => {
    it('splits before a known reason, even one with its own colon', () => {
        // Real shape: `${filePath}: ${onError reason}`, and the ffprobe reason
        // is `ffprobe failed: ${probeOutcome.error}`. A last-": " split glued
        // ": ffprobe failed" onto the displayed file path.
        expect(
            splitScanIssueSample('/srv/stuff/a/Foo.mkv: ffprobe failed: moov atom not found'),
        ).toEqual({ path: '/srv/stuff/a/Foo.mkv', reason: 'ffprobe failed: moov atom not found' });
    });

    it('keeps a path containing ": " whole when the reason is known', () => {
        expect(splitScanIssueSample('/srv/A: B/Foo.mkv: ffprobe failed: bad data')).toEqual({
            path: '/srv/A: B/Foo.mkv',
            reason: 'ffprobe failed: bad data',
        });
    });

    it('falls back to the last ": " for a reason it does not know', () => {
        expect(splitScanIssueSample('/srv/A: B/Foo.mkv: something new')).toEqual({
            path: '/srv/A: B/Foo.mkv',
            reason: 'something new',
        });
    });

    it("keeps a path that itself contains ': ' from swallowing a clean, colon-free reason", () => {
        expect(
            splitScanIssueSample(
                '/data/A: B/movie.mkv: permission denied reading the file (EACCES/EPERM)',
            ),
        ).toEqual({
            path: '/data/A: B/movie.mkv',
            reason: 'permission denied reading the file (EACCES/EPERM)',
        });
    });

    it('returns an empty reason when there is no ": " at all', () => {
        expect(splitScanIssueSample('/data/movies/Foo.mkv')).toEqual({
            path: '/data/movies/Foo.mkv',
            reason: '',
        });
    });
});

describe('classifyScanIssue', () => {
    it('classifies a non-UTF-8 filename reason', () => {
        const sample =
            '/data/movies/Foo.mkv: filename is not valid UTF-8 (contains U+FFFD replacement characters) — rename the file to UTF-8 so it can be ingested';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'non_utf8_filename',
        );
    });

    it('classifies by a U+FFFD replacement character in the path even without the UTF-8 wording', () => {
        const sample = '/data/movies/Foo �.mkv: file processing failed';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'non_utf8_filename',
        );
    });

    it('classifies a control character in the filename', () => {
        const sample =
            '/data/movies/Foo.mkv: Filename contains a control character (e.g. a newline). Rename the file to remove it so it can be ingested.';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'control_character_filename',
        );
    });

    it('classifies permission denied', () => {
        const sample = '/data/movies/Foo.mkv: permission denied reading the file (EACCES/EPERM)';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'permission_denied',
        );
    });

    it('classifies an ffprobe failure even though the reason has its own colon', () => {
        const sample = '/data/movies/Foo.mkv: ffprobe failed: moov atom not found';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'ffprobe_failure',
        );
    });

    it('classifies a playlist/reference container', () => {
        const sample =
            '/data/movies/Foo.m3u8: identified as a playlist/reference container (hls) — never ingested';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'playlist_container',
        );
    });

    it('classifies a filesystem/stat/hash fault distinctly from permission denied', () => {
        const sample =
            '/data/movies/Foo.mkv: a filesystem read failed while checking this file for changes (stat/hash — permission denied, I/O error, or timeout)';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'filesystem_fault',
        );
    });

    it('classifies the legacy generic reason', () => {
        const sample = '/data/movies/Foo.mkv: file processing failed';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe(
            'legacy_unspecified',
        );
    });

    it('falls back to other for an unrecognized reason', () => {
        const sample = '/data/movies/Foo.mkv: something unexpected happened';
        expect(classifyScanIssue(sample, splitScanIssueSample(sample).path)).toBe('other');
    });
});

describe('groupScanIssues', () => {
    it('groups samples by cause and counts totals', () => {
        const summary = groupScanIssues([
            {
                errors: 2,
                errorSamples: [
                    '/data/movies/Foo.mkv: ffprobe failed: moov atom not found',
                    '/data/movies/Bar.mkv: permission denied reading the file (EACCES/EPERM)',
                ],
            },
        ]);
        expect(summary.totalErrors).toBe(2);
        expect(summary.unsampled).toBe(0);
        expect(summary.groups.map((g) => g.cause)).toEqual([
            'permission_denied',
            'ffprobe_failure',
        ]);
        expect(summary.groups[0].files).toEqual([
            {
                path: '/data/movies/Bar.mkv',
                reason: 'permission denied reading the file (EACCES/EPERM)',
            },
        ]);
    });

    it('dedupes the same file appearing across two folders', () => {
        const summary = groupScanIssues([
            { errors: 1, errorSamples: ['/data/a/Dup.mkv: ffprobe failed: bad data'] },
            { errors: 1, errorSamples: ['/data/a/Dup.mkv: ffprobe failed: bad data'] },
        ]);
        expect(summary.groups).toHaveLength(1);
        expect(summary.groups[0].count).toBe(1);
        expect(summary.groups[0].files).toHaveLength(1);
    });

    it('reports unsampled when the writer capped the samples below the error count', () => {
        const summary = groupScanIssues([
            {
                errors: 25,
                errorSamples: Array.from(
                    { length: SCAN_ISSUE_SAMPLE_LIMIT },
                    (_, i) => `/data/movies/File${i}.mkv: ffprobe failed: bad data`,
                ),
            },
        ]);
        expect(summary.totalErrors).toBe(25);
        expect(summary.unsampled).toBe(25 - SCAN_ISSUE_SAMPLE_LIMIT);
    });

    it('ignores the abandoned-run sentinel (-1) when summing totalErrors', () => {
        const summary = groupScanIssues([{ errors: -1, errorSamples: [] }]);
        expect(summary.totalErrors).toBe(0);
        expect(summary.groups).toEqual([]);
    });

    it('returns no groups for runs with no errors', () => {
        expect(groupScanIssues([{ errors: 0, errorSamples: [] }])).toEqual({
            groups: [],
            totalErrors: 0,
            unsampled: 0,
        });
    });
});

describe('relativeToLibraryFolder', () => {
    it('strips a matching folder prefix', () => {
        expect(relativeToLibraryFolder('/data/movies/Foo/Foo.mkv', ['/data/movies'])).toBe(
            'Foo/Foo.mkv',
        );
    });

    it('returns the full path when no folder matches', () => {
        expect(relativeToLibraryFolder('/data/other/Foo.mkv', ['/data/movies'])).toBe(
            '/data/other/Foo.mkv',
        );
    });

    it('handles a folder path already ending in a slash', () => {
        expect(relativeToLibraryFolder('/data/movies/Foo.mkv', ['/data/movies/'])).toBe('Foo.mkv');
    });
});
