// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/database/queries/media-segments.queries.js', () => ({
    getSegmentsByMediaId: vi.fn(),
    toMediaSegments: vi.fn((rows) =>
        rows.map((r: { type: string; start_time: number; end_time: number }) => ({
            type: r.type,
            startTime: r.start_time,
            endTime: r.end_time,
        })),
    ),
    getEpisodeInfo: vi.fn(),
}));

vi.mock('$lib/server/database/queries/task-settings.queries.js', () => ({
    getTaskSettings: vi.fn(),
}));

const INTRO_ROW = {
    id: 'x',
    media_id: 'm',
    type: 'Intro' as const,
    start_time: 10,
    end_time: 90,
    source: 'lumastra-intro-analyzer',
    fetched_at: new Date(),
};

const OUTRO_ROW = {
    id: 'y',
    media_id: 'm',
    type: 'Outro' as const,
    start_time: 1200,
    end_time: 1350,
    source: 'lumastra-intro-analyzer',
    fetched_at: new Date(),
};

describe('MediaSegmentsService', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Reset module state so the module-scoped suppressFlag cache doesn't
        // leak between tests.
        vi.resetModules();
    });

    it('returns DB segments when available', async () => {
        const { getSegmentsByMediaId } =
            await import('$lib/server/database/queries/media-segments.queries.js');
        const { getTaskSettings } =
            await import('$lib/server/database/queries/task-settings.queries.js');
        vi.mocked(getSegmentsByMediaId).mockResolvedValue([INTRO_ROW]);
        vi.mocked(getTaskSettings).mockResolvedValue({});
        const { createMediaSegmentsService } = await import('./media-segments.service.js');
        const service = createMediaSegmentsService({} as never);
        const result = await service.getSegments('media-uuid');
        expect(result).toHaveLength(1);
        expect(result[0].type).toBe('Intro');
    });

    it('forwards the selected file to the marker query', async () => {
        const { getSegmentsByMediaId } = await import('$lib/server/database/queries/media-segments.queries.js');
        const { getTaskSettings } = await import('$lib/server/database/queries/task-settings.queries.js');
        vi.mocked(getSegmentsByMediaId).mockResolvedValue([OUTRO_ROW]);
        vi.mocked(getTaskSettings).mockResolvedValue({});
        const { createMediaSegmentsService } = await import('./media-segments.service.js');
        const sql = {} as never;
        await createMediaSegmentsService(sql).getSegments('media', 'selected');
        expect(getSegmentsByMediaId).toHaveBeenCalledWith(sql, 'media', 'selected');
    });

    it('returns empty array when no segments cached', async () => {
        const { getSegmentsByMediaId } =
            await import('$lib/server/database/queries/media-segments.queries.js');
        const { getTaskSettings } =
            await import('$lib/server/database/queries/task-settings.queries.js');
        vi.mocked(getSegmentsByMediaId).mockResolvedValue([]);
        vi.mocked(getTaskSettings).mockResolvedValue({});
        const { createMediaSegmentsService } = await import('./media-segments.service.js');
        const service = createMediaSegmentsService({} as never);
        const result = await service.getSegments('media-uuid');
        expect(result).toEqual([]);
    });

    describe('suppressFirstEpisodeIntro filter', () => {
        it('filters Intro when flag is on and item is episode 1', async () => {
            const { getSegmentsByMediaId, getEpisodeInfo } =
                await import('$lib/server/database/queries/media-segments.queries.js');
            const { getTaskSettings } =
                await import('$lib/server/database/queries/task-settings.queries.js');
            vi.mocked(getTaskSettings).mockResolvedValue({
                suppressFirstEpisodeIntro: true,
            });
            vi.mocked(getSegmentsByMediaId).mockResolvedValue([INTRO_ROW, OUTRO_ROW]);
            vi.mocked(getEpisodeInfo).mockResolvedValue({
                media_type: 'episode',
                episode_number: 1,
            });
            const { createMediaSegmentsService } = await import('./media-segments.service.js');
            const service = createMediaSegmentsService({} as never);
            const result = await service.getSegments('ep1-uuid');
            expect(result.map((s) => s.type)).toEqual(['Outro']);
        });

        it('passes Intro through when flag is on but item is episode 5', async () => {
            const { getSegmentsByMediaId, getEpisodeInfo } =
                await import('$lib/server/database/queries/media-segments.queries.js');
            const { getTaskSettings } =
                await import('$lib/server/database/queries/task-settings.queries.js');
            vi.mocked(getTaskSettings).mockResolvedValue({
                suppressFirstEpisodeIntro: true,
            });
            vi.mocked(getSegmentsByMediaId).mockResolvedValue([INTRO_ROW]);
            vi.mocked(getEpisodeInfo).mockResolvedValue({
                media_type: 'episode',
                episode_number: 5,
            });
            const { createMediaSegmentsService } = await import('./media-segments.service.js');
            const service = createMediaSegmentsService({} as never);
            const result = await service.getSegments('ep5-uuid');
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('Intro');
        });

        it('passes Intro through when flag is off and item is episode 1', async () => {
            const { getSegmentsByMediaId, getEpisodeInfo } =
                await import('$lib/server/database/queries/media-segments.queries.js');
            const { getTaskSettings } =
                await import('$lib/server/database/queries/task-settings.queries.js');
            vi.mocked(getTaskSettings).mockResolvedValue({
                suppressFirstEpisodeIntro: false,
            });
            vi.mocked(getSegmentsByMediaId).mockResolvedValue([INTRO_ROW]);
            vi.mocked(getEpisodeInfo).mockResolvedValue({
                media_type: 'episode',
                episode_number: 1,
            });
            const { createMediaSegmentsService } = await import('./media-segments.service.js');
            const service = createMediaSegmentsService({} as never);
            const result = await service.getSegments('ep1-uuid');
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('Intro');
        });

        it('passes Intro through for a movie regardless of flag', async () => {
            const { getSegmentsByMediaId, getEpisodeInfo } =
                await import('$lib/server/database/queries/media-segments.queries.js');
            const { getTaskSettings } =
                await import('$lib/server/database/queries/task-settings.queries.js');
            vi.mocked(getTaskSettings).mockResolvedValue({
                suppressFirstEpisodeIntro: true,
            });
            vi.mocked(getSegmentsByMediaId).mockResolvedValue([INTRO_ROW]);
            vi.mocked(getEpisodeInfo).mockResolvedValue({
                media_type: 'movie',
                episode_number: null,
            });
            const { createMediaSegmentsService } = await import('./media-segments.service.js');
            const service = createMediaSegmentsService({} as never);
            const result = await service.getSegments('movie-uuid');
            expect(result).toHaveLength(1);
            expect(result[0].type).toBe('Intro');
        });
    });
});
