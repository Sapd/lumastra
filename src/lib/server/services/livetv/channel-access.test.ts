// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockConfig, mockGetDb, mockStreamable } = vi.hoisted(() => ({
    mockConfig: { LIVETV_SOURCE: 'standalone', LIVETV_VIEWER_FEED_CHOICE: true },
    mockGetDb: vi.fn(),
    mockStreamable: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    isChannelStreamableByViewer: mockStreamable,
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import {
    canReadLiveTvChannelStream,
    canStreamLiveTvChannel,
    clearLiveTvStreamReadCache,
    STREAM_READ_CACHE_TTL_MS,
} from './channel-access.js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';
const sql = { tag: 'sql' };
const viewer = { user: { ownerIsAdmin: false }, principal: { isAdmin: false } };

describe('canStreamLiveTvChannel', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.LIVETV_SOURCE = 'standalone';
        mockConfig.LIVETV_VIEWER_FEED_CHOICE = true;
        mockGetDb.mockReturnValue(sql);
        mockStreamable.mockResolvedValue(true);
    });

    it('lets an admin stream any channel without asking the database', async () => {
        expect(await canStreamLiveTvChannel({ principal: { isAdmin: true } }, CHANNEL)).toBe(true);
        expect(mockStreamable).not.toHaveBeenCalled();
    });

    it('does not take the owner flag of a non-admin credential for admin', async () => {
        mockStreamable.mockResolvedValue(false);
        const scopedToken = { user: { ownerIsAdmin: true }, principal: { isAdmin: false } };
        expect(await canStreamLiveTvChannel(scopedToken, CHANNEL)).toBe(false);
    });

    it.each([true, false])('asks the lineup with feed choice %s', async (feedChoice) => {
        mockConfig.LIVETV_VIEWER_FEED_CHOICE = feedChoice;
        mockStreamable.mockResolvedValue(false);
        expect(await canStreamLiveTvChannel(viewer, CHANNEL)).toBe(false);
        expect(mockStreamable).toHaveBeenCalledWith(sql, CHANNEL, feedChoice);
    });

    it('refuses a non-UUID id without asking the database, even for an admin', async () => {
        expect(await canStreamLiveTvChannel({ principal: { isAdmin: true } }, 'nope')).toBe(false);
        expect(await canStreamLiveTvChannel(viewer, "x' OR 1=1")).toBe(false);
        expect(mockStreamable).not.toHaveBeenCalled();
    });

    it('fails closed without a database', async () => {
        mockGetDb.mockReturnValue(null);
        expect(await canStreamLiveTvChannel(viewer, CHANNEL)).toBe(false);
    });

    it('defers to the provider when Live TV is not standalone', async () => {
        mockConfig.LIVETV_SOURCE = 'disabled';
        expect(await canStreamLiveTvChannel(viewer, CHANNEL)).toBe(true);
        expect(mockStreamable).not.toHaveBeenCalled();
    });
});

describe('canReadLiveTvChannelStream', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useRealTimers();
        clearLiveTvStreamReadCache();
        mockConfig.LIVETV_SOURCE = 'standalone';
        mockConfig.LIVETV_VIEWER_FEED_CHOICE = true;
        mockGetDb.mockReturnValue(sql);
        mockStreamable.mockResolvedValue(false);
    });

    it('asks the lineup once per channel within the TTL, for every viewer', async () => {
        const other = { user: { ownerIsAdmin: false }, principal: { isAdmin: false } };
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
        expect(await canReadLiveTvChannelStream(other, CHANNEL)).toBe(false);
        expect(mockStreamable).toHaveBeenCalledTimes(1);
    });

    it('asks again once the verdict is older than the TTL', async () => {
        vi.useFakeTimers();
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
        mockStreamable.mockResolvedValue(true);
        vi.advanceTimersByTime(STREAM_READ_CACHE_TTL_MS + 1);
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(true);
        expect(mockStreamable).toHaveBeenCalledTimes(2);
        vi.useRealTimers();
    });

    it('keeps a separate verdict per feed-choice setting', async () => {
        await canReadLiveTvChannelStream(viewer, CHANNEL);
        mockConfig.LIVETV_VIEWER_FEED_CHOICE = false;
        await canReadLiveTvChannelStream(viewer, CHANNEL);
        expect(mockStreamable).toHaveBeenNthCalledWith(1, sql, CHANNEL, true);
        expect(mockStreamable).toHaveBeenNthCalledWith(2, sql, CHANNEL, false);
    });

    it('never serves a cached viewer verdict to an admin, nor an admin verdict to a viewer', async () => {
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
        expect(await canReadLiveTvChannelStream({ principal: { isAdmin: true } }, CHANNEL)).toBe(
            true,
        );
        clearLiveTvStreamReadCache();
        expect(await canReadLiveTvChannelStream({ principal: { isAdmin: true } }, CHANNEL)).toBe(
            true,
        );
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
    });

    it('shares one lookup between concurrent requests for a channel', async () => {
        let release!: (v: boolean) => void;
        mockStreamable.mockReturnValue(new Promise<boolean>((r) => (release = r)));
        const reads = Array.from({ length: 5 }, () => canReadLiveTvChannelStream(viewer, CHANNEL));
        release(true);
        expect(await Promise.all(reads)).toEqual([true, true, true, true, true]);
        expect(mockStreamable).toHaveBeenCalledTimes(1);
    });

    it('lets a stream token an admin minted read any channel, like the join', async () => {
        const adminToken = {
            user: { ownerIsAdmin: true, mediaAccessIsAdmin: true },
            principal: { isAdmin: false },
        };
        expect(await canStreamLiveTvChannel(adminToken, CHANNEL)).toBe(true);
        expect(await canReadLiveTvChannelStream(adminToken, CHANNEL)).toBe(true);
        expect(mockStreamable).not.toHaveBeenCalled();
    });

    it('treats an upper-case id as the same channel', async () => {
        await canReadLiveTvChannelStream(viewer, CHANNEL);
        await canReadLiveTvChannelStream(viewer, CHANNEL.toUpperCase());
        expect(mockStreamable).toHaveBeenCalledTimes(1);
    });

    it('takes the verdict of a fresh join, so an unhidden channel plays at once', async () => {
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
        mockStreamable.mockResolvedValue(true);
        expect(await canStreamLiveTvChannel(viewer, CHANNEL)).toBe(true);
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(true);
        expect(mockStreamable).toHaveBeenCalledTimes(2);
    });

    it('does not cache the fail-closed answer without a database', async () => {
        mockGetDb.mockReturnValueOnce(null);
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(false);
        mockStreamable.mockResolvedValue(true);
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(true);
    });

    it('refuses a non-UUID id without asking the database', async () => {
        expect(await canReadLiveTvChannelStream(viewer, 'nope')).toBe(false);
        expect(mockStreamable).not.toHaveBeenCalled();
    });

    it('does not cache a failed lookup', async () => {
        mockStreamable.mockRejectedValueOnce(new Error('db down'));
        await expect(canReadLiveTvChannelStream(viewer, CHANNEL)).rejects.toThrow('db down');
        mockStreamable.mockResolvedValue(true);
        expect(await canReadLiveTvChannelStream(viewer, CHANNEL)).toBe(true);
    });
});
