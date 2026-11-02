// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ feeds: vi.fn(), failures: vi.fn(), proxy: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/config.js', () => ({ config: { STREAM_PROXY_URL: 'configured' } }));
vi.mock('$lib/server/database/queries/livetv-availability.queries.js', () => ({
    getLiveTvFeedEvidence: mocks.feeds,
    getLiveTvPlaybackEvidence: mocks.failures,
}));
vi.mock('./stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({ getProxyStatus: mocks.proxy }),
}));
import { getLiveTvAvailability, resetLiveTvAvailabilityCache } from './availability.service.js';
const channels = [{ images: {}, id: 'a', name: 'A', sourceId: 's', isVisible: true, sortOrder: 1 }];
beforeEach(() => {
    resetLiveTvAvailabilityCache();
    mocks.feeds.mockResolvedValue([]);
    mocks.failures.mockResolvedValue([]);
    mocks.proxy.mockResolvedValue({ ffmpegAvailable: true, channels: [] });
});
afterEach(() => vi.useRealTimers());
describe('bounded shared Live TV evidence reader', () => {
    it('deduplicates concurrent reads and caches cheaply without probing channels', async () => {
        await Promise.all([getLiveTvAvailability(channels), getLiveTvAvailability(channels)]);
        await getLiveTvAvailability(channels);
        expect(mocks.feeds).toHaveBeenCalledOnce();
        expect(mocks.proxy).toHaveBeenCalledOnce();
    });
    it('times out stalled reads as unknown within 2.5 seconds', async () => {
        vi.useFakeTimers();
        mocks.feeds.mockReturnValue(new Promise(() => {}));
        const pending = getLiveTvAvailability(channels);
        await vi.advanceTimersByTimeAsync(2500);
        expect((await pending).evidenceUnavailable).toBe(true);
    });
    it('proxy failure reports local playback trouble without blaming the TV provider', async () => {
        vi.useFakeTimers();
        mocks.proxy.mockRejectedValue(new Error('proxy unavailable'));
        await getLiveTvAvailability(channels);
        await vi.advanceTimersByTimeAsync(30_000);
        const result = await getLiveTvAvailability(channels);
        expect(result.sources[0].playback).toBe('service');
        expect(result.sources[0].channelFeed.state).toBe('unknown');
        expect(result.suppressedChannelIds).toEqual(['a']);
    });
    it('a single failed proxy probe (restart, slow reply) neither blames the service nor hides channels', async () => {
        vi.useFakeTimers();
        mocks.proxy.mockRejectedValueOnce(new Error('proxy restarting'));
        const blip = await getLiveTvAvailability(channels);
        expect(blip.sources[0].playback).toBe('unknown');
        expect(blip.suppressedChannelIds).toEqual([]);
        await vi.advanceTimersByTimeAsync(15_000);
        mocks.proxy.mockRejectedValueOnce(new Error('proxy restarting'));
        expect((await getLiveTvAvailability(channels)).suppressedChannelIds).toEqual([]);
        // A success in between restarts the grace period.
        await vi.advanceTimersByTimeAsync(15_000);
        await getLiveTvAvailability(channels);
        await vi.advanceTimersByTimeAsync(15_000);
        mocks.proxy.mockRejectedValueOnce(new Error('proxy restarting'));
        expect((await getLiveTvAvailability(channels)).suppressedChannelIds).toEqual([]);
    });
    it('buffer counts and successful joins are not recovery evidence', async () => {
        mocks.failures.mockResolvedValue([
            {
                channel_id: 'a',
                occurred_at: new Date(),
                source: 'ingest',
                outcome: 'crashed',
                stderr_tail: 'Connection refused',
            },
        ]);
        mocks.proxy.mockResolvedValue({
            ffmpegAvailable: true,
            channels: [{ channelId: 'a', segmentCount: 100 }],
        });
        expect((await getLiveTvAvailability(channels)).channels.a).toBe('upstream');
    });
    it('retains recovery after the active channel disappears, without claiming stale health', async () => {
        vi.useFakeTimers();
        const now = Date.now();
        mocks.failures.mockResolvedValue([
            {
                channel_id: 'a',
                occurred_at: new Date(now - 1000),
                source: 'ingest',
                outcome: 'crashed',
                stderr_tail: 'Connection refused',
            },
        ]);
        mocks.proxy.mockResolvedValue({
            ffmpegAvailable: true,
            channels: [{ channelId: 'a', lastSegmentAt: new Date(now).toISOString() }],
        });
        expect((await getLiveTvAvailability(channels)).channels.a).toBe('healthy');
        mocks.proxy.mockResolvedValue({ ffmpegAvailable: true, channels: [] });
        await vi.advanceTimersByTimeAsync(60_000);
        const result = await getLiveTvAvailability(channels);
        expect(result.channels.a).toBe('unknown');
        expect(result.suppressedChannelIds).toEqual([]);
        mocks.failures.mockResolvedValue([
            {
                channel_id: 'a',
                occurred_at: new Date(Date.now()),
                source: 'ingest',
                outcome: 'crashed',
                stderr_tail: 'Connection refused',
            },
        ]);
        await vi.advanceTimersByTimeAsync(15_000);
        expect((await getLiveTvAvailability(channels)).channels.a).toBe('upstream');
    });
    it('keeps fresh outages and promotion suppression when evidence reads fail', async () => {
        vi.useFakeTimers();
        mocks.failures.mockResolvedValue([
            {
                channel_id: 'a',
                occurred_at: new Date(),
                source: 'ingest',
                outcome: 'crashed',
                stderr_tail: 'Connection refused',
            },
        ]);
        await getLiveTvAvailability(channels);
        mocks.feeds.mockRejectedValue(new Error('database offline'));
        mocks.failures.mockRejectedValue(new Error('database offline'));
        await vi.advanceTimersByTimeAsync(15_000);
        const result = await getLiveTvAvailability(channels);
        expect(result.evidenceUnavailable).toBe(true);
        expect(result.suppressedChannelIds).toEqual(['a']);
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000);
        expect((await getLiveTvAvailability(channels)).suppressedChannelIds).toEqual([]);
    });
    it('retains prior evidence during the overall timeout', async () => {
        vi.useFakeTimers();
        mocks.failures.mockResolvedValue([
            {
                channel_id: 'a',
                occurred_at: new Date(),
                source: 'ingest',
                outcome: 'crashed',
                stderr_tail: 'Connection refused',
            },
        ]);
        await getLiveTvAvailability(channels);
        mocks.feeds.mockReturnValue(new Promise(() => {}));
        await vi.advanceTimersByTimeAsync(15_000);
        const pending = getLiveTvAvailability(channels);
        await vi.advanceTimersByTimeAsync(2500);
        expect((await pending).suppressedChannelIds).toEqual(['a']);
    });
});
