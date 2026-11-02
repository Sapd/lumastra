// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { expect, it, vi } from 'vitest';
import type { RequestHandler } from './$types';

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));
vi.mock('$lib/server/services/database.service', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-notice', () => ({
    isStreamLimitNoticeReport: async () => false,
}));
vi.mock('$lib/server/database/queries/media-type-cache.queries', () => ({
    getMediaType: async () => 'movie',
}));
vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: async () => null,
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/multi-part', () => ({
    moviePositionMs: async (_db: unknown, _id: unknown, _owner: unknown, position: number) =>
        position,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: async () => true }));
vi.mock('$lib/server/utils/client-ip', () => ({ getClientIpStrict: () => '127.0.0.1' }));
vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    renewPlayTokenBySession: async () => {},
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/silent-start', () => ({
    disarmSilentStart: async () => {},
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service', () => ({
    getFFmpegTranscodeService: () => ({ recordProgressHeartbeat: vi.fn() }),
}));

const mocks = vi.hoisted(() => ({ parse: vi.fn(), update: vi.fn().mockResolvedValue({}) }));
vi.mock('$lib/server/proprietary/jellyfin-compat/playback-utils', () => ({
    parsePlaybackBody: mocks.parse,
    findOrCreateJellyfinSession: async () => ({ id: 'one-session' }),
    enforceFreemiumStreamLimit: async () => false,
    isPolicyError: () => false,
}));
vi.mock('$lib/server/services/play-session-lifecycle.service', () => ({
    getPlaySessionLifecycleService: () => ({ update: mocks.update }),
}));

it('orders overlapping progress by request entry even when the older request resolves last', async () => {
    const { POST } = await import('./+server.js');
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
        release = resolve;
    });
    const body = (positionMs: number) => ({
        itemId: '11111111-1111-4111-a111-111111111111',
        positionMs,
        isPaused: false,
    });
    mocks.parse.mockImplementationOnce(async () => {
        await blocked;
        return body(1000);
    });
    mocks.parse.mockResolvedValueOnce(body(2000));
    const request = {
        request: new Request('http://localhost/j/Sessions/Playing/Progress'),
        locals: { user: { username: 'alice', userId: 'alice-id' } },
    } as never;
    const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
    try {
        const older = POST!(request);
        now.mockReturnValue(2000);
        expect((await POST!(request)).status).toBe(204);
        now.mockReturnValue(3000);
        release();
        expect((await older).status).toBe(204);
        const updates = mocks.update.mock.calls.map(
            (call) => call[1] as { position_ms: number; event_seq: number },
        );
        expect(updates.map((update) => update.position_ms)).toEqual([2000, 1000]);
        expect(updates[1].event_seq).toBeLessThan(updates[0].event_seq);
    } finally {
        release();
        now.mockRestore();
    }
});
