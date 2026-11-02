// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    file: vi.fn(), episode: vi.fn(), series: vi.fn(), count: vi.fn(), type: vi.fn(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/admin-media-id.js', () => ({ adminMediaId: () => 'media' }));
vi.mock('$lib/server/database/queries/episode-chapters.queries.js', () => ({
    getChaptersForFile: mocks.file,
    getChaptersForEpisode: mocks.episode,
    getChaptersForSeries: mocks.series,
    countEpisodesWithChapters: mocks.count,
}));
vi.mock('$lib/server/database/queries/media-items.queries.js', () => ({ getMediaItemType: mocks.type }));
import { def } from './index';

const row = {
    id: 1, file_id: 'file', media_item_id: 'media', chapter_index: 0,
    chapter_name: 'Intro', start_ticks: 12_500_000, end_ticks: 22_500_000,
    source: 'probe', fetched_at: new Date('2026-10-16T00:00:00Z'),
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.type.mockResolvedValue('episode');
    mocks.file.mockResolvedValue([row]);
    mocks.episode.mockResolvedValue([row]);
    mocks.series.mockResolvedValue([row]);
    mocks.count.mockResolvedValue(1);
});

describe('admin chapter milliseconds', () => {
    it('serializes selected-file chapter ticks as millisecond boundaries', async () => {
        const result = await def.handlers.GET!({} as RequestEvent, { input: { query: { fileId: 'file' } } } as never);
        expect(mocks.file).toHaveBeenCalledWith({}, 'file', 'media');
        const body = await result.json();
        expect(body.chapters[0]).toMatchObject({ startMs: 1250, endMs: 2250 });
        expect(body.chapters[0]).not.toHaveProperty('start_ticks');
    });

    it('documents series fileId as ignored by selecting the series branch', async () => {
        mocks.type.mockResolvedValue('tv');
        const result = await def.handlers.GET!({} as RequestEvent, { input: { query: { fileId: 'file' } } } as never);
        expect(mocks.file).not.toHaveBeenCalled();
        expect(mocks.series).toHaveBeenCalledWith({}, 'media');
        expect((await result.json()).chapters[0].startMs).toBe(1250);
    });
});
