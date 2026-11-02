// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /playback/{itemId}/probe-status — the `?session=` encoder notice.
 *
 * The player polls this before its first heartbeat; with `?session=` the
 * answer also says whether that session's encoder is slow or switched to
 * software. Asserted at the HTTP seam: which identity reaches the owner
 * check, that a bad or foreign session yields nothing, and that a lookup
 * failure never turns the probe answer into an error.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetEncoderNotice = vi.fn();
const mockGetProbeProgressByItem = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: vi.fn() }));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId: vi.fn(async () => ({ internalId: 'item-1' })) },
}));
vi.mock('$lib/server/services/keyframe-probe-progress.service.js', () => ({
    getProbeProgressByItem: (...args: unknown[]) => mockGetProbeProgressByItem(...args),
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({
        getEncoderNotice: (...args: unknown[]) => mockGetEncoderNotice(...args),
    }),
}));

const { def } = await import('./probe-status.js');

const SESSION = '0d6c0f8e-7a4b-4c55-9a7e-2f1c3b4d5e6f';

function makeEvent(query = ''): RequestEvent {
    const url = `http://localhost/api/playback/item-1/probe-status${query}`;
    return {
        locals: { user: { userId: 'u1', username: 'alice' }, resolvedIds: undefined },
        url: new URL(url),
        params: { itemId: 'item-1' },
        request: new Request(url),
    } as unknown as RequestEvent;
}

const ctx = { surface: 'internal', input: { query: {} } } as never;

async function get(query = ''): Promise<Record<string, unknown>> {
    const res = await def.handlers.GET!(makeEvent(query), ctx);
    expect(res.status).toBe(200);
    return (await res.json()) as Record<string, unknown>;
}

describe('probe-status ?session= encoder notice', () => {
    beforeEach(() => {
        mockGetEncoderNotice.mockReset();
        mockGetProbeProgressByItem.mockReset().mockResolvedValue(null);
    });

    it("asks the owner check with the caller's own username and returns the notice", async () => {
        mockGetEncoderNotice.mockResolvedValue({ softwareFallbackFrom: 'hevc_nvenc' });
        expect(await get(`?session=${SESSION}`)).toEqual({
            probing: false,
            encoder: { softwareFallbackFrom: 'hevc_nvenc' },
        });
        expect(mockGetEncoderNotice).toHaveBeenCalledWith(SESSION, 'alice');
    });

    it('carries the notice on a probing answer too', async () => {
        mockGetProbeProgressByItem.mockResolvedValue({
            phase: 'probing',
            startedAt: 1,
            currentPts: 5,
            totalDuration: 0,
        });
        mockGetEncoderNotice.mockResolvedValue({ slowReason: 'gpu_busy' });
        const body = await get(`?session=${SESSION}`);
        expect(body.probing).toBe(true);
        expect(body.encoder).toEqual({ slowReason: 'gpu_busy' });
    });

    it('a foreign session (the owner check says no) yields the plain answer', async () => {
        mockGetEncoderNotice.mockResolvedValue(undefined);
        expect(await get(`?session=${SESSION}`)).toEqual({ probing: false });
    });

    it('an empty notice is not sent', async () => {
        mockGetEncoderNotice.mockResolvedValue({
            slowReason: undefined,
            softwareFallbackFrom: undefined,
        });
        expect(await get(`?session=${SESSION}`)).toEqual({ probing: false });
    });

    it('a malformed or missing session never reaches the lookup', async () => {
        expect(await get('?session=not-a-uuid')).toEqual({ probing: false });
        expect(await get()).toEqual({ probing: false });
        expect(mockGetEncoderNotice).not.toHaveBeenCalled();
    });

    it('a failing lookup degrades to the plain answer, never an error', async () => {
        mockGetEncoderNotice.mockRejectedValue(new Error('valkey down'));
        expect(await get(`?session=${SESSION}`)).toEqual({ probing: false });
    });
});
