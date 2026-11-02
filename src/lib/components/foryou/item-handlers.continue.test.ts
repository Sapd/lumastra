// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A Continue Watching ▶ on an in-progress episode enters continue mode: it
 * goes to `/watch/<seriesId>`, whose redirect resolves the series watch marker,
 * instead of pinning the row's episode. Movies still go to their own id.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
    navigateToWatch,
    openMediaModal,
    getMediaDetailsByQuery,
    getMovieDetails,
    handleRequestAction,
} = vi.hoisted(() => ({
    navigateToWatch: vi.fn(async (_key: string, _type?: unknown, _opts?: unknown) => {}),
    openMediaModal: vi.fn(),
    getMediaDetailsByQuery: vi.fn(),
    getMovieDetails: vi.fn(),
    handleRequestAction: vi.fn(),
}));

vi.mock('$lib/stores/watch-navigation', () => ({
    navigateToWatch: (key: string, type?: unknown, opts?: unknown) =>
        navigateToWatch(key, type, opts),
    getWatchUrl: (key: string) => `/watch/${key}`,
}));
vi.mock('$lib/utils/modal-utils', () => ({
    openMediaModal: (...args: unknown[]) => openMediaModal(...args),
    handleRequestAction: (...args: unknown[]) => handleRequestAction(...args),
    openAlbumForTrack: vi.fn(),
}));
vi.mock('$lib/api/content', () => ({
    getMediaDetailsByQuery: (...args: unknown[]) => getMediaDetailsByQuery(...args),
    getMovieDetails: (...args: unknown[]) => getMovieDetails(...args),
}));
vi.mock('$lib/services/audiobook-playback', () => ({
    playAudiobook: vi.fn(async () => true),
    audiobookStartFailureMessage: () => 'could not start',
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
vi.mock('$lib/stores/music-player.store', () => ({
    musicPlayerStore: { play: vi.fn() },
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import { entryForSection, handleItemClick, handleItemPlay } from './item-handlers';
import type { PageSection, UniversalMediaItem } from '$lib/types/server-driven-ui';

const SERIES_UUID = '99999999-8888-4777-8666-555555555555';
const EPISODE_UUID = '12121212-3434-4565-8787-909090909090';
const MOVIE_UUID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const section = { id: 'continue-watching', type: 'standard' } as unknown as PageSection;

function play(item: UniversalMediaItem): void {
    handleItemPlay({ section, item }, false, '', false);
}

const base = {
    title: 'x',
    image: '/img',
    isAvailable: true,
    hasFiles: true,
    canRequest: false,
};

describe('handleItemPlay — continue mode', () => {
    beforeEach(() => {
        navigateToWatch.mockClear();
        openMediaModal.mockClear();
        getMediaDetailsByQuery.mockReset();
        getMovieDetails.mockReset();
        handleRequestAction.mockReset();
    });

    test('an in-progress CW episode with a seriesId navigates to /watch/<seriesId>', () => {
        play({
            ...base,
            id: EPISODE_UUID,
            externalIds: { internal: EPISODE_UUID },
            mediaType: 'episode',
            seriesId: SERIES_UUID,
            progress: 40,
        });
        expect(navigateToWatch).toHaveBeenCalledWith(SERIES_UUID, undefined, { entry: 'explicit' });
    });

    test('a movie navigates to /watch/<movieId>', () => {
        play({
            ...base,
            id: MOVIE_UUID,
            externalIds: { internal: MOVIE_UUID },
            mediaType: 'movie',
            progress: 40,
        });
        expect(navigateToWatch).toHaveBeenCalledWith(MOVIE_UUID, undefined, { entry: 'explicit' });
    });

    test('a retained internal ID does not make an explicitly unavailable item playable', () => {
        play({
            ...base,
            id: MOVIE_UUID,
            externalIds: { internal: MOVIE_UUID },
            mediaType: 'movie',
            isAvailable: false,
        });
        expect(navigateToWatch).not.toHaveBeenCalled();
    });

    test('an unavailable requestable catalog item opens request flow, not video navigation', () => {
        handleItemPlay(
            {
                section,
                item: {
                    ...base,
                    id: MOVIE_UUID,
                    externalIds: { tmdb: '603', internal: MOVIE_UUID },
                    mediaType: 'movie',
                    isAvailable: false,
                    canRequest: true,
                } as UniversalMediaItem,
            },
            true,
            'https://requests.example',
            true,
        );

        expect(handleRequestAction).toHaveBeenCalledWith(
            expect.objectContaining({
                externalIds: { tmdb: '603', internal: MOVIE_UUID },
                mediaType: 'movie',
            }),
            true,
            'https://requests.example',
            true,
        );
        expect(navigateToWatch).not.toHaveBeenCalled();
    });

    test('fresh false availability and requestability override cached card true values', async () => {
        getMediaDetailsByQuery.mockResolvedValue({
            data: {
                type: 'movie',
                ids: { internal: MOVIE_UUID },
                isAvailable: false,
                canRequest: false,
            },
        });
        await handleItemClick({
            section,
            item: {
                ...base,
                id: MOVIE_UUID,
                externalIds: { internal: MOVIE_UUID },
                mediaType: 'movie',
                isAvailable: true,
                canRequest: true,
            } as UniversalMediaItem,
        });
        expect(openMediaModal).toHaveBeenCalledWith(
            expect.objectContaining({ isAvailable: false, canRequest: false }),
            expect.any(String),
        );
    });

    test('fresh parent-series details can mark an unavailable item requestable', async () => {
        getMovieDetails.mockResolvedValue({
            data: {
                ids: { internal: SERIES_UUID },
                type: 'series',
                isAvailable: false,
                canRequest: true,
            },
        });
        await handleItemClick({
            section,
            item: {
                ...base,
                id: EPISODE_UUID,
                externalIds: { internal: EPISODE_UUID },
                mediaType: 'episode',
                seriesId: SERIES_UUID,
                isAvailable: true,
                canRequest: false,
            } as UniversalMediaItem,
        });
        expect(openMediaModal).toHaveBeenCalledWith(
            expect.objectContaining({ isAvailable: false, canRequest: true }),
            expect.any(String),
        );
    });

    test('failed detail fetch keeps cached false availability despite an internal ID', async () => {
        getMediaDetailsByQuery.mockRejectedValue(new Error('offline'));
        await handleItemClick({
            section,
            item: {
                ...base,
                id: MOVIE_UUID,
                externalIds: { internal: MOVIE_UUID },
                mediaType: 'movie',
                isAvailable: false,
            } as UniversalMediaItem,
        });
        expect(openMediaModal).toHaveBeenCalledWith(
            expect.objectContaining({ isAvailable: false }),
            expect.any(String),
        );
    });

    test('an episode with no resume progress keeps its own episode', () => {
        play({
            ...base,
            id: EPISODE_UUID,
            externalIds: { internal: EPISODE_UUID },
            mediaType: 'episode',
            seriesId: SERIES_UUID,
            isNextUp: true,
        });
        expect(navigateToWatch).toHaveBeenCalledWith(EPISODE_UUID, undefined, {
            entry: 'explicit',
        });
    });
});

describe('entryForSection — the resume-handoff entry of a rail card', () => {
    const item = {
        ...base,
        id: EPISODE_UUID,
        mediaType: 'episode',
    } as unknown as UniversalMediaItem;
    const of = (type: string) => ({ id: type, type }) as unknown as PageSection;

    test('Continue Watching with progress is a resume, without progress a next_up', () => {
        expect(entryForSection(of('continue-watching'), { ...item, progress: 40 })).toBe('resume');
        expect(entryForSection(of('next-up'), { ...item, progress: 0 })).toBe('next_up');
    });

    test('any other rail is an explicit pick', () => {
        expect(entryForSection(of('carousel'), { ...item, progress: 40 })).toBe('explicit');
    });

    test('a Next Up card hands its entry to the navigation', () => {
        navigateToWatch.mockClear();
        handleItemPlay(
            {
                section: of('next-up'),
                item: {
                    ...base,
                    id: EPISODE_UUID,
                    mediaType: 'episode',
                    externalIds: { internal: EPISODE_UUID },
                } as unknown as UniversalMediaItem,
            },
            false,
            '',
            false,
        );
        expect(navigateToWatch).toHaveBeenCalledWith(expect.any(String), undefined, {
            entry: 'next_up',
        });
    });
});
