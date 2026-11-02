// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A fully superseded multi-episode file is skipped by the scan only while the
 * file and every file covering it are as they were.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { KnownFileRow } from '$lib/server/database/queries/media-files.queries.js';

const stats = new Map<string, { size: number; mtimeMs: number }>();
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeStat: async (p: string) => {
        const s = stats.get(p);
        if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return s;
    },
}));

import { partitionSupersededRangeFiles } from './multi-episode-links.js';

const RANGE = '/tv/Show/Season 01/Show S01E01E02.mkv';
const E1 = '/tv/Show/Season 01/Show S01E01.mkv';
const E2 = '/tv/Show/Season 01/Show S01E02.mkv';
const MTIME = new Date('2026-10-20T10:00:00Z');

function row(p: string, over: Partial<KnownFileRow> = {}): KnownFileRow {
    return {
        id: p,
        file_path: p,
        file_mtime: MTIME,
        file_size_bytes: 100,
        file_hash_head: null,
        health_issues: null,
        absolute_episode: null,
        is_linked: true,
        ...over,
    } as KnownFileRow;
}

function known(rangeOver: Partial<KnownFileRow> = {}): Map<string, KnownFileRow> {
    return new Map([
        [E1, row(E1)],
        [E2, row(E2)],
        [
            RANGE,
            row(RANGE, {
                is_linked: false,
                health_issues: [
                    {
                        type: 'range_superseded',
                        detected_at: MTIME.toISOString(),
                        superseded_by: [E1, E2],
                    },
                ],
                ...rangeOver,
            }),
        ],
    ]);
}

describe('partitionSupersededRangeFiles', () => {
    beforeEach(() => {
        stats.clear();
        stats.set(RANGE, { size: 100, mtimeMs: MTIME.getTime() });
    });

    it('keeps legacy path/link evidence unproven without current SQL proof', async () => {
        const r = await partitionSupersededRangeFiles([RANGE], known(), new Set([E1, E2, RANGE]));
        expect(r).toEqual({ process: [RANGE], superseded: [] });
    });

    it('processes it when a covering file is not in the walk', async () => {
        const r = await partitionSupersededRangeFiles([RANGE], known(), new Set([E1, RANGE]));
        expect(r).toEqual({ process: [RANGE], superseded: [] });
    });

    it('processes it when a covering file lost its link', async () => {
        const k = known();
        k.set(E2, row(E2, { is_linked: false }));
        const r = await partitionSupersededRangeFiles([RANGE], k, new Set([E1, E2, RANGE]));
        expect(r.process).toEqual([RANGE]);
    });

    it('processes it when the file itself changed', async () => {
        stats.set(RANGE, { size: 101, mtimeMs: MTIME.getTime() });
        const r = await partitionSupersededRangeFiles([RANGE], known(), new Set([E1, E2, RANGE]));
        expect(r.process).toEqual([RANGE]);
    });

    it('processes a stub without the reason or without covering files', async () => {
        const noReason = await partitionSupersededRangeFiles(
            [RANGE],
            known({ health_issues: null }),
            new Set([E1, E2, RANGE]),
        );
        expect(noReason.process).toEqual([RANGE]);
        const empty = await partitionSupersededRangeFiles(
            [RANGE],
            known({
                health_issues: [{ type: 'range_superseded', detected_at: '', superseded_by: [] }],
            }),
            new Set([E1, E2, RANGE]),
        );
        expect(empty.process).toEqual([RANGE]);
    });
});
