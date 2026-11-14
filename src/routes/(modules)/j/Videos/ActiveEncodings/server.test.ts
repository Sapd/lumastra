// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /j/Videos/ActiveEncodings — Jellyfin clients call it to cancel the
 * transcode behind a PlaySessionId. It had no route, so the job ran on until
 * the reaper caught it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestHandler } from './$types';

const authOptions = vi.hoisted(() => ({ value: undefined as unknown }));
vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler, opts: unknown) => {
        authOptions.value = opts;
        return handler;
    },
}));

const mockStopJobForUser = vi.fn();
vi.mock('$lib/server/services/ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: () => ({
        stopJobForUser: (...a: unknown[]) => mockStopJobForUser(...a),
    }),
}));

const { DELETE } = await import('./+server.js');

const SID = 'a8a1d0c2-5c1e-4f5b-9a57-6f0b8f3c2e11';

const ALICE = { userId: 'uid-alice', username: 'alice' };

function makeEvent(query: string, user: { userId: string; username: string } | null = ALICE) {
    const url = new URL(`https://app.example/j/Videos/ActiveEncodings${query}`);
    return {
        request: new Request(url, { method: 'DELETE' }),
        url,
        locals: { user },
        params: {},
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockStopJobForUser.mockResolvedValue(true);
});

describe('DELETE /j/Videos/ActiveEncodings', () => {
    it("stops the caller's transcode for the given PlaySessionId", async () => {
        const res = await DELETE!(makeEvent(`?DeviceId=tv-1&PlaySessionId=${SID}`));

        expect(res.status).toBe(204);
        expect(mockStopJobForUser).toHaveBeenCalledWith(SID, 'alice', 'client_stopped');
    });

    it('accepts camelCase parameter names', async () => {
        await DELETE!(makeEvent(`?deviceId=tv-1&playSessionId=${SID}`));

        expect(mockStopJobForUser).toHaveBeenCalledWith(SID, 'alice', 'client_stopped');
    });

    it('is a no-op without a PlaySessionId (DeviceId alone cannot name a /j job)', async () => {
        const res = await DELETE!(makeEvent('?DeviceId=tv-1'));

        expect(res.status).toBe(204);
        expect(mockStopJobForUser).not.toHaveBeenCalled();
    });

    it('ignores a PlaySessionId that is not a UUID', async () => {
        const res = await DELETE!(makeEvent('?PlaySessionId=preview-x'));

        expect(res.status).toBe(204);
        expect(mockStopJobForUser).not.toHaveBeenCalled();
    });

    it('needs a session login with write access (no PAT: it cancels a stream)', () => {
        expect(authOptions.value).toEqual({ pat: 'deny', mode: 'write' });
    });

    it('refuses a caller without a user', async () => {
        const res = await DELETE!(makeEvent(`?PlaySessionId=${SID}`, null));

        expect(res.status).toBe(401);
        expect(mockStopJobForUser).not.toHaveBeenCalled();
    });

    it('still answers 204 when stopping fails', async () => {
        mockStopJobForUser.mockRejectedValue(new Error('db down'));

        const res = await DELETE!(makeEvent(`?PlaySessionId=${SID}`));

        expect(res.status).toBe(204);
    });
});
