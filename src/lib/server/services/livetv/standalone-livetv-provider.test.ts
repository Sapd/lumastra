// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { channelImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    CapUnavailableError,
    LiveTvFailureError,
    StandaloneLiveTvProvider,
    StreamFailureError,
    StreamLimitError,
} from './standalone-livetv-provider.js';

const mockConfig = vi.hoisted(() => ({
    LIVETV_ALLOW_PRIVATE_URLS: false,
    LIVETV_HIDE_QUALITY_TAGS: false,
}));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));

// Mock database connection
const mockSql = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockSql,
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

// Mock channel queries
const mockGetAllVisibleChannels = vi.fn();
const mockGetChannelWithSource = vi.fn();
const mockGetBackupGroupFeeds = vi.fn();
const mockSearchChannels = vi.fn();

vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    getAllVisibleChannels: (...args: unknown[]) => mockGetAllVisibleChannels(...args),
    getChannelWithSource: (...args: unknown[]) => mockGetChannelWithSource(...args),
    getBackupGroupFeeds: (...args: unknown[]) => mockGetBackupGroupFeeds(...args),
    searchChannels: (...args: unknown[]) => mockSearchChannels(...args),
}));

// Mock program queries
const mockGetCurrentProgram = vi.fn();
const mockGetCurrentProgramsForAllChannels = vi.fn().mockResolvedValue([]);
const mockSearchProgramsByText = vi.fn();
const mockGetGuidePrograms = vi.fn();
const mockSearchProgramAirings = vi.fn();
const mockGetVisibleCategories = vi.fn();
vi.mock('$lib/server/database/queries/livetv-programs.queries.js', () => ({
    getCurrentProgram: (...args: unknown[]) => mockGetCurrentProgram(...args),
    getCurrentProgramsForAllChannels: (...args: unknown[]) =>
        mockGetCurrentProgramsForAllChannels(...args),
    getProgramsByDateRange: vi.fn().mockResolvedValue([]),
    getGuidePrograms: (...args: unknown[]) => mockGetGuidePrograms(...args),
    searchProgramsByText: (...args: unknown[]) => mockSearchProgramsByText(...args),
    searchProgramAirings: (...args: unknown[]) => mockSearchProgramAirings(...args),
    getVisibleCategories: (...args: unknown[]) => mockGetVisibleCategories(...args),
}));

// Mock stream proxy client
const mockJoinChannel = vi.fn();
const mockLeaveChannel = vi.fn().mockResolvedValue({ success: true });
vi.mock('./stream-proxy-client.js', () => ({
    getStreamProxyClient: () => ({
        joinChannel: mockJoinChannel,
        leaveChannel: mockLeaveChannel,
    }),
}));

// Mock the SSRF URL validator. getStreamInfo now runs every stream URL through
// validateUrl before joining; in-process tests use example.com hostnames that
// don't resolve, so a passthrough mock lets the join-path assertions run while
// the SSRF guard itself is covered by url-validator's own unit tests.
const mockValidateUrl = vi.fn();
vi.mock('$lib/server/utils/url-validator.js', () => ({
    validateUrl: (...args: unknown[]) => mockValidateUrl(...args),
}));

const mockRecordStartSuccess = vi.fn().mockResolvedValue(undefined);
vi.mock('./channel-health.service.js', () => ({
    recordStartFailure: vi.fn().mockResolvedValue(undefined),
    recordStartSuccess: (...args: unknown[]) => mockRecordStartSuccess(...args),
}));

