// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test: detectFileChanges must NOT collapse a benign "file deleted
 * mid-scan" (ENOENT / ESTALE) into 'error'.
 *
 * A prior fix made per-file 'error' outcomes surface in run history. But
 * detectFileChanges bare-caught EVERY stat/hash failure into 'error', so a file
 * that legitimately vanished between enumeration and change-detection (routine
 * library churn) inflated error counts and tripped false "broken scan" alarms.
 *
 * The fix branches on `err.code`: ENOENT/ESTALE (and the bare errno -116 that
 * Linux libuv sometimes emits for ESTALE) → a benign 'deleted' status; only
 * genuine faults (EACCES / EIO / timeout) → 'error'.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stats } from 'node:fs';

const fsMock = vi.hoisted(() => ({ safeStat: vi.fn(), hashFileHead: vi.fn() }));
vi.mock('$lib/server/utils/safe-fs.js', () => ({ safeStat: fsMock.safeStat }));
vi.mock('$lib/server/utils/file-hash.js', () => ({ hashFileHead: fsMock.hashFileHead }));

import { detectFileChanges } from './change-detection.js';
import type { FileChangeInput } from './change-detection.js';

function codeError(code: string): Error {
    return Object.assign(new Error(code), { code });
}
function errnoError(errno: number): Error {
    // Linux libuv sometimes surfaces ESTALE as a bare numeric errno, no `code`.
    return Object.assign(new Error(`errno ${errno}`), { errno });
}
function fakeStat(): Stats {
    return { mtimeMs: 1_000, mtime: new Date(1_000), size: 42 } as unknown as Stats;
}

// A file with stored mtime+hash so the code reaches the stat path (not backfill).
const KNOWN: FileChangeInput = {
    file_mtime: new Date(1_000),
    file_size_bytes: 42,
    file_hash_head: 'abc',
};
// A brand-new file with nothing stored → first-backfill path (hits hashFileHead).
const NEW: FileChangeInput = {
    file_mtime: null,
    file_size_bytes: null,
    file_hash_head: null,
};

describe('detectFileChanges — ENOENT/ESTALE are benign, real faults are errors', () => {
    beforeEach(() => {
        fsMock.safeStat.mockReset();
        fsMock.hashFileHead.mockReset();
    });

    it('safeStat ENOENT → deleted (not error)', async () => {
        fsMock.safeStat.mockRejectedValue(codeError('ENOENT'));
        const r = await detectFileChanges(KNOWN, '/gone.mkv');
        expect(r.status).toBe('deleted');
    });

    it('safeStat ESTALE → deleted', async () => {
        fsMock.safeStat.mockRejectedValue(codeError('ESTALE'));
        const r = await detectFileChanges(KNOWN, '/gone.mkv');
        expect(r.status).toBe('deleted');
    });

    it('safeStat bare errno -116 (ESTALE without code) → deleted', async () => {
        fsMock.safeStat.mockRejectedValue(errnoError(-116));
        const r = await detectFileChanges(KNOWN, '/gone.mkv');
        expect(r.status).toBe('deleted');
    });

    it('safeStat EACCES → error (genuine fault)', async () => {
        fsMock.safeStat.mockRejectedValue(codeError('EACCES'));
        const r = await detectFileChanges(KNOWN, '/locked.mkv');
        expect(r.status).toBe('error');
    });

    it('hashFileHead ENOENT during first-backfill → deleted', async () => {
        fsMock.safeStat.mockResolvedValue(fakeStat());
        fsMock.hashFileHead.mockRejectedValue(codeError('ENOENT'));
        const r = await detectFileChanges(NEW, '/gone.mkv');
        expect(r.status).toBe('deleted');
    });

    it('hashFileHead EACCES during first-backfill → error', async () => {
        fsMock.safeStat.mockResolvedValue(fakeStat());
        fsMock.hashFileHead.mockRejectedValue(codeError('EACCES'));
        const r = await detectFileChanges(NEW, '/locked.mkv');
        expect(r.status).toBe('error');
    });
});

/**
 * Regression: a file replacement whose first 64KB (hashFileHead's sample
 * window) happens to match the previous file's head hash — e.g. two MKV
 * remuxes from a similar source sharing byte-identical container headers —
 * must never be classified 'metadata-only' when the size actually changed.
 * 'metadata-only' is documented as "touch, backup restore": neither of those
 * legitimate causes changes file size. A size delta is unambiguous proof the
 * content changed, so it must win over a head-hash coincidence regardless of
 * what the sampled hash says — otherwise every downstream invalidation
 * (streams, chapters, segments, trickplay, artwork) silently never re-runs
 * and stale data serves forever with no error or retry path.
 */
describe('detectFileChanges — size delta always means content-changed', () => {
    beforeEach(() => {
        fsMock.safeStat.mockReset();
        fsMock.hashFileHead.mockReset();
    });

    const STORED: FileChangeInput = {
        file_mtime: new Date(1_000),
        file_size_bytes: 100,
        file_hash_head: 'same-hash',
    };

    it('size changed + head hash coincidentally matches → content-changed, not metadata-only', async () => {
        fsMock.safeStat.mockResolvedValue({
            mtimeMs: 5_000,
            mtime: new Date(5_000),
            size: 200, // different size
        } as unknown as Stats);
        fsMock.hashFileHead.mockResolvedValue('same-hash'); // head bytes coincide
        const r = await detectFileChanges(STORED, '/replaced.mkv');
        expect(r.status).toBe('content-changed');
    });

    it('size unchanged + mtime changed + head hash matches → metadata-only (touch)', async () => {
        fsMock.safeStat.mockResolvedValue({
            mtimeMs: 5_000,
            mtime: new Date(5_000),
            size: 100, // same size
        } as unknown as Stats);
        fsMock.hashFileHead.mockResolvedValue('same-hash');
        const r = await detectFileChanges(STORED, '/touched.mkv');
        expect(r.status).toBe('metadata-only');
    });

    it('size changed + hash also changed → content-changed', async () => {
        fsMock.safeStat.mockResolvedValue({
            mtimeMs: 5_000,
            mtime: new Date(5_000),
            size: 200,
        } as unknown as Stats);
        fsMock.hashFileHead.mockResolvedValue('different-hash');
        const r = await detectFileChanges(STORED, '/replaced.mkv');
        expect(r.status).toBe('content-changed');
    });
});
