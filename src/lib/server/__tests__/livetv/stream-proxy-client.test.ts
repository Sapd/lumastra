// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    createStreamProxyClient,
    type StreamProxyClient,
} from '$lib/server/services/livetv/stream-proxy-client.js';
import type { JoinRequest } from '../../../../shared/livetv-proxy-types.js';

// Mock config
vi.mock('$lib/server/config.js', () => ({
    config: {
        STREAM_PROXY_URL: 'http://proxy:3000',
        STREAM_PROXY_SECRET: 'test-secret',
    },
}));

// Mock logger
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

describe('StreamProxyClient', () => {
    let client: StreamProxyClient;
    let fetchSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        fetchSpy = vi.fn();
        global.fetch = fetchSpy as unknown as typeof fetch;
        client = createStreamProxyClient();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe('joinChannel', () => {
        const joinRequest: JoinRequest = {
            viewerId: 'user1',
            streamUrls: ['http://stream1.m3u8'],
            sourceId: 'source-1',
            maxStreams: 2,
            channelName: 'Test Channel',
        };

        it('returns JoinResponse on success', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true, channelId: 'ch1' }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

            const result = await client.joinChannel('ch1', joinRequest);
            expect(result).toEqual({ success: true, channelId: 'ch1' });

            expect(fetchSpy).toHaveBeenCalledWith(
                'http://proxy:3000/streams/ch1/join',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'X-Proxy-Secret': 'test-secret',
                        'Content-Type': 'application/json',
                    }),
                    body: JSON.stringify(joinRequest),
                }),
            );
        });

        it('returns StreamLimitResponse on 503', async () => {
            const limitResponse = {
                error: 'stream_limit_reached' as const,
                limit: 2,
                active: [
                    {
                        channelId: 'ch2',
                        channelName: 'Other Channel',
                        viewers: 1,
                    },
                ],
            };
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify(limitResponse), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

            const result = await client.joinChannel('ch1', joinRequest);
            expect(result).toEqual(limitResponse);
        });
    });

    describe('leaveChannel', () => {
        it('returns LeaveResponse on success', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

            const result = await client.leaveChannel('ch1', 'user1');
            expect(result).toEqual({ success: true });

            expect(fetchSpy).toHaveBeenCalledWith(
                'http://proxy:3000/streams/ch1/leave?viewerId=user1',
                expect.objectContaining({
                    method: 'DELETE',
                    headers: expect.objectContaining({
                        'X-Proxy-Secret': 'test-secret',
                    }),
                }),
            );
        });
    });

    describe('heartbeat', () => {
        it('returns HeartbeatResponse on success', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify({ success: true }), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

            const result = await client.heartbeat('ch1', 'user1');
            expect(result).toEqual({ success: true });

            expect(fetchSpy).toHaveBeenCalledWith(
                'http://proxy:3000/streams/ch1/heartbeat?viewerId=user1',
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        'X-Proxy-Secret': 'test-secret',
                    }),
                }),
            );
        });
    });

    describe('getProxyStatus', () => {
        it('returns ProxyStatus', async () => {
            const status = {
                healthy: true,
                uptime: 120,
                activeChannels: 2,
                totalViewers: 5,
                ffmpegAvailable: true,
                channels: [],
                perSourceLimits: [],
            };
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify(status), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

            const result = await client.getProxyStatus();
            expect(result).toEqual(status);
        });
    });

    describe('X-Proxy-Secret header', () => {
        it('includes header on all requests', async () => {
            fetchSpy.mockImplementation(() =>
                Promise.resolve(
                    new Response(JSON.stringify({ success: true }), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' },
                    }),
                ),
            );

            await client.heartbeat('ch1', 'user1');
            await client.leaveChannel('ch1', 'user1');
            await client.getProxyStatus();

            for (const call of fetchSpy.mock.calls) {
                expect(call[1].headers['X-Proxy-Secret']).toBe('test-secret');
            }
        });
    });

    describe('network error handling', () => {
        it('throws descriptive error on network failure', async () => {
            fetchSpy.mockRejectedValueOnce(new Error('ECONNREFUSED'));

            await expect(client.heartbeat('ch1', 'user1')).rejects.toThrow(
                /stream proxy.*ECONNREFUSED/i,
            );
        });

        it('throws descriptive error on non-JSON 502 response', async () => {
            fetchSpy.mockResolvedValueOnce(
                new Response('<html>502 Bad Gateway</html>', {
                    status: 502,
                    headers: { 'Content-Type': 'text/html' },
                }),
            );

            await expect(client.heartbeat('ch1', 'user1')).rejects.toThrow(
                /stream proxy returned 502/i,
            );
        });

        it('still parses JSON from 503 stream_limit_reached', async () => {
            const limitResponse = {
                error: 'stream_limit_reached' as const,
                limit: 2,
                active: [{ channelId: 'ch2', channelName: 'Other', viewers: 1 }],
            };
            fetchSpy.mockResolvedValueOnce(
                new Response(JSON.stringify(limitResponse), {
                    status: 503,
                    headers: { 'Content-Type': 'application/json' },
                }),
            );

            const result = await client.joinChannel('ch1', {
                viewerId: 'u1',
                streamUrls: ['http://test'],
                sourceId: 's1',
                maxStreams: 1,
                channelName: 'test',
            });
            expect(result).toEqual(limitResponse);
        });
    });

    describe('missing configuration', () => {
        it('throws when STREAM_PROXY_URL is empty', async () => {
            // Re-mock config with empty URL
            const configModule = await import('$lib/server/config.js');
            const originalUrl = configModule.config.STREAM_PROXY_URL;
            (configModule.config as unknown as Record<string, string>).STREAM_PROXY_URL = '';

            const emptyClient = createStreamProxyClient();
            await expect(
                emptyClient.joinChannel('ch1', {
                    viewerId: 'u1',
                    streamUrls: ['http://test'],
                    sourceId: 's1',
                    maxStreams: 1,
                    channelName: 'test',
                }),
            ).rejects.toThrow(/STREAM_PROXY_URL/);

            (configModule.config as unknown as Record<string, string>).STREAM_PROXY_URL =
                originalUrl;
        });
    });

    describe('HLS proxy methods', () => {
        it('proxyHlsPlaylist returns raw Response', async () => {
            const mockResponse = new Response('#EXTM3U\n#EXTINF:4.000,\nsegment-0.ts\n', {
                status: 200,
                headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
            });
            fetchSpy.mockResolvedValueOnce(mockResponse);

            const result = await client.proxyHlsPlaylist('ch1');
            expect(result).toBeInstanceOf(Response);
            expect(result.status).toBe(200);

            expect(fetchSpy).toHaveBeenCalledWith(
                'http://proxy:3000/streams/ch1/master.m3u8',
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({
                        'X-Proxy-Secret': 'test-secret',
                    }),
                }),
            );
        });

        it('proxyHlsSegment returns raw Response', async () => {
            const mockResponse = new Response(Buffer.from('ts-data'), {
                status: 200,
                headers: { 'Content-Type': 'video/mp2t' },
            });
            fetchSpy.mockResolvedValueOnce(mockResponse);

            const result = await client.proxyHlsSegment('ch1', 'segment-0.ts');
            expect(result).toBeInstanceOf(Response);

            expect(fetchSpy).toHaveBeenCalledWith(
                'http://proxy:3000/streams/ch1/segment-0.ts',
                expect.objectContaining({
                    method: 'GET',
                    headers: expect.objectContaining({
                        'X-Proxy-Secret': 'test-secret',
                    }),
                }),
            );
        });
    });
});
