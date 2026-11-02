// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { SeriesEpisodeRow } from '$lib/server/database/queries/episode-detail.queries.js';
const mock = vi.hoisted(() => ({ episodes: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
// The episode list resolves durations through the batch query; the empty fake sql
// above cannot run it, and these tests do not assert durations.
vi.mock('$lib/server/database/queries/media-items.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        findPlaybackDurationsMs: vi.fn(async () => new Map<string, number>()),
    };
});
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));
vi.mock('./resolve-series-id.js', () => ({
    resolveSeriesId: vi.fn().mockResolvedValue('11111111-1111-4111-8111-111111111111'),
}));
vi.mock('$lib/server/database/queries/episode-detail.queries.js', () => ({
    getSeriesEpisodesWithWatchState: mock.episodes,
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: vi.fn(),
    searchAccessBoundary: () => ({ library: { kind: 'all' }, age: { kind: 'any' } }),
}));
vi.mock('$lib/server/services/image-descriptor/resolver.js', () => ({
    resolveImageSets: vi.fn().mockResolvedValue(new Map()),
}));
import { def, episodePreview, EpisodesQuery } from './episodes.js';
import { EpisodeNodeSchema } from '$lib/schemas/api-series-responses.js';
import { MediaPreviewSchema } from '$lib/schemas/api-media-preview.js';
const series = '11111111-1111-4111-8111-111111111111';
const row: SeriesEpisodeRow = {
    id: '22222222-2222-4222-8222-222222222222',
    season_id: '33333333-3333-4333-8333-333333333333',
    title: 'Combined',
    overview: null,
    season_number: 2,
    episode_number: 4,
    episode_number_end: 5,
    runtime_seconds: 3600,
    premiere_date: null,
    series_id: series,
    series_tmdb_id: null,
    primary_ext_id: null,
    imdb_id: null,
    series_name: 'Example',
    is_watched: false,
    resume_position_ms: 900000,
    runtime_ms: null,
    last_watched_at: null,
    last_event_at: null,
    audio_languages: [],
    subtitle_languages: [],
    has_file: false,
    segments: null,
    ordering: 'dvd',
    absolute_number: 27,
    previous_id: 'previous',
    next_id: 'next',
};
function event(query = '', params: Record<string, string> = {}): RequestEvent {
    return {
        params: { id: series, ...params },
        locals: { user: {} },
        url: new URL(`http://localhost/api/v1/series/${series}/episodes${query}`),
    } as unknown as RequestEvent;
}
const ctx = { surface: 'v1' as const };
beforeEach(() => {
    mock.episodes.mockResolvedValue([row]);
});
describe('package 11 episode preview and direct lookup', () => {
    it('is a MediaPreview with typed context, honest availability and PlaybackProgress', () => {
        const item = episodePreview(row, {});
        expect(MediaPreviewSchema.safeParse(item).success).toBe(true);
        expect(item.context).toMatchObject({
            seasonId: `vseason:${series}:dvd:2`,
            episodeNumber: 4,
            endEpisodeNumber: 5,
            absoluteNumber: 27,
            previousId: 'previous',
            nextId: 'next',
        });
        expect(item.progress?.fraction).toBe(0.25);
        expect(item.availability).toEqual({
            isAvailable: false,
            hasFile: false,
            canRequest: false,
        });
        expect(item.ids).not.toHaveProperty('internal');
    });
    it('preserves languages and combined episode titles through response validation', async () => {
        const metadata = {
            audioLanguages: ['jpn', 'deu'],
            subtitleLanguages: ['deu', 'eng'],
            segments: [
                { episodeNumber: 4, title: 'Part one' },
                { episodeNumber: 5, title: 'Part two' },
            ],
        };
        mock.episodes.mockResolvedValue([
            {
                ...row,
                audio_languages: metadata.audioLanguages,
                subtitle_languages: metadata.subtitleLanguages,
                segments: metadata.segments,
            },
        ]);
        const response = await def.handlers.GET!(event(), ctx);
        expect(response.status).toBe(200);
        const body = await response.json();
        const { EpisodesCollectionResponseSchema } =
            await import('$lib/schemas/api-series-responses.js');
        expect(EpisodesCollectionResponseSchema.parse(body).items[0]).toMatchObject(metadata);
        expect(EpisodeNodeSchema.parse(body.items[0])).toMatchObject(metadata);
    });
    it.each(['4', '5'])(
        'direct E%s returns one preview and forwards the span coordinate',
        async (e) => {
            const response = await def.handlers.GET!(event('', { n: '2', e }), ctx);
            expect(response.status).toBe(200);
            expect(await response.json()).toMatchObject({
                id: row.id,
                context: { episodeNumber: 4, endEpisodeNumber: 5 },
            });
            expect(mock.episodes).toHaveBeenLastCalledWith(
                expect.anything(),
                series,
                undefined,
                2,
                expect.objectContaining({ episode: Number(e), limit: 2 }),
            );
        },
    );
    it('direct lookup is 404 when the coordinate does not exist', async () => {
        mock.episodes.mockResolvedValue([]);
        expect((await def.handlers.GET!(event('', { n: '2', e: '9' }), ctx)).status).toBe(404);
    });
    it('forwards filters/paging and computes hasMore from the extra row', async () => {
        mock.episodes.mockResolvedValue([row, { ...row, id: 'extra' }]);
        const response = await def.handlers.GET!(
            event('?limit=1&offset=3&specials=exclude&season=2&episode=5'),
            ctx,
        );
        expect(await response.json()).toMatchObject({
            items: [{ id: row.id }],
            page: { limit: 1, offset: 3, hasMore: true },
        });
        expect(mock.episodes).toHaveBeenLastCalledWith(
            expect.anything(),
            series,
            undefined,
            2,
            expect.objectContaining({ limit: 2, offset: 3, specials: 'exclude', episode: 5 }),
        );
    });
    it('validates all paging and specials modes', () => {
        expect(EpisodesQuery.parse({}).specials).toBe('include');
        for (const q of [
            { limit: 101 },
            { offset: -1 },
            { season: -1 },
            { specials: 'bad' },
            { episode: '4junk' },
        ])
            expect(EpisodesQuery.safeParse(q).success).toBe(false);
    });
});

describe('episode node contract accuracy', () => {
    it('accepts the real episode preview with ordering/navigation and no inherited discovery fields', () => {
        const preview = episodePreview(row, {}, 3600000);
        expect(EpisodeNodeSchema.parse(preview)).toEqual(preview);
        expect(preview.context).toMatchObject({
            seasonNumber: 2,
            episodeNumber: 4,
            endEpisodeNumber: 5,
            absoluteNumber: 27,
            previousId: 'previous',
            nextId: 'next',
        });
        expect(EpisodeNodeSchema.shape).not.toHaveProperty('audiobook');
        expect(EpisodeNodeSchema.shape).not.toHaveProperty('score');
        expect(EpisodeNodeSchema.shape).not.toHaveProperty('reason');
        expect(MediaPreviewSchema.shape).toHaveProperty('audiobook');
        expect(MediaPreviewSchema.shape).toHaveProperty('score');
        expect(MediaPreviewSchema.shape).toHaveProperty('reason');
    });
});
