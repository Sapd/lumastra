// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestHandler } from './$types';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

const mockRecordProgressHeartbeat = vi.fn();
vi.mock('$lib/server/services/ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: () => ({
        recordProgressHeartbeat: (...a: unknown[]) => mockRecordProgressHeartbeat(...a),
    }),
}));

const { POST } = await import('./+server.js');

function makeEvent(query: string) {
    const url = new URL(`https://app.example/j/Sessions/Playing/Ping${query}`);
    return {
        request: new Request(url, { method: 'POST' }),
        url,
        params: {},
        locals: { user: { userId: 'uid-alice', username: 'alice' } },
    } as never;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('POST /j/Sessions/Playing/Ping', () => {
    it('keeps the named transcode alive as PAUSED, bound to the caller', async () => {
        const res = await POST!(makeEvent('?playSessionId=abc123'));
        expect(res.status).toBe(204);
        expect(mockRecordProgressHeartbeat).toHaveBeenCalledWith('abc123', 'PAUSED', 'alice');
    });

    it('accepts the PascalCase spelling', async () => {
        await POST!(makeEvent('?PlaySessionId=def456'));
        expect(mockRecordProgressHeartbeat).toHaveBeenCalledWith('def456', 'PAUSED', 'alice');
    });

    it('answers a plain 400 (not 422) without touching anything when the id is missing', async () => {
        for (const query of ['', '?playSessionId=', '?PlaySessionId=%20']) {
            const res = await POST!(makeEvent(query));
            expect(res.status, query).toBe(400);
        }
        expect(mockRecordProgressHeartbeat).not.toHaveBeenCalled();
    });

    it('answers 204 for an unknown id (the heartbeat ignores it)', async () => {
        const res = await POST!(makeEvent('?playSessionId=no-such-job'));
        expect(res.status).toBe(204);
    });
});
