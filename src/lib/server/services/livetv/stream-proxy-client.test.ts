// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$lib/server/config.js', () => ({
    config: { STREAM_PROXY_URL: 'http://proxy.test', STREAM_PROXY_SECRET: 'secret' },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { createStreamProxyClient } from './stream-proxy-client.js';

describe('StreamProxyClient rung paths', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('#EXTM3U')));
    });

    it('encodes channel, rung, and segment as individual path components', async () => {
        const client = createStreamProxyClient();
        await client.proxyHlsRungPlaylist('channel/../x', 'rung/../y');
        await client.proxyHlsRungSegment('channel/../x', 'rung/../y', 'segment-1.ts/../x');

        expect(fetch).toHaveBeenNthCalledWith(
            1,
            'http://proxy.test/streams/channel%2F..%2Fx/r/rung%2F..%2Fy/playlist.m3u8',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            'http://proxy.test/streams/channel%2F..%2Fx/r/rung%2F..%2Fy/segment-1.ts%2F..%2Fx',
            expect.objectContaining({ method: 'GET' }),
        );
    });

    it('encodes adaptive output paths as individual path components', async () => {
        const client = createStreamProxyClient();
        await client.proxyHlsAdaptiveMaster('channel/../x');
        await client.proxyHlsAdaptivePlaylist('channel/../x', 'output/../y');
        await client.proxyHlsAdaptiveSegment('channel/../x', 'output/../y', 'segment-1.ts/../x');

        expect(fetch).toHaveBeenNthCalledWith(
            1,
            'http://proxy.test/streams/channel%2F..%2Fx/a/master.m3u8',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(fetch).toHaveBeenNthCalledWith(
            2,
            'http://proxy.test/streams/channel%2F..%2Fx/a/output%2F..%2Fy/playlist.m3u8',
            expect.objectContaining({ method: 'GET' }),
        );
        expect(fetch).toHaveBeenNthCalledWith(
            3,
            'http://proxy.test/streams/channel%2F..%2Fx/a/output%2F..%2Fy/segment-1.ts%2F..%2Fx',
            expect.objectContaining({ method: 'GET' }),
        );
    });
});
