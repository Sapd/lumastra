// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type postgres from 'postgres';
import type { UserContext } from '$lib/server/types';

const {
    mockGetTrackStreamSource,
    mockCheckMediaAccess,
    mockResolveMediaPath,
    mockProbe,
    mockStat,
} = vi.hoisted(() => ({
    mockGetTrackStreamSource: vi.fn(),
    mockCheckMediaAccess: vi.fn(),
    mockResolveMediaPath: vi.fn(),
    mockProbe: vi.fn(),
    mockStat: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
    stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackStreamSource: (...args: unknown[]) => mockGetTrackStreamSource(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));
vi.mock('$lib/server/utils/media-path-resolver.js', () => ({
    resolveMediaPath: (...args: unknown[]) => mockResolveMediaPath(...args),
}));
vi.mock('$lib/server/services/music-transcode/index.js', () => ({
    probeAudioSource: (...args: unknown[]) => mockProbe(...args),
}));

import {
    resolveStreamSource,
    probeAudioSourceCached,
    clearStreamSourceCaches,
    STREAM_SOURCE_TTL_MS,
} from './stream-source.js';

const sql = {} as postgres.Sql;
const TRACK = 'track-1';

function user(userId: string): UserContext {
    return { userId, username: userId } as unknown as UserContext;
}

beforeEach(() => {
    clearStreamSourceCaches();
    mockGetTrackStreamSource.mockReset().mockResolvedValue({ id: TRACK, file_path: '/m/a.mp3' });
    mockCheckMediaAccess.mockReset().mockResolvedValue(true);
    mockResolveMediaPath.mockReset().mockResolvedValue({
        containerPath: '/data/m/a.mp3',
        isAccessible: true,
        fileSize: 1234,
    });
    mockProbe.mockReset().mockResolvedValue({ bitrate: 320_000 });
    mockStat.mockReset().mockResolvedValue({ size: 1234, mtimeMs: 1000 });
});

const OK = {
    kind: 'ok',
    trackId: TRACK,
    containerPath: '/data/m/a.mp3',
    fileSize: 1234,
    mtimeMs: 1000,
} as const;

afterEach(() => {
    vi.useRealTimers();
});

describe('resolveStreamSource', () => {
    it('carries the selected file duration through source caching', async () => {
        mockGetTrackStreamSource.mockResolvedValue({
            id: TRACK,
            file_path: '/m/a.mp3',
            duration_seconds: 600.125,
        });
        const source = await resolveStreamSource(sql, TRACK, user('u1'));
        expect(source).toEqual({ ...OK, durationSeconds: 600.125 });
        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual(source);
    });

    it('does the lookups once for a burst of requests from one user', async () => {
        const first = await resolveStreamSource(sql, TRACK, user('u1'));
        const second = await resolveStreamSource(sql, TRACK, user('u1'));

        expect(first).toEqual(OK);
        expect(second).toEqual(first);
        expect(mockGetTrackStreamSource).toHaveBeenCalledTimes(1);
        expect(mockCheckMediaAccess).toHaveBeenCalledTimes(1);
        expect(mockResolveMediaPath).toHaveBeenCalledTimes(1);
    });

    it('shares one lookup between concurrent requests of a burst', async () => {
        const results = await Promise.all([
            resolveStreamSource(sql, TRACK, user('u1')),
            resolveStreamSource(sql, TRACK, user('u1')),
            resolveStreamSource(sql, TRACK, user('u1')),
        ]);

        expect(results).toEqual([OK, OK, OK]);
        expect(mockGetTrackStreamSource).toHaveBeenCalledTimes(1);
        expect(mockCheckMediaAccess).toHaveBeenCalledTimes(1);
    });

    it('looks the file up again when it changed on disk within the TTL', async () => {
        await resolveStreamSource(sql, TRACK, user('u1'));
        // Replaced by a bigger file: the cached size would now be a lie in
        // Content-Length / Content-Range.
        mockStat.mockResolvedValue({ size: 5678, mtimeMs: 2000 });

        const again = await resolveStreamSource(sql, TRACK, user('u1'));

        expect(again).toEqual({ ...OK, fileSize: 5678, mtimeMs: 2000 });
        expect(mockResolveMediaPath).toHaveBeenCalledTimes(2);
    });

    it('treats a same-size replacement (new mtime) as changed too', async () => {
        await resolveStreamSource(sql, TRACK, user('u1'));
        mockStat.mockResolvedValue({ size: 1234, mtimeMs: 2000 });

        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({ ...OK, mtimeMs: 2000 });
        expect(mockResolveMediaPath).toHaveBeenCalledTimes(2);
    });

    it('reports a file that vanished between resolution and stat as unavailable', async () => {
        mockStat.mockRejectedValue(new Error('ENOENT'));
        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({
            kind: 'unavailable',
            reason: 'file vanished',
        });
    });

    it("never serves one user's access answer to another user", async () => {
        await resolveStreamSource(sql, TRACK, user('u1'));
        mockCheckMediaAccess.mockResolvedValue(false);

        const other = await resolveStreamSource(sql, TRACK, user('u2'));

        expect(other).toEqual({ kind: 'not_found', reason: 'access' });
        expect(mockCheckMediaAccess).toHaveBeenCalledTimes(2);
    });

    it('does not cache a denial, so a granted user is not locked out', async () => {
        mockCheckMediaAccess.mockResolvedValueOnce(false);
        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({
            kind: 'not_found',
            reason: 'access',
        });

        expect((await resolveStreamSource(sql, TRACK, user('u1'))).kind).toBe('ok');
    });

    it('re-checks access once the entry expires', async () => {
        vi.useFakeTimers();
        await resolveStreamSource(sql, TRACK, user('u1'));
        mockCheckMediaAccess.mockResolvedValue(false);

        vi.advanceTimersByTime(STREAM_SOURCE_TTL_MS + 1);

        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({
            kind: 'not_found',
            reason: 'access',
        });
    });

    it('reports a missing file path and an unreachable file without caching them', async () => {
        mockGetTrackStreamSource.mockResolvedValueOnce({ id: TRACK, file_path: null });
        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({
            kind: 'not_found',
            reason: 'no_file_path',
        });

        mockResolveMediaPath.mockResolvedValueOnce({ isAccessible: false, reason: 'missing' });
        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({
            kind: 'unavailable',
            reason: 'missing',
        });

        expect((await resolveStreamSource(sql, TRACK, user('u1'))).kind).toBe('ok');
    });

    it('returns not_found for an unknown track', async () => {
        mockGetTrackStreamSource.mockResolvedValue(null);
        expect(await resolveStreamSource(sql, TRACK, user('u1'))).toEqual({
            kind: 'not_found',
            reason: 'track',
        });
        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
    });
});

describe('probeAudioSourceCached', () => {
    it('probes a file once for concurrent and repeated requests', async () => {
        const [a, b] = await Promise.all([probeAudioSourceCached(OK), probeAudioSourceCached(OK)]);
        await probeAudioSourceCached(OK);

        expect(a).toEqual({ bitrate: 320_000 });
        expect(b).toBe(a);
        expect(mockProbe).toHaveBeenCalledTimes(1);
    });

    it('re-probes a file whose size or mtime changed', async () => {
        await probeAudioSourceCached(OK);
        await probeAudioSourceCached({ ...OK, fileSize: 9999 });
        await probeAudioSourceCached({ ...OK, mtimeMs: 2000 });
        expect(mockProbe).toHaveBeenCalledTimes(3);
    });

    it('drops a failed probe so the next request tries again', async () => {
        mockProbe.mockRejectedValueOnce(new Error('ffprobe died'));
        await expect(probeAudioSourceCached(OK)).rejects.toThrow('ffprobe died');

        await expect(probeAudioSourceCached(OK)).resolves.toEqual({
            bitrate: 320_000,
        });
        expect(mockProbe).toHaveBeenCalledTimes(2);
    });
});
