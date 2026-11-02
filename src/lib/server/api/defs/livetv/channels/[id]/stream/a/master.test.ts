// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ record: vi.fn(), join: vi.fn() }));
vi.mock('$lib/server/config.js', () => ({
    config: { LIVETV_ADAPTIVE_LADDER_ENABLED: true, LIVETV_ADAPTIVE_INCLUDE_ORIGINAL: false },
}));
vi.mock('$lib/server/services/livetv/livetv-cap-policy.js', () => ({
    getLiveTvCapFallback: () => 'source',
}));
vi.mock('../stream-helpers.js', () => ({
    joinWithEviction: mocks.join,
    proxyErrorResponse: vi.fn(),
}));
vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => ({
        checkKicked: async () => ({ kicked: false }),
        registerSession: vi.fn(),
    }),
}));
vi.mock('$lib/server/services/adaptive-playback-state.service.js', () => ({
    recordAdaptiveLadder: mocks.record,
}));
vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({
        proxyHlsAdaptiveMaster: async () => new Response('#EXTM3U\n720p4m/playlist.m3u8'),
    }),
}));
import { def } from './master.m3u8.js';
it('converts the public Bps ladder to the internal adaptive display record', async () => {
    mocks.join.mockResolvedValue({
        sourceId: 'source',
        adaptive: {
            rungs: [{ id: '720p4m', height: 720, maxBitrateBps: 4000000, codec: 'h264' }],
            includesOriginal: false,
        },
    });
    const url = new URL('http://localhost/stream?PlaySessionId=session');
    const response = await def.handlers.GET!(
        {
            params: { id: '00000000-0000-4000-8000-000000000001' },
            locals: {
                user: { username: 'alice', hasLiveTvPermission: true, liveTvPriority: 'low' },
                liveTvCredentialId: 'device:a',
            },
            url,
            request: new Request(url),
        } as never,
        { surface: 'v1' } as never,
    );
    expect(response.status).toBe(200);
    expect(mocks.record).toHaveBeenCalledWith('00000000-0000-4000-8000-000000000001', {
        rungs: [{ id: '720p4m', height: 720, maxBitrate: 4000000, codec: 'h264' }],
        includesOriginal: false,
    });
});
