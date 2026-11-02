// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DisabledLiveTvProvider } from './disabled-livetv-provider.js';
import { StandaloneLiveTvProvider } from './standalone-livetv-provider.js';

const { mockConfig, mockLogger } = vi.hoisted(() => ({
    mockConfig: {
        LIVETV_SOURCE: 'disabled' as 'standalone' | 'disabled',
        STREAM_PROXY_URL: 'http://localhost:3001',
    },
    mockLogger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    },
}));

vi.mock('$lib/server/config.js', () => ({
    config: mockConfig,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => mockLogger,
    },
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => vi.fn(),
}));

vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    getAllVisibleChannels: vi.fn().mockResolvedValue([]),
    getChannelWithSource: vi.fn().mockResolvedValue(null),
    getBackupGroupUrls: vi.fn().mockResolvedValue([]),
}));

vi.mock('./stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({
        joinChannel: vi.fn().mockResolvedValue({ success: true, channelId: 'test' }),
        leaveChannel: vi.fn().mockResolvedValue({ success: true }),
        heartbeat: vi.fn().mockResolvedValue({ success: true }),
        getProxyStatus: vi.fn().mockResolvedValue({ healthy: true }),
        proxyHlsPlaylist: vi.fn().mockResolvedValue(new Response('')),
        proxyHlsSegment: vi.fn().mockResolvedValue(new Response('')),
    }),
}));

describe('getLiveTvProvider', () => {
    beforeEach(async () => {
        // Reset singleton between tests
        const { resetLiveTvProvider } = await import('./index.js');
        resetLiveTvProvider();
        mockConfig.LIVETV_SOURCE = 'disabled';
    });

    it('returns DisabledLiveTvProvider when source is disabled', async () => {
        const { getLiveTvProvider } = await import('./index.js');
        const provider = await getLiveTvProvider();
        expect(provider).toBeInstanceOf(DisabledLiveTvProvider);
    });

    it('returns the same instance on subsequent calls (singleton)', async () => {
        const { getLiveTvProvider } = await import('./index.js');
        const first = await getLiveTvProvider();
        const second = await getLiveTvProvider();
        expect(first).toBe(second);
    });

    it('returns StandaloneLiveTvProvider when source is standalone', async () => {
        mockConfig.LIVETV_SOURCE = 'standalone';
        const { getLiveTvProvider, resetLiveTvProvider } = await import('./index.js');
        resetLiveTvProvider();
        const provider = await getLiveTvProvider();
        expect(provider).toBeInstanceOf(StandaloneLiveTvProvider);
    });

    it('logs a warning and falls back to disabled for unknown LIVETV_SOURCE values', async () => {
        // @ts-expect-error — testing invalid config value
        mockConfig.LIVETV_SOURCE = 'custom';
        const { getLiveTvProvider, resetLiveTvProvider } = await import('./index.js');
        resetLiveTvProvider();
        const provider = await getLiveTvProvider();
        expect(provider).toBeInstanceOf(DisabledLiveTvProvider);
        expect(mockLogger.warn).toHaveBeenCalledWith(
            expect.stringContaining('Invalid LIVETV_SOURCE value: "custom"'),
        );
    });

    it('resets singleton correctly', async () => {
        const { getLiveTvProvider, resetLiveTvProvider } = await import('./index.js');
        const first = await getLiveTvProvider();
        resetLiveTvProvider();
        const second = await getLiveTvProvider();
        // Both are DisabledLiveTvProvider, but different instances
        expect(first).not.toBe(second);
    });
});

describe('DisabledLiveTvProvider', () => {
    const provider = new DisabledLiveTvProvider();

    it('getChannels returns empty array', async () => {
        expect(await provider.getChannels()).toEqual([]);
    });

    it('getChannel returns undefined', async () => {
        expect(await provider.getChannel('any-id')).toBeUndefined();
    });

    it('getCurrentProgram returns undefined', async () => {
        expect(await provider.getCurrentProgram('any-id')).toBeUndefined();
    });

    it('getPrograms returns empty array', async () => {
        expect(await provider.getPrograms('any-id', new Date(), new Date())).toEqual([]);
    });

    it('searchPrograms returns empty array', async () => {
        expect(await provider.searchPrograms('query')).toEqual([]);
    });

    it('getStreamInfo throws error (streaming not available when disabled)', async () => {
        await expect(provider.getStreamInfo('channel-id', 'viewer-id')).rejects.toThrow(
            'LiveTV is disabled',
        );
    });

    it('getCategories returns empty array', async () => {
        expect(await provider.getCategories()).toEqual([]);
    });
});