describe('StandaloneLiveTvProvider', () => {
    let provider: StandaloneLiveTvProvider;

    const sampleChannelRow = {
        id: 'ch-1',
        name: 'Test Channel',
        stream_url: 'http://stream.example.com/ch1.m3u8',
        logo_url: 'http://logo.example.com/ch1.png',
        quality_tier: 'hd',
        epg_channel_id: 'epg-1',
        sort_order: 1,
        is_visible: true,
        category_id: 'cat-1',
        category_name: 'Sports',
        backup_group_id: null,
        source_id: 'src-1',
        country_code: 'de',
        consecutive_absences: 0,
        created_at: new Date(),
    };

    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.LIVETV_ALLOW_PRIVATE_URLS = false;
        mockConfig.LIVETV_HIDE_QUALITY_TAGS = false;
        // Default: SSRF guard passes every URL so the join-path assertions run.
        mockValidateUrl.mockResolvedValue({ valid: true });
        provider = new StandaloneLiveTvProvider();
    });

    describe('getChannels', () => {
        it('returns transformed channels from database', async () => {
            mockGetAllVisibleChannels.mockResolvedValueOnce([sampleChannelRow]);

            const channels = await provider.getChannels();

            expect(channels).toHaveLength(1);
            expect(channels[0]).toEqual({
                id: 'ch-1',
                name: 'Test Channel',
                images: channelImageSet('internal', 'ch-1', sampleChannelRow.logo_url),
                category: 'Sports',
                categoryId: 'cat-1',
                sortOrder: 1,
                isVisible: true,
                qualityTier: 'hd',
                currentProgram: undefined,
                backupGroupId: undefined,
                sourceId: 'src-1',
            });
        });

        it('caches channels for 30s', async () => {
            mockGetAllVisibleChannels.mockResolvedValueOnce([sampleChannelRow]);

            await provider.getChannels();
            await provider.getChannels();

            expect(mockGetAllVisibleChannels).toHaveBeenCalledTimes(1);
        });
    });

    describe('getStreamInfo', () => {
        const channelWithSource = {
            ...sampleChannelRow,
            max_streams: 2,
            source_name: 'Test Source',
        };

        it('calls proxy join with correct JoinRequest', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
            });

            const result = await provider.getStreamInfo('ch-1', 'user1');

            expect(mockJoinChannel).toHaveBeenCalledWith('ch-1', {
                viewerId: 'user1',
                streamUrls: ['http://stream.example.com/ch1.m3u8'],
                feedIds: ['ch-1'],
                allowPrivateUrls: false,
                sourceId: 'src-1',
                maxStreams: 2,
                channelName: 'Test Channel',
            });

            expect(result).toEqual({
                streamUrl: '/api/livetv/channels/ch-1/stream/master.m3u8',
                requiresProxy: true,
                sourceId: 'src-1',
                maxStreams: 2,
                rungId: null,
                requestedMaxBitrateBps: null,
                appliedMaxBitrateBps: null,
                appliedMaxHeight: null,
                reason: null,
            });
        });

        it('forwards the private URL opt-in to the authenticated proxy join', async () => {
            mockConfig.LIVETV_ALLOW_PRIVATE_URLS = true;
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
            });

            await provider.getStreamInfo('ch-1', 'user1');

            expect(mockValidateUrl).toHaveBeenCalledWith('http://stream.example.com/ch1.m3u8', {
                allowPrivateIps: true,
            });
            expect(mockJoinChannel).toHaveBeenCalledWith(
                'ch-1',
                expect.objectContaining({ allowPrivateUrls: true }),
            );
        });

        it('returns the proxy-applied rung and its public URL', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
                rungId: '540p2m',
                appliedMaxBitrate: 2_000_000,
                reason: null,
            });
            const cap = {
                rung: { id: '540p2m', height: 540, maxBitrate: 2_000_000, codec: 'h264' as const },
                requestedMaxBitrate: 3_000_000,
                belowLadder: false,
                pinned: false,
                fallback: 'refuse' as const,
            };

            const result = await provider.getStreamInfo('ch-1', 'alice:device:a', cap);

            expect(mockJoinChannel).toHaveBeenCalledWith(
                'ch-1',
                expect.objectContaining({ viewerId: 'alice:device:a', cap }),
            );
            expect(result).toMatchObject({
                streamUrl: '/api/livetv/channels/ch-1/stream/r/540p2m/master.m3u8',
                rungId: '540p2m',
                requestedMaxBitrateBps: 3_000_000,
                appliedMaxBitrateBps: 2_000_000,
                appliedMaxHeight: 540,
                reason: null,
            });
        });

        it('forwards the player HEVC capability and serves the compat variant URL', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
                rungId: null,
                appliedMaxBitrate: null,
                reason: null,
                variant: 'fmp4',
            });

            const result = await provider.getStreamInfo(
                'ch-1',
                'alice:device:a',
                undefined,
                undefined,
                { client: { hevc: 'fmp4' } },
            );

            expect(mockJoinChannel).toHaveBeenCalledWith(
                'ch-1',
                expect.objectContaining({ client: { hevc: 'fmp4' } }),
            );
            expect(result).toMatchObject({
                streamUrl: '/api/livetv/channels/ch-1/stream/v/fmp4/master.m3u8',
                rungId: null,
                variant: 'fmp4',
            });
        });

        it('ignores a variant on a capped answer and sends no client without one', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
                rungId: null,
                appliedMaxBitrate: null,
                reason: null,
            });

            const result = await provider.getStreamInfo('ch-1', 'alice:device:a');

            expect(mockJoinChannel.mock.calls[0][1]).not.toHaveProperty('client');
            expect(result.streamUrl).toBe('/api/livetv/channels/ch-1/stream/master.m3u8');
            expect(result).not.toHaveProperty('variant');
        });

        it('returns the synchronized adaptive manifest and applied variants', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            const adaptive = {
                rungs: [
                    { id: '720p4m', height: 720, maxBitrate: 4_000_000, codec: 'h264' as const },
                    { id: '360p1m', height: 360, maxBitrate: 1_000_000, codec: 'h264' as const },
                ],
                includeOriginal: false,
                fallback: 'refuse' as const,
            };
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
                rungId: null,
                appliedMaxBitrate: null,
                reason: null,
                adaptive: { rungs: adaptive.rungs, includesOriginal: false },
            });

            const result = await provider.getStreamInfo(
                'ch-1',
                'alice:device:a',
                undefined,
                adaptive,
            );

            expect(mockJoinChannel).toHaveBeenCalledWith(
                'ch-1',
                expect.objectContaining({ adaptive, cap: undefined }),
            );
            expect(result).toMatchObject({
                streamUrl: '/api/livetv/channels/ch-1/stream/a/master.m3u8',
                rungId: null,
                adaptive: {
                    rungs: [
                        { id: '720p4m', height: 720, maxBitrateBps: 4_000_000, codec: 'h264' },
                        { id: '360p1m', height: 360, maxBitrateBps: 1_000_000, codec: 'h264' },
                    ],
                    includesOriginal: false,
                },
            });
        });

        it('falls Adaptive back to Original without losing the refusal reason', async () => {
            mockGetChannelWithSource.mockResolvedValue(channelWithSource);
            mockJoinChannel
                .mockResolvedValueOnce({ error: 'cap_unavailable', refusal: 'capacity' })
                .mockResolvedValueOnce({ success: true, channelId: 'ch-1' });
            const adaptive = {
                rungs: [
                    { id: '720p4m', height: 720, maxBitrate: 4_000_000, codec: 'h264' as const },
                    { id: '360p1m', height: 360, maxBitrate: 1_000_000, codec: 'h264' as const },
                ],
                includeOriginal: false,
                fallback: 'source' as const,
            };

            await expect(
                provider.getStreamInfo('ch-1', 'alice:device:a', undefined, adaptive),
            ).resolves.toMatchObject({
                streamUrl: '/api/livetv/channels/ch-1/stream/master.m3u8',
                adaptive: undefined,
                reason: 'capacity',
            });
            expect(mockJoinChannel).toHaveBeenCalledTimes(2);
        });

        it('reports the real refusal reason instead of collapsing it onto capacity', async () => {
            // 'unprobeable' and 'insufficient_ladder' used to surface as 'capacity',
            // which sent operators after CPU for a channel that was simply 480p, or
            // for a source ffprobe could not read.
            mockGetChannelWithSource.mockResolvedValue(channelWithSource);
            const adaptive = {
                rungs: [
                    { id: '720p4m', height: 720, maxBitrate: 4_000_000, codec: 'h264' as const },
                    { id: '360p1m', height: 360, maxBitrate: 1_000_000, codec: 'h264' as const },
                ],
                includeOriginal: false,
                fallback: 'source' as const,
            };

            for (const refusal of ['unprobeable', 'insufficient_ladder'] as const) {
                mockJoinChannel
                    .mockResolvedValueOnce({ error: 'cap_unavailable', refusal })
                    .mockResolvedValueOnce({ success: true, channelId: 'ch-1' });

                await expect(
                    provider.getStreamInfo('ch-1', 'alice:device:a', undefined, adaptive),
                ).resolves.toMatchObject({
                    streamUrl: '/api/livetv/channels/ch-1/stream/master.m3u8',
                    reason: refusal,
                });
            }
        });

        it('honours the source fallback when a legacy proxy drops the adaptive field', async () => {
            // The adaptive branch used to throw unconditionally here, so an operator on
            // fallback='source' still lost Live TV entirely against an older proxy —
            // while the `cap` branch three lines below honoured the same setting.
            mockGetChannelWithSource.mockResolvedValue(channelWithSource);
            mockJoinChannel
                .mockResolvedValueOnce({ success: true, channelId: 'ch-1' })
                .mockResolvedValueOnce({ success: true, channelId: 'ch-1' });

            await expect(
                provider.getStreamInfo('ch-1', 'alice:device:a', undefined, {
                    rungs: [
                        {
                            id: '720p4m',
                            height: 720,
                            maxBitrate: 4_000_000,
                            codec: 'h264' as const,
                        },
                        {
                            id: '360p1m',
                            height: 360,
                            maxBitrate: 1_000_000,
                            codec: 'h264' as const,
                        },
                    ],
                    includeOriginal: false,
                    fallback: 'source',
                }),
            ).resolves.toMatchObject({
                streamUrl: '/api/livetv/channels/ch-1/stream/master.m3u8',
                reason: 'capacity',
            });
        });

        it('releases the proxy viewer slot when it refuses after a successful join', async () => {
            // These refusals happen AFTER the proxy admitted the viewer. Without the
            // compensating leave the slot counted against the source's maxStreams
            // until the orphan sweep expired the heartbeat ~30s later.
            mockGetChannelWithSource.mockResolvedValue(channelWithSource);
            mockLeaveChannel.mockClear();
            // existingViewer:false — this join ADMITTED the viewer, so the slot it
            // reserved is ours to release.
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
                existingViewer: false,
            });

            await expect(
                provider.getStreamInfo('ch-1', 'alice:device:a', undefined, {
                    rungs: [
                        {
                            id: '720p4m',
                            height: 720,
                            maxBitrate: 4_000_000,
                            codec: 'h264' as const,
                        },
                        {
                            id: '360p1m',
                            height: 360,
                            maxBitrate: 1_000_000,
                            codec: 'h264' as const,
                        },
                    ],
                    includeOriginal: false,
                    fallback: 'refuse',
                }),
            ).rejects.toEqual(
                expect.objectContaining<Partial<CapUnavailableError>>({
                    name: 'CapUnavailableError',
                }),
            );
            expect(mockLeaveChannel).toHaveBeenCalledWith('ch-1', 'alice:device:a');
        });

        it('does NOT evict a viewer who was already watching when a switch is refused', async () => {
            // A quality switch by a viewer mid-playback admits nobody and reserves no
            // slot, so there is nothing to release — and leaving would kill a session
            // that was never in question. The multiplexer's attach-before-detach design
            // deliberately keeps a refused switch playing; a compensating leave here
            // would 404 their next heartbeat and drop the stream seconds later.
            mockGetChannelWithSource.mockResolvedValue(channelWithSource);
            mockLeaveChannel.mockClear();
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
                existingViewer: true,
            });

            await expect(
                provider.getStreamInfo('ch-1', 'alice:device:a', undefined, {
                    rungs: [
                        {
                            id: '720p4m',
                            height: 720,
                            maxBitrate: 4_000_000,
                            codec: 'h264' as const,
                        },
                        {
                            id: '360p1m',
                            height: 360,
                            maxBitrate: 1_000_000,
                            codec: 'h264' as const,
                        },
                    ],
                    includeOriginal: false,
                    fallback: 'refuse',
                }),
            ).rejects.toEqual(
                expect.objectContaining<Partial<CapUnavailableError>>({
                    name: 'CapUnavailableError',
                }),
            );
            expect(mockLeaveChannel).not.toHaveBeenCalled();
        });

        it('does not evict when an older proxy cannot say whether the join was fresh', async () => {
            // `existingViewer` absent = "cannot prove this was a fresh admission".
            // Holding a slot for 30s is recoverable; killing a working stream is not.
            mockGetChannelWithSource.mockResolvedValue(channelWithSource);
            mockLeaveChannel.mockClear();
            mockJoinChannel.mockResolvedValueOnce({ success: true, channelId: 'ch-1' });

            await expect(
                provider.getStreamInfo('ch-1', 'alice:device:a', undefined, {
                    rungs: [
                        {
                            id: '720p4m',
                            height: 720,
                            maxBitrate: 4_000_000,
                            codec: 'h264' as const,
                        },
                        {
                            id: '360p1m',
                            height: 360,
                            maxBitrate: 1_000_000,
                            codec: 'h264' as const,
                        },
                    ],
                    includeOriginal: false,
                    fallback: 'refuse',
                }),
            ).rejects.toThrow();
            expect(mockLeaveChannel).not.toHaveBeenCalled();
        });

        it.each([
            ['source', 'success'],
            ['refuse', 'refusal'],
        ] as const)('handles a legacy proxy under %s fallback', async (fallback, outcome) => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({ success: true, channelId: 'ch-1' });
            const cap = {
                rung: { id: '540p2m', height: 540, maxBitrate: 2_000_000, codec: 'h264' as const },
                requestedMaxBitrate: 3_000_000,
                belowLadder: false,
                pinned: false,
                fallback,
            };

            if (outcome === 'refusal') {
                await expect(provider.getStreamInfo('ch-1', 'alice:device:a', cap)).rejects.toEqual(
                    expect.objectContaining<Partial<CapUnavailableError>>({
                        name: 'CapUnavailableError',
                        refusal: 'capacity',
                    }),
                );
            } else {
                await expect(
                    provider.getStreamInfo('ch-1', 'alice:device:a', cap),
                ).resolves.toMatchObject({
                    streamUrl: '/api/livetv/channels/ch-1/stream/master.m3u8',
                    rungId: null,
                    appliedMaxBitrateBps: null,
                    reason: 'capacity',
                });
            }
        });

        it('includes backup group URLs for failover', async () => {
            const channelWithBackup = {
                ...channelWithSource,
                backup_group_id: 'bg-1',
            };
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithBackup);
            mockGetBackupGroupFeeds.mockResolvedValueOnce([
                {
                    id: 'ch-1b',
                    name: 'Test Channel SD',
                    stream_url: 'http://stream.example.com/ch1-backup.m3u8',
                },
            ]);
            mockJoinChannel.mockResolvedValueOnce({
                success: true,
                channelId: 'ch-1',
            });

            await provider.getStreamInfo('ch-1', 'user1');

            expect(mockJoinChannel).toHaveBeenCalledWith('ch-1', {
                viewerId: 'user1',
                streamUrls: [
                    'http://stream.example.com/ch1.m3u8',
                    'http://stream.example.com/ch1-backup.m3u8',
                ],
                feedIds: ['ch-1', 'ch-1b'],
                allowPrivateUrls: false,
                sourceId: 'src-1',
                maxStreams: 2,
                channelName: 'Test Channel',
                cap: undefined,
            });
        });

        describe('awaitReady and start success', () => {
            const backupFeeds = [
                { id: 'ch-1b', name: 'Test Channel SD', stream_url: 'http://s.example.com/b.m3u8' },
            ];
            const withBackup = { ...channelWithSource, backup_group_id: 'bg-1' };

            // These tests queue persistent answers; do not leak them into the next test.
            afterEach(() => {
                mockGetChannelWithSource.mockReset();
                mockGetBackupGroupFeeds.mockReset();
                mockJoinChannel.mockReset();
            });

            it('sends awaitReadyMs only when the caller asks for a ready start', async () => {
                mockGetChannelWithSource.mockResolvedValue(channelWithSource);
                mockJoinChannel.mockResolvedValue({ success: true, channelId: 'ch-1' });

                await provider.getStreamInfo('ch-1', 'u');
                expect(mockJoinChannel.mock.calls[0][1]).not.toHaveProperty('awaitReadyMs');

                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, {
                    awaitReady: true,
                });
                expect(mockJoinChannel.mock.calls[1][1]).toMatchObject({ awaitReadyMs: 12_000 });
                // Far under the proxy client's 45 s whole-exchange timeout.
                expect(mockJoinChannel.mock.calls[1][1].awaitReadyMs).toBeLessThan(45_000);
            });

            it('counts a start as a success only when the proxy answered ready: true', async () => {
                mockGetChannelWithSource.mockResolvedValue(channelWithSource);
                const opts = { awaitReady: true };

                mockJoinChannel.mockResolvedValueOnce({ success: true, channelId: 'ch-1' });
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, opts);
                mockJoinChannel.mockResolvedValueOnce({
                    success: true,
                    channelId: 'ch-1',
                    ready: false,
                });
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, opts);
                expect(mockRecordStartSuccess).not.toHaveBeenCalled();

                mockJoinChannel.mockResolvedValueOnce({
                    success: true,
                    channelId: 'ch-1',
                    ready: true,
                });
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, opts);
                expect(mockRecordStartSuccess).toHaveBeenCalledTimes(1);
                expect(mockRecordStartSuccess).toHaveBeenCalledWith(expect.anything(), 'ch-1');
            });

            it('never counts a join that did not ask for a ready start (preview, compat, retry)', async () => {
                mockGetChannelWithSource.mockResolvedValue(channelWithSource);
                mockJoinChannel.mockResolvedValue({
                    success: true,
                    channelId: 'ch-1',
                    ready: true,
                });
                await provider.getStreamInfo('ch-1', 'u');
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, {
                    awaitReady: false,
                });
                expect(mockRecordStartSuccess).not.toHaveBeenCalled();
            });

            it('credits the feed the proxy names as serving, else the requested feed', async () => {
                mockGetChannelWithSource.mockResolvedValue(withBackup);
                mockGetBackupGroupFeeds.mockResolvedValue(backupFeeds);
                const opts = { awaitReady: true };

                mockJoinChannel.mockResolvedValueOnce({
                    success: true,
                    channelId: 'ch-1',
                    ready: true,
                    streamUrlIndex: 1,
                });
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, opts);
                expect(mockRecordStartSuccess).toHaveBeenLastCalledWith(expect.anything(), 'ch-1b');

                // A feed id the app never sent is ignored.
                mockJoinChannel.mockResolvedValueOnce({
                    success: true,
                    channelId: 'ch-1',
                    ready: true,
                    feedId: 'someone-else',
                });
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, opts);
                expect(mockRecordStartSuccess).toHaveBeenLastCalledWith(expect.anything(), 'ch-1');
            });

            it('reports the feeds it sent, in order, through onFeedsSent', async () => {
                mockGetChannelWithSource.mockResolvedValue(withBackup);
                mockGetBackupGroupFeeds.mockResolvedValue(backupFeeds);
                mockJoinChannel.mockResolvedValue({ success: true, channelId: 'ch-1' });
                const onFeedsSent = vi.fn();
                await provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, {
                    onFeedsSent,
                });
                expect(onFeedsSent).toHaveBeenCalledWith([
                    { id: 'ch-1', name: 'Test Channel' },
                    { id: 'ch-1b', name: 'Test Channel SD' },
                ]);
            });

            it('tolerates a Rust-style proxy that knows neither ready nor awaitReadyMs', async () => {
                mockGetChannelWithSource.mockResolvedValue(channelWithSource);
                mockJoinChannel.mockResolvedValue({ success: true, channelId: 'ch-1' });
                await expect(
                    provider.getStreamInfo('ch-1', 'u', undefined, undefined, undefined, {
                        awaitReady: true,
                    }),
                ).resolves.toMatchObject({ requiresProxy: true });
                expect(mockRecordStartSuccess).not.toHaveBeenCalled();
            });
        });

        it('throws on stream limit reached', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                error: 'stream_limit_reached',
                limit: 2,
                active: [
                    {
                        channelId: 'ch-2',
                        channelName: 'Other Channel',
                        viewers: 1,
                    },
                ],
            });

            await expect(provider.getStreamInfo('ch-1', 'user1')).rejects.toThrow(
                /stream limit reached/i,
            );
        });

        it('turns a proxy channel_failed into a typed failure with feeds named', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce({
                ...channelWithSource,
                backup_group_id: 'bg-1',
            });
            mockGetBackupGroupFeeds.mockResolvedValueOnce([
                { id: 'ch-1b', name: 'Test Channel SD', stream_url: 'http://s.example.com/b.m3u8' },
            ]);
            mockJoinChannel.mockResolvedValueOnce({
                error: 'channel_failed',
                reason: 'all_feeds_failed',
                retryable: true,
                retryAfterMs: 10_000,
                feedsTried: [
                    { index: 0, reason: 'provider_auth_failed', upstreamStatus: 403 },
                    { index: 1, feedId: 'ch-1b', reason: 'provider_unreachable' },
                ],
            });

            const error = await provider.getStreamInfo('ch-1', 'user1').catch((e: unknown) => e);

            expect(error).toBeInstanceOf(LiveTvFailureError);
            expect(error).toMatchObject({
                reason: 'all_feeds_failed',
                retryable: true,
                retryAfterMs: 10_000,
                feedsTried: [
                    {
                        feedId: 'ch-1',
                        feedName: 'Test Channel',
                        reason: 'provider_auth_failed',
                        upstreamStatus: 403,
                    },
                    {
                        feedId: 'ch-1b',
                        feedName: 'Test Channel SD',
                        reason: 'provider_unreachable',
                    },
                ],
            });
            // A Jellyfin-compat route still reads the flat code.
            expect(error).toBeInstanceOf(StreamFailureError);
        });

        it.each([
            ['spawn_failed', 'encoder_failed'],
            ['source_unreachable', 'provider_unreachable'],
        ] as const)('classifies the legacy proxy error %s as %s', async (legacy, reason) => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockJoinChannel.mockResolvedValueOnce({
                error: legacy,
                message: 'x',
                channelId: 'ch-1',
            });

            await expect(provider.getStreamInfo('ch-1', 'user1')).rejects.toMatchObject({
                reason,
                errorCode: legacy,
            });
        });

        it.each(['channel_not_found', 'no_segments'] as const)(
            'keeps the proxy answer %s a generic failure, not an offline verdict',
            async (legacy) => {
                mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
                mockJoinChannel.mockResolvedValueOnce({ error: legacy, channelId: 'ch-1' });

                const error = await provider.getStreamInfo('ch-1', 'u').catch((e: unknown) => e);
                expect(error).toBeInstanceOf(StreamFailureError);
                expect(error).not.toBeInstanceOf(LiveTvFailureError);
                expect(error).toMatchObject({ errorCode: legacy });
            },
        );

        it('classifies a channel without a stream URL as channel_offline', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce({
                ...channelWithSource,
                stream_url: '',
            });
            await expect(provider.getStreamInfo('ch-1', 'u')).rejects.toMatchObject({
                reason: 'channel_offline',
                retryable: false,
            });
        });

        it('classifies a station whose URLs are all blocked as provider_unreachable', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(channelWithSource);
            mockValidateUrl.mockResolvedValue({ valid: false, reason: 'private address' });

            await expect(provider.getStreamInfo('ch-1', 'user1')).rejects.toMatchObject({
                reason: 'provider_unreachable',
                retryable: true,
                retryAfterMs: 10_000,
                feedsTried: [{ feedId: 'ch-1', feedName: 'Test Channel' }],
            });
            expect(mockJoinChannel).not.toHaveBeenCalled();
        });

        it('throws when channel not found', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce(null);

            await expect(provider.getStreamInfo('non-existent', 'user1')).rejects.toThrow(
                /not found/i,
            );
        });
    });

    describe('getCurrentProgram', () => {
        it('returns undefined when no current program', async () => {
            mockGetCurrentProgram.mockResolvedValueOnce(null);

            const result = await provider.getCurrentProgram('ch-1');
            expect(result).toBeUndefined();
        });
    });

    describe('getGuidePrograms', () => {
        const programRow = (
            channelId: string,
            startIso: string,
            endIso: string,
            title: string,
        ) => ({
            id: `${channelId}-${startIso}`,
            channel_id: channelId,
            title,
            description: null,
            start_time: new Date(startIso),
            end_time: new Date(endIso),
            epg_id: 'OrbNature.de@SD',
            genres: null,
            official_rating: null,
            source_id: 'src-1',
        });

        it('suppresses parallel schedules left behind by an older import', async () => {
            // Read-side safety net: ingest collapses these, but rows written by a
            // previous build must not reach /api/v1 or the /j clients either.
            mockGetGuidePrograms.mockResolvedValueOnce([
                programRow('ch-1', '2026-07-28T12:07:24Z', '2026-07-28T13:02:23Z', 'Riffhai'),
                programRow('ch-1', '2026-07-28T12:10:41Z', '2026-07-28T13:05:43Z', 'Riffhai'),
                programRow('ch-1', '2026-07-28T13:02:23Z', '2026-07-28T13:50:54Z', 'Nationalparks'),
                programRow('ch-1', '2026-07-28T13:05:43Z', '2026-07-28T13:54:06Z', 'Nationalparks'),
            ]);

            const result = await provider.getGuidePrograms(
                new Date('2026-07-28T12:00:00Z'),
                new Date('2026-07-28T14:00:00Z'),
            );

            expect(result['ch-1']).toHaveLength(2);
            const [first, second] = result['ch-1'];
            expect(new Date(second.startTime).getTime()).toBeGreaterThanOrEqual(
                new Date(first.endTime).getTime(),
            );
        });

        it('exposes feed provenance on each program', async () => {
            mockGetGuidePrograms.mockResolvedValueOnce([
                programRow('ch-2', '2026-07-28T12:00:00Z', '2026-07-28T13:00:00Z', 'A'),
            ]);

            const result = await provider.getGuidePrograms(
                new Date('2026-07-28T12:00:00Z'),
                new Date('2026-07-28T14:00:00Z'),
            );

            expect(result['ch-2'][0].sourceId).toBe('src-1');
            expect(result['ch-2'][0].epgId).toBe('OrbNature.de@SD');
        });

        it('leaves a clean schedule untouched', async () => {
            mockGetGuidePrograms.mockResolvedValueOnce([
                programRow('ch-3', '2026-07-28T12:00:00Z', '2026-07-28T13:00:00Z', 'A'),
                programRow('ch-3', '2026-07-28T13:00:00Z', '2026-07-28T14:00:00Z', 'B'),
            ]);

            const result = await provider.getGuidePrograms(
                new Date('2026-07-28T12:00:00Z'),
                new Date('2026-07-28T14:00:00Z'),
            );

            expect(result['ch-3'].map((p) => p.title)).toEqual(['A', 'B']);
        });
    });

    describe('viewer channel names (LIVETV_HIDE_QUALITY_TAGS)', () => {
        const lineupRows = [
            { ...sampleChannelRow, id: 'ch-1', name: 'UK: Nordwelle FHD' },
            { ...sampleChannelRow, id: 'ch-2', name: 'UK: Orb History HD' },
            { ...sampleChannelRow, id: 'ch-3', name: 'US: Orb History HD' },
            {
                ...sampleChannelRow,
                id: 'ch-4',
                name: 'KWF Renamed HD',
                admin_display_name: 'KWF Renamed HD',
            },
        ];

        beforeEach(() => {
            mockConfig.LIVETV_HIDE_QUALITY_TAGS = true;
        });

        it('shows the lineup without provider tags, unless they tell cards apart', async () => {
            mockGetAllVisibleChannels.mockResolvedValueOnce(lineupRows);

            const channels = await provider.getChannels();

            expect(channels.map((ch) => ch.name)).toEqual([
                'Nordwelle',
                'UK: Orb History',
                'US: Orb History',
                'KWF Renamed HD',
            ]);
        });

        it('leaves names alone when the setting is off', async () => {
            mockConfig.LIVETV_HIDE_QUALITY_TAGS = false;
            mockGetAllVisibleChannels.mockResolvedValueOnce(lineupRows);

            const channels = await provider.getChannels();

            expect(channels[0].name).toBe('UK: Nordwelle FHD');
        });

        it('gives a single channel the name its lineup card shows', async () => {
            mockGetAllVisibleChannels.mockResolvedValueOnce(lineupRows);
            mockGetChannelWithSource.mockResolvedValueOnce({
                ...sampleChannelRow,
                id: 'ch-2',
                name: 'UK: Orb History HD',
            });

            const channel = await provider.getChannel('ch-2');

            expect(channel?.name).toBe('UK: Orb History');
        });

        it('cleans a channel outside the lineup on its own', async () => {
            mockGetAllVisibleChannels.mockResolvedValueOnce(lineupRows);
            mockGetChannelWithSource.mockResolvedValueOnce({
                ...sampleChannelRow,
                id: 'hidden-feed',
                name: 'DE • Musa HDʀᴀᴡ',
            });

            const channel = await provider.getChannel('hidden-feed');

            expect(channel?.name).toBe('Musa');
        });

        it('falls back to cleaning alone when the lineup cannot be read', async () => {
            mockGetAllVisibleChannels.mockRejectedValueOnce(new Error('db down'));
            mockGetChannelWithSource.mockResolvedValueOnce({
                ...sampleChannelRow,
                id: 'ch-1',
                name: 'UK: Nordwelle FHD',
            });

            const channel = await provider.getChannel('ch-1');

            expect(channel?.name).toBe('Nordwelle');
        });

        it('names search results like the lineup', async () => {
            mockGetAllVisibleChannels.mockResolvedValueOnce(lineupRows);
            mockSearchChannels.mockResolvedValueOnce([lineupRows[0]]);

            const [channel] = await provider.searchChannels('nordwelle');

            expect(channel.name).toBe('Nordwelle');
        });
    });

    describe('searchChannels', () => {
        it('delegates to channel search query and transforms results', async () => {
            mockSearchChannels.mockResolvedValueOnce([sampleChannelRow]);

            const results = await provider.searchChannels('test');
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('ch-1');
            expect(mockSearchChannels).toHaveBeenCalledWith(mockSql, 'test', 20);
        });
    });

    describe('searchPrograms', () => {
        it('returns empty array when no results match', async () => {
            mockSearchProgramAirings.mockResolvedValueOnce([]);

            const results = await provider.searchPrograms('nonexistent');
            expect(results).toEqual([]);
            expect(mockSearchProgramAirings).toHaveBeenCalledWith(mockSql, 'nonexistent', 20, 0);
        });

        it('maps airing rows to station-keyed airings and passes paging through', async () => {
            mockSearchProgramAirings.mockResolvedValueOnce([
                {
                    id: 'air-1',
                    station_id: 'st-1',
                    title: 'Football Match',
                    description: null,
                    temporal_status: 'live',
                    start_time: new Date('2026-03-10T20:00:00.000Z'),
                    end_time: new Date('2026-03-10T22:00:00.000Z'),
                },
            ]);

            const results = await provider.searchPrograms('football', 10, 5);
            expect(mockSearchProgramAirings).toHaveBeenCalledWith(mockSql, 'football', 10, 5);
            expect(results).toEqual([
                {
                    id: 'air-1',
                    stationId: 'st-1',
                    title: 'Football Match',
                    description: undefined,
                    temporalStatus: 'live',
                    startTime: '2026-03-10T20:00:00.000Z',
                    endTime: '2026-03-10T22:00:00.000Z',
                },
            ]);
        });
    });

    describe('getStreamInfo error types', () => {
        it('throws StreamLimitError (not generic Error) on stream limit', async () => {
            mockGetChannelWithSource.mockResolvedValueOnce({
                ...sampleChannelRow,
                max_streams: 2,
                source_name: 'Test Source',
            });
            mockJoinChannel.mockResolvedValueOnce({
                error: 'stream_limit_reached',
                limit: 2,
                active: [
                    {
                        channelId: 'ch-2',
                        channelName: 'Other Channel',
                        viewers: 1,
                    },
                ],
            });

            try {
                await provider.getStreamInfo('ch-1', 'user1');
                expect.fail('Should have thrown');
            } catch (error) {
                expect(error).toBeInstanceOf(StreamLimitError);
                expect((error as StreamLimitError).limit).toBe(2);
                expect((error as StreamLimitError).activeChannels).toEqual([
                    {
                        channelId: 'ch-2',
                        channelName: 'Other Channel',
                        viewers: 1,
                    },
                ]);
            }
        });
    });
});
