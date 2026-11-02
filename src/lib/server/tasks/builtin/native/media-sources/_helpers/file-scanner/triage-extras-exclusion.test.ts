// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test: the scanner's fast triage (`triageFiles`) must never
 * classify an extras path (named subfolder like `trailers/`, or a Jellyfin
 * filename-suffix extra like `Film-trailer.mkv`) into any bucket that feeds
 * `processVideoFile`'s attach flow — not `newFiles`, not `maybeChanged`, not
 * `unchanged`.
 *
 * Why this matters even though the disk walk already excludes extras from its
 * own listing: `knownFiles` is loaded straight from the DB
 * (`loadMediaFilesByPrefix`) and can carry an orphaned extras row — e.g. one
 * left DB-known-but-unlinked by a junction-row repair (see
 * `reconcile-series-fix-report.md`, "Repair v2"). Before the fix, such a path
 * — if it ever reached `triageFiles` via `files` — would be classified
 * `newFiles` (`!cached.is_linked` looks identical to "genuinely new"), and the
 * scanner's main loop would then re-attach it to the folder's primary item as
 * a version, instead of leaving it for the dedicated `walkExtras` →
 * `processExtra` pass.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeStat: vi.fn().mockResolvedValue({ mtimeMs: 0, size: 0 }),
}));
vi.mock('../../../../../../database/queries/media-files.queries.js', () => ({
    updateFileStat: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../../../../utils/file-hash.js', () => ({
    hashFileHead: vi.fn().mockResolvedValue('deadbeef'),
}));

import { triageFiles } from './shared.js';
import type { KnownFileRow } from '../../../../../../database/queries/media-files.queries.js';

const MOVIE_ROOT = '/data/movies/Cinderella (1950) [imdbid-tt0042332]';
const PRIMARY = `${MOVIE_ROOT}/Cinderella (1950) [imdbid-tt0042332].mkv`;
const TRAILER_IN_SUBFOLDER = `${MOVIE_ROOT}/trailers/Cinderella-trailer.mp4`;
const SUFFIX_EXTRA = `${MOVIE_ROOT}/Cinderella-trailer.mkv`;

function orphanedRow(filePath: string): KnownFileRow {
    return {
        id: 'orphan-file-uuid',
        file_path: filePath,
        file_mtime: null,
        file_size_bytes: null,
        file_hash_head: null,
        health_issues: null,
        is_linked: false,
    };
}

describe('triageFiles — extras paths never enter a video-processing bucket', () => {
    it('drops a DB-known-but-unlinked extras subfolder path entirely (never "new")', async () => {
        const knownFiles = new Map<string, KnownFileRow>([
            [TRAILER_IN_SUBFOLDER, orphanedRow(TRAILER_IN_SUBFOLDER)],
        ]);

        // Simulates a candidate source that (incorrectly, or in a future
        // regression) feeds a DB-known extras path into triage alongside the
        // walked files — the guard must hold regardless of how it got here.
        const result = await triageFiles([TRAILER_IN_SUBFOLDER], knownFiles);

        expect(result.newFiles).not.toContain(TRAILER_IN_SUBFOLDER);
        expect(result.maybeChanged).not.toContain(TRAILER_IN_SUBFOLDER);
        expect(result.unchanged).not.toContain(TRAILER_IN_SUBFOLDER);
        expect(result.newFiles).toHaveLength(0);
        expect(result.maybeChanged).toHaveLength(0);
        expect(result.unchanged).toHaveLength(0);
    });

    it('drops a DB-known-but-unlinked filename-suffix extra entirely', async () => {
        const knownFiles = new Map<string, KnownFileRow>([
            [SUFFIX_EXTRA, orphanedRow(SUFFIX_EXTRA)],
        ]);

        const result = await triageFiles([SUFFIX_EXTRA], knownFiles);

        expect(result.newFiles).toHaveLength(0);
        expect(result.maybeChanged).toHaveLength(0);
        expect(result.unchanged).toHaveLength(0);
    });

    it('a genuine new primary file alongside an excluded extra still triages as new', async () => {
        const knownFiles = new Map<string, KnownFileRow>([
            [TRAILER_IN_SUBFOLDER, orphanedRow(TRAILER_IN_SUBFOLDER)],
        ]);

        const result = await triageFiles([PRIMARY, TRAILER_IN_SUBFOLDER], knownFiles);

        expect(result.newFiles).toEqual([PRIMARY]);
        expect(result.newFiles).not.toContain(TRAILER_IN_SUBFOLDER);
    });

    it('unaffected: a normal unlinked (non-extras) file is still classified new', async () => {
        const knownFiles = new Map<string, KnownFileRow>([[PRIMARY, orphanedRow(PRIMARY)]]);

        const result = await triageFiles([PRIMARY], knownFiles);

        expect(result.newFiles).toEqual([PRIMARY]);
    });

    it('a library whose ROOT sits under an extras-named folder still triages its files', async () => {
        const root = '/media/Shorts';
        const file = `${root}/Some Short (2019)/Some Short (2019).mkv`;
        const result = await triageFiles(
            [file],
            new Map([[PRIMARY, orphanedRow(PRIMARY)]]),
            200,
            root,
        );
        expect(result.newFiles).toEqual([file]);
    });
});
