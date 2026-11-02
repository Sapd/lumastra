// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id';
import { WatchHistoryService } from './watch-history.service';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

describe('WatchHistoryService', () => {
    const mockInsert = vi.fn();
    const mockSql = {} as unknown;
    const mockGetDb = vi.fn().mockReturnValue(mockSql);

    let service: WatchHistoryService;

    beforeEach(() => {
        vi.clearAllMocks();
        service = new WatchHistoryService(mockGetDb, mockInsert);
    });

    it('creates watch_history row from play session data', async () => {
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test Movie',
            startedAt: new Date('2026-03-28T10:00:00Z'),
            stoppedAt: new Date('2026-03-28T12:00:00Z'),
            positionMs: 7200000,
            runtimeMs: 7200000,
            isCompleted: true,
            deviceName: 'Chrome',
            videoCodec: 'h264',
            resolution: '1920x1080',
            bitrateKbps: 8000,
        });

        expect(mockInsert).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({
                userId: ALICE,
                mediaId: 'uuid-1',
                isCompleted: true,
                actualWatchTimeSeconds: 7200,
                completionPercentage: 100,
            }),
        );
    });

    it('caps watch time at the runtime when the player was left open', async () => {
        // Prod: a 55-minute episode recorded as 5 h 38 m with the playhead at 0.
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'episode',
            title: 'Father Knows Best',
            startedAt: new Date('2026-07-14T13:43:00Z'),
            stoppedAt: new Date('2026-07-14T19:21:49Z'),
            positionMs: 0,
            runtimeMs: 55 * 60_000,
            isCompleted: false,
        });

        expect(mockInsert).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ actualWatchTimeSeconds: 55 * 60 }),
        );
    });

    it('keeps the wall clock when the runtime is unknown', async () => {
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test Movie',
            startedAt: new Date('2026-03-28T10:00:00Z'),
            stoppedAt: new Date('2026-03-28T13:00:00Z'),
            positionMs: 0,
            isCompleted: false,
        });

        expect(mockInsert).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({ actualWatchTimeSeconds: 3 * 3600 }),
        );
    });

    it('computes correct completion percentage', async () => {
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test Movie',
            startedAt: new Date('2026-03-28T10:00:00Z'),
            stoppedAt: new Date('2026-03-28T11:00:00Z'),
            positionMs: 3600000,
            runtimeMs: 7200000,
            isCompleted: false,
        });

        expect(mockInsert).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({
                completionPercentage: 50,
                isCompleted: false,
            }),
        );
    });

    it('does not insert if no DB available', async () => {
        const noDbService = new WatchHistoryService(() => null, mockInsert);
        await noDbService.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test',
            startedAt: new Date(),
            stoppedAt: new Date(),
            positionMs: 1000,
            runtimeMs: 2000,
            isCompleted: false,
        });

        expect(mockInsert).not.toHaveBeenCalled();
    });

    it('handles zero runtime gracefully', async () => {
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test',
            startedAt: new Date('2026-03-28T10:00:00Z'),
            stoppedAt: new Date('2026-03-28T10:30:00Z'),
            positionMs: 1800000,
            isCompleted: false,
        });

        expect(mockInsert).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({
                completionPercentage: 0,
            }),
        );
    });

    it('caps completion percentage at 100', async () => {
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test',
            startedAt: new Date('2026-03-28T10:00:00Z'),
            stoppedAt: new Date('2026-03-28T12:30:00Z'),
            positionMs: 8000000,
            runtimeMs: 7200000,
            isCompleted: true,
        });

        expect(mockInsert).toHaveBeenCalledWith(
            mockSql,
            expect.objectContaining({
                completionPercentage: 100,
            }),
        );
    });

    it('swallows insert errors gracefully', async () => {
        mockInsert.mockRejectedValueOnce(new Error('DB down'));

        // Should not throw
        await service.recordCompletedSession({
            userId: ALICE,
            mediaId: 'uuid-1',
            mediaType: 'movie',
            title: 'Test',
            startedAt: new Date(),
            stoppedAt: new Date(),
            positionMs: 1000,
            runtimeMs: 2000,
            isCompleted: false,
        });

        expect(mockInsert).toHaveBeenCalled();
    });
});
