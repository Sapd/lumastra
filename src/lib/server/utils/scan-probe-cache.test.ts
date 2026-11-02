// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
    clearScanProbeCache,
    peekScanProbe,
    rememberScanProbe,
    takeScanProbe,
} from './scan-probe-cache.js';
import type { MediaProbeResult } from './ffprobe.js';

const PATH = '/library/Show/S01E01.mkv';
const MTIME = new Date(1_000_000);
const SIZE = 4096;

function okProbe(): MediaProbeResult {
    return {
        success: true,
        video: null,
        audioStreams: [],
        subtitleStreams: [],
        duration: 1320,
        container: 'matroska,webm',
        fileSize: SIZE,
        formatBitrate: null,
        chapters: [{ index: 0, title: 'Intro', startTimeMs: 0, endTimeMs: 90000 }],
    };
}

beforeEach(() => {
    clearScanProbeCache();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('peekScanProbe', () => {
    it('returns the remembered probe for a matching stat and leaves it for Phase A', () => {
        const probe = okProbe();
        rememberScanProbe(PATH, { mtime: MTIME, size: SIZE }, probe);

        expect(peekScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBe(probe);
        // Non-consuming: a second peek and the Phase A take both still get it.
        expect(peekScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBe(probe);
        expect(takeScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBe(probe);
        expect(takeScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBeNull();
    });

    it('misses when the size or mtime differs, and keeps the entry for the right stat', () => {
        const probe = okProbe();
        rememberScanProbe(PATH, { mtime: MTIME, size: SIZE }, probe);

        expect(peekScanProbe(PATH, { mtime: MTIME, size: SIZE + 1 })).toBeNull();
        expect(peekScanProbe(PATH, { mtime: new Date(2_000_000), size: SIZE })).toBeNull();
        expect(peekScanProbe(PATH, { mtime: null, size: SIZE })).toBeNull();
        expect(peekScanProbe(PATH, { mtime: MTIME, size: null })).toBeNull();
        expect(peekScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBe(probe);
    });

    it('misses for a path that was never remembered', () => {
        expect(peekScanProbe('/library/other.mkv', { mtime: MTIME, size: SIZE })).toBeNull();
    });

    it('misses once the entry is past its TTL', () => {
        vi.useFakeTimers();
        vi.setSystemTime(0);
        rememberScanProbe(PATH, { mtime: MTIME, size: SIZE }, okProbe());

        vi.setSystemTime(31 * 60 * 1000);

        expect(peekScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBeNull();
    });

    it('never holds a failed probe', () => {
        rememberScanProbe(
            PATH,
            { mtime: MTIME, size: SIZE },
            {
                ...okProbe(),
                success: false,
            },
        );

        expect(peekScanProbe(PATH, { mtime: MTIME, size: SIZE })).toBeNull();
    });
});
