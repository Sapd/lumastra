// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the keyframe-probe-progress error channel.
 *
 * The service is a thin wrapper around Valkey set/get/del — we mock the cache
 * layer so we can exercise the serialisation and roundtrip behaviour without a
 * real Valkey instance. The progress/clear paths already ship in production,
 * so these tests focus on the new error-phase additions.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheStore = new Map<string, string>();

vi.mock('$lib/server/cache/valkey.js', () => ({
    cacheGet: vi.fn(async (key: string): Promise<string | null> => {
        return cacheStore.get(key) ?? null;
    }),
    cacheDel: vi.fn(async (key: string | string[]): Promise<number> => {
        const keys = Array.isArray(key) ? key : [key];
        let removed = 0;
        for (const k of keys) {
            if (cacheStore.delete(k)) removed++;
        }
        return removed;
    }),
    setEx: vi.fn(async (key: string, _ttl: number, value: string): Promise<string> => {
        cacheStore.set(key, value);
        return 'OK';
    }),
}));

import {
    setProbeError,
    setProbeProgress,
    clearProbeProgress,
    getProbeProgressByFile,
    getProbeProgressByItem,
} from './keyframe-probe-progress.service.js';

beforeEach(() => {
    cacheStore.clear();
    vi.clearAllMocks();
});

describe('setProbeError → getProbeProgressBy*', () => {
    it('writes phase="error" with code and message under both file and item keys', async () => {
        await setProbeError({
            fileId: 'file-abc',
            itemId: 'item-xyz',
            code: 'ffmpeg_exit',
            message: "Undefined constant or missing '(' in 'bt2390'",
        });

        const byFile = await getProbeProgressByFile('file-abc');
        const byItem = await getProbeProgressByItem('item-xyz');

        expect(byFile).not.toBeNull();
        expect(byItem).not.toBeNull();
        expect(byFile?.phase).toBe('error');
        expect(byItem?.phase).toBe('error');
        expect(byFile?.errorCode).toBe('ffmpeg_exit');
        expect(byFile?.errorMessage).toContain('bt2390');
        expect(byItem?.errorMessage).toContain('bt2390');
        expect(byFile?.fileId).toBe('file-abc');
        expect(byFile?.itemId).toBe('item-xyz');
        expect(typeof byFile?.startedAt).toBe('number');
        expect(byFile?.startedAt).toBeGreaterThan(0);
    });

    it('leaves error-phase entries intact when clearProbeProgress runs after', async () => {
        // Race window: FFmpeg crashes → publishProbeError SETs the error key,
        // then the playback service's waitForHlsPlaylist timeout fires and
        // calls clearStartupProgress → clearProbeProgress. The clear MUST
        // NOT wipe the freshly written error payload, otherwise the player
        // overlay sees nothing and falls back to the spinner-then-404 path.
        await setProbeError({
            fileId: 'race-file',
            itemId: 'race-item',
            code: 'ffmpeg_exit',
            message: 'boom',
        });

        await clearProbeProgress('race-file', 'race-item');

        const byFile = await getProbeProgressByFile('race-file');
        const byItem = await getProbeProgressByItem('race-item');
        expect(byFile?.phase).toBe('error');
        expect(byItem?.phase).toBe('error');
        expect(byFile?.errorMessage).toBe('boom');
    });

    it('still deletes non-error (progress) entries on clearProbeProgress', async () => {
        await setProbeProgress({
            fileId: 'progress-file',
            itemId: 'progress-item',
            phase: 'starting',
            startedAt: Date.now(),
            currentPts: 0,
            totalDuration: 0,
            progress: 0,
        });

        await clearProbeProgress('progress-file', 'progress-item');

        expect(await getProbeProgressByFile('progress-file')).toBeNull();
        expect(await getProbeProgressByItem('progress-item')).toBeNull();
    });

    it('uses a shorter TTL for error entries than for progress entries', async () => {
        const { setEx } = await import('$lib/server/cache/valkey.js');

        await setProbeError({
            fileId: 'file-ttl',
            itemId: 'item-ttl',
            code: 'ffmpeg_spawn',
            message: 'spawn ffmpeg ENOENT',
        });

        // setEx is called (fileKey, ttl, payload). All calls should use the
        // same error TTL, which must be noticeably shorter than the 600s
        // progress TTL so the error auto-clears before retries become stale.
        const calls = vi.mocked(setEx).mock.calls;
        expect(calls.length).toBe(2);
        for (const call of calls) {
            const ttl = call[1];
            expect(ttl).toBeGreaterThan(0);
            expect(ttl).toBeLessThan(600);
        }
    });
});
