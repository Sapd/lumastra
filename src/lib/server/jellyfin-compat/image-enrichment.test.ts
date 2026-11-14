// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin DtoService image rules over loaded nodes: own tags only for images
// that exist, series/season/album fallbacks, inherited logo/thumb/backdrop,
// blurhashes keyed by tag.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JellyfinBaseItemDto } from './types';
import type { JellyfinImageNode } from '$lib/server/database/queries/jellyfin-item-images.queries.js';

const { mockGetJellyfinItemImages } = vi.hoisted(() => ({
    mockGetJellyfinItemImages: vi.fn(),
}));
vi.mock('$lib/server/database/queries/jellyfin-item-images.queries.js', () => ({
    getJellyfinItemImages: mockGetJellyfinItemImages,
}));
vi.mock('$lib/server/database/queries/image-descriptor.queries.js', () => ({
    getImageDescriptorOwners: vi.fn().mockResolvedValue([]),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import { config } from '$lib/server/config';
import {
    applyImages,
    currentImageTag,
    enrichItemsWithImages,
    jellyfinImageTag,
} from './image-enrichment';

const SERIES = '11111111-1111-4111-8111-111111111111';
const SEASON = '22222222-2222-4222-8222-222222222222';
const EPISODE = '33333333-3333-4333-8333-333333333333';
const MOVIE = '44444444-4444-4444-8444-444444444444';
const ALBUM = '55555555-5555-4555-8555-555555555555';
const TRACK = '66666666-6666-4666-8666-666666666666';
const ARTIST = '77777777-7777-4777-8777-777777777777';

function node(
    id: string,
    media_type: string,
    over: Partial<JellyfinImageNode> = {},
): JellyfinImageNode {
    return {
        id,
        media_type,
        parent_id: null,
        poster_src: null,
        backdrop_src: null,
        backdrop_meta_src: null,
        logo_src: null,
        thumb_src: null,
        still_src: null,
        poster_blurhash: null,
        backdrop_blurhash: null,
        tmdb_id: null,
        jellyfin_id: null,
        ...over,
    };
}

function dto(id: string, extra: Partial<JellyfinBaseItemDto> = {}): JellyfinBaseItemDto {
    // What the serializer emits from a browse row: a Primary guess for every
    // item and the series fallbacks from series_poster_path.
    return {
        Id: id,
        Name: 'x',
        ServerId: 's',
        Type: 'Movie',
        ImageTags: { Primary: id.replace(/-/g, '').slice(0, 16) },
        BackdropImageTags: [],
        ImageBlurHashes: {},
        PrimaryImageAspectRatio: 0.667,
        ...extra,
    } as JellyfinBaseItemDto;
}

const series = node(SERIES, 'tv', {
    poster_src: '/series.jpg',
    backdrop_src: '/series-bd.jpg',
    backdrop_meta_src: '/series-bd.jpg',
    logo_src: '/series-logo.png',
    thumb_src: '/series-thumb.jpg',
    poster_blurhash: 'LSERIES',
    backdrop_blurhash: 'LSERIESBD',
});
const seasonWithPoster = node(SEASON, 'season', { parent_id: SERIES, poster_src: '/s1.jpg' });
const seasonBare = node(SEASON, 'season', { parent_id: SERIES });

describe('applyImages — episodes', () => {
    it('an episode with a still gets its own Primary and every parent image', () => {
        const ep = node(EPISODE, 'episode', { parent_id: SEASON, still_src: '/still.jpg' });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [seasonWithPoster, series]);

        expect(item.ImageTags).toEqual({
            Primary: jellyfinImageTag(EPISODE, 'Primary', '/still.jpg'),
        });
        expect(item.BackdropImageTags).toEqual([]);
        const seriesPrimary = jellyfinImageTag(SERIES, 'Primary', '/series.jpg');
        expect(item.SeriesPrimaryImageTag).toBe(seriesPrimary);
        // Season poster wins over the series poster for ParentPrimaryImage.
        expect(item.ParentPrimaryImageItemId).toBe(SEASON);
        expect(item.ParentPrimaryImageTag).toBe(jellyfinImageTag(SEASON, 'Primary', '/s1.jpg'));
        // Season has no backdrop/logo/thumb → walk on to the series.
        expect(item.ParentBackdropItemId).toBe(SERIES);
        expect(item.ParentBackdropImageTags).toEqual([
            jellyfinImageTag(SERIES, 'Backdrop', '/series-bd.jpg'),
        ]);
        expect(item.ParentLogoItemId).toBe(SERIES);
        expect(item.ParentLogoImageTag).toBe(jellyfinImageTag(SERIES, 'Logo', '/series-logo.png'));
        expect(item.ParentThumbItemId).toBe(SERIES);
        expect(item.ParentThumbImageTag).toBe(
            jellyfinImageTag(SERIES, 'Thumb', '/series-thumb.jpg'),
        );
        // Jellyfin never sets ParentArt* (art limit 0).
        expect(item).not.toHaveProperty('ParentArtItemId');
    });

    it('an episode without a still gets no Primary; clients fall back to the series poster', () => {
        const ep = node(EPISODE, 'episode', { parent_id: SEASON });
        const item = dto(EPISODE, { Type: 'Episode', PrimaryImageAspectRatio: 16 / 9 });
        applyImages(item, ep, [seasonBare, series]);

        expect(item.ImageTags).toEqual({});
        expect(item.ParentPrimaryImageItemId).toBe(SERIES);
        expect(item.ParentPrimaryImageTag).toBe(item.SeriesPrimaryImageTag);
        // Jellyfin attaches the series poster's ratio when the episode has none.
        expect(item.PrimaryImageAspectRatio).toBe(0.667);
    });

    it("an episode's extracted frame is its Primary still, never its backdrop", () => {
        const ep = node(EPISODE, 'episode', {
            parent_id: SEASON,
            still_src: '/frame.jpg@t',
            backdrop_src: '/frame.jpg@t',
            backdrop_meta_src: null,
        });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [seasonBare, series]);
        expect(item.ImageTags?.Primary).toBeDefined();
        expect(item.BackdropImageTags).toEqual([]);
        expect(item.ParentBackdropItemId).toBe(SERIES);
    });

    it('an own logo / backdrop suppresses the inherited one', () => {
        const ep = node(EPISODE, 'episode', {
            parent_id: SEASON,
            logo_src: '/ep-logo.png',
            backdrop_meta_src: '/ep-bd.jpg',
            backdrop_src: '/ep-bd.jpg',
        });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [seasonBare, series]);
        expect(item.ImageTags?.Logo).toBe(jellyfinImageTag(EPISODE, 'Logo', '/ep-logo.png'));
        expect(item.BackdropImageTags).toEqual([
            jellyfinImageTag(EPISODE, 'Backdrop', '/ep-bd.jpg'),
        ]);
        expect(item).not.toHaveProperty('ParentLogoItemId');
        expect(item).not.toHaveProperty('ParentBackdropItemId');
    });

    it('a series thumb wins over a season thumb (Jellyfin `|| parent is Series`)', () => {
        const season = node(SEASON, 'season', { parent_id: SERIES, thumb_src: '/s-thumb.jpg' });
        const ep = node(EPISODE, 'episode', { parent_id: SEASON });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [season, series]);
        expect(item.ParentThumbItemId).toBe(SERIES);
    });

    it('a series with no images leaves no parent fields and no Primary ratio', () => {
        const bareSeries = node(SERIES, 'tv');
        const ep = node(EPISODE, 'episode', { parent_id: SEASON });
        const item = dto(EPISODE, {
            Type: 'Episode',
            ParentBackdropItemId: SERIES,
            ParentBackdropImageTags: ['stale'],
            ParentPrimaryImageItemId: SERIES,
            ParentPrimaryImageTag: 'stale',
        });
        applyImages(item, ep, [seasonBare, bareSeries]);
        for (const key of [
            'SeriesPrimaryImageTag',
            'ParentPrimaryImageItemId',
            'ParentPrimaryImageTag',
            'ParentBackdropItemId',
            'ParentBackdropImageTags',
            'ParentLogoItemId',
            'ParentThumbItemId',
            'PrimaryImageAspectRatio',
        ]) {
            expect(item, key).not.toHaveProperty(key);
        }
    });
});

describe('applyImages — seasons, series, movies', () => {
    it('a season without its own poster: no Primary, SeriesPrimaryImageTag + parent backdrop', () => {
        const item = dto(SEASON, { Type: 'Season' });
        applyImages(item, seasonBare, [series]);
        expect(item.ImageTags).toEqual({});
        expect(item.SeriesPrimaryImageTag).toBe(jellyfinImageTag(SERIES, 'Primary', '/series.jpg'));
        expect(item.ParentBackdropItemId).toBe(SERIES);
        expect(item.ParentLogoItemId).toBe(SERIES);
    });

    it('a season with a poster keeps its own Primary', () => {
        const item = dto(SEASON, { Type: 'Season' });
        applyImages(item, seasonWithPoster, [series]);
        expect(item.ImageTags?.Primary).toBe(jellyfinImageTag(SEASON, 'Primary', '/s1.jpg'));
    });

    it('a series carries its own tags and inherits nothing', () => {
        const item = dto(SERIES, { Type: 'Series' });
        applyImages(item, series, []);
        expect(item.ImageTags).toEqual({
            Primary: jellyfinImageTag(SERIES, 'Primary', '/series.jpg'),
            Logo: jellyfinImageTag(SERIES, 'Logo', '/series-logo.png'),
            Thumb: jellyfinImageTag(SERIES, 'Thumb', '/series-thumb.jpg'),
            Backdrop: jellyfinImageTag(SERIES, 'Backdrop', '/series-bd.jpg'),
        });
        expect(item.BackdropImageTags).toEqual([item.ImageTags?.Backdrop]);
        expect(item).not.toHaveProperty('SeriesPrimaryImageTag');
        expect(item).not.toHaveProperty('ParentBackdropItemId');
    });

    it('a movie without a poster gets no Primary tag (clients draw their placeholder)', () => {
        const item = dto(MOVIE);
        applyImages(item, node(MOVIE, 'movie'), []);
        expect(item.ImageTags).toEqual({});
        expect(item.BackdropImageTags).toEqual([]);
        expect(item).not.toHaveProperty('PrimaryImageAspectRatio');
    });

    it('a tag changes when the image source changes', () => {
        expect(jellyfinImageTag(MOVIE, 'Primary', '/a.jpg')).not.toBe(
            jellyfinImageTag(MOVIE, 'Primary', '/b.jpg'),
        );
        expect(jellyfinImageTag(MOVIE, 'Primary', '/a.jpg')).toMatch(/^[0-9a-f]{32}$/);
    });
});

describe('applyImages — music', () => {
    const album = node(ALBUM, 'album', { parent_id: ARTIST, poster_src: '/cover.jpg' });
    const artist = node(ARTIST, 'artist', { backdrop_src: '/artist-bd.jpg' });

    it('a track without art carries AlbumPrimaryImageTag and AlbumId', () => {
        const item = dto(TRACK, { Type: 'Audio' });
        applyImages(item, node(TRACK, 'track', { parent_id: ALBUM }), [album, artist]);
        expect(item.ImageTags).toEqual({});
        expect(item.AlbumId).toBe(ALBUM);
        expect(item.AlbumPrimaryImageTag).toBe(jellyfinImageTag(ALBUM, 'Primary', '/cover.jpg'));
        expect(item.ParentBackdropItemId).toBe(ARTIST);
    });

    it('an AlbumId set by the music enrichment is kept', () => {
        const item = dto(TRACK, { Type: 'Audio', AlbumId: 'already-set' });
        applyImages(item, node(TRACK, 'track', { parent_id: ALBUM }), [album, artist]);
        expect(item.AlbumId).toBe('already-set');
    });
});

describe('applyImages — blurhashes', () => {
    it('keys each stored hash by the tag it describes', () => {
        const ep = node(EPISODE, 'episode', { parent_id: SEASON, still_src: '/still.jpg' });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [seasonBare, series]);
        expect(item.ImageBlurHashes).toEqual({
            Primary: { [item.SeriesPrimaryImageTag as string]: 'LSERIES' },
            Backdrop: { [(item.ParentBackdropImageTags as string[])[0]]: 'LSERIESBD' },
        });
    });

    it('an own poster hash is keyed by the own Primary tag', () => {
        const movie = node(MOVIE, 'movie', { poster_src: '/p.jpg', poster_blurhash: 'LMOVIE' });
        const item = dto(MOVIE);
        applyImages(item, movie, []);
        expect(item.ImageBlurHashes).toEqual({
            Primary: { [item.ImageTags?.Primary as string]: 'LMOVIE' },
        });
    });

    it('no stored hash → no ImageBlurHashes entry', () => {
        const movie = node(MOVIE, 'movie', { poster_src: '/p.jpg' });
        const item = dto(MOVIE);
        applyImages(item, movie, []);
        expect(item.ImageBlurHashes).toEqual({});
    });

    it("an episode still never borrows the episode row's poster hash", () => {
        const ep = node(EPISODE, 'episode', {
            parent_id: SEASON,
            still_src: '/still.jpg',
            poster_blurhash: 'LINHERITED',
        });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [seasonBare, node(SERIES, 'tv')]);
        expect(item.ImageBlurHashes).toEqual({});
    });
});

describe('enrichItemsWithImages', () => {
    it('leaves items the lookup does not know (views, playlists) untouched', async () => {
        mockGetJellyfinItemImages.mockResolvedValueOnce({ nodes: new Map(), chains: new Map() });
        const view = dto('not-a-media-item', { ImageTags: { Primary: 'view-tag' } });
        await enrichItemsWithImages({} as never, [view]);
        expect(view.ImageTags).toEqual({ Primary: 'view-tag' });
    });

    it('keeps the serializer tags when the lookup fails', async () => {
        mockGetJellyfinItemImages.mockRejectedValueOnce(new Error('db down'));
        const item = dto(MOVIE);
        await enrichItemsWithImages({} as never, [item]);
        expect(item.ImageTags).toEqual({ Primary: MOVIE.replace(/-/g, '').slice(0, 16) });
    });

    it('applies the chain to each item', async () => {
        const movie = node(MOVIE, 'movie', { poster_src: '/p.jpg' });
        mockGetJellyfinItemImages.mockResolvedValueOnce({
            nodes: new Map([[MOVIE, movie]]),
            chains: new Map([[MOVIE, { itemId: MOVIE, nodeIds: [MOVIE] }]]),
        });
        const item = dto(MOVIE);
        await enrichItemsWithImages({} as never, [item]);
        expect(item.ImageTags).toEqual({ Primary: jellyfinImageTag(MOVIE, 'Primary', '/p.jpg') });
    });
});

describe('applyImages — images the route fetches live (no stored source)', () => {
    afterEach(() => vi.restoreAllMocks());

    it('a movie with only a tmdb id keeps its Primary, backdrop and logo tags', () => {
        const movie = node(MOVIE, 'movie', { tmdb_id: '693134' });
        const item = dto(MOVIE);
        applyImages(item, movie, []);
        expect(item.ImageTags).toEqual({
            Primary: jellyfinImageTag(MOVIE, 'Primary', 'tmdb:693134:poster'),
            Logo: jellyfinImageTag(MOVIE, 'Logo', 'tmdb:693134:logo'),
            Backdrop: jellyfinImageTag(MOVIE, 'Backdrop', 'tmdb:693134:backdrop'),
        });
        expect(item.PrimaryImageAspectRatio).toBe(0.667);
    });

    it('an episode with a tmdb id has its still as Primary, but no own backdrop/logo', () => {
        const ep = node(EPISODE, 'episode', { parent_id: SEASON, tmdb_id: '1' });
        const item = dto(EPISODE, { Type: 'Episode' });
        applyImages(item, ep, [
            node(SEASON, 'season', { parent_id: SERIES, tmdb_id: '2' }),
            series,
        ]);
        expect(item.ImageTags).toEqual({
            Primary: jellyfinImageTag(EPISODE, 'Primary', 'tmdb:1:still'),
        });
        // The season's TMDB poster is its Primary → ParentPrimaryImage.
        expect(item.ParentPrimaryImageItemId).toBe(SEASON);
        expect(item.ParentBackdropItemId).toBe(SERIES);
        expect(item.ParentLogoItemId).toBe(SERIES);
    });

    it('a stored source wins over the live lookup', () => {
        const movie = node(MOVIE, 'movie', { tmdb_id: '9', poster_src: '/p.jpg' });
        const item = dto(MOVIE);
        applyImages(item, movie, []);
        expect(item.ImageTags?.Primary).toBe(jellyfinImageTag(MOVIE, 'Primary', '/p.jpg'));
    });

    it('music never counts a tmdb id (the music chain is local, custom)', () => {
        const item = dto(ALBUM, { Type: 'MusicAlbum' });
        applyImages(item, node(ALBUM, 'album', { tmdb_id: '5' }), []);
        expect(item.ImageTags).toEqual({});
    });

    it('a provider outside IMAGE_PROVIDER_PRIORITY does not count', () => {
        vi.spyOn(config, 'IMAGE_PROVIDER_PRIORITY', 'get').mockReturnValue(['local', 'custom']);
        const item = dto(MOVIE);
        applyImages(item, node(MOVIE, 'movie', { tmdb_id: '1', jellyfin_id: 'abc' }), []);
        expect(item.ImageTags).toEqual({});
    });

    it('a jellyfin id counts only when the Jellyfin provider is enabled', () => {
        const movie = node(MOVIE, 'movie', { jellyfin_id: 'abc' });
        const off = dto(MOVIE);
        applyImages(off, movie, []);
        expect(off.ImageTags).toEqual({});

        vi.spyOn(config, 'IMAGE_PROVIDER_PRIORITY', 'get').mockReturnValue(['local', 'jellyfin']);
        const on = dto(MOVIE);
        applyImages(on, movie, []);
        expect(on.ImageTags?.Primary).toBe(jellyfinImageTag(MOVIE, 'Primary', 'jf:abc:poster'));
    });
});

describe('currentImageTag', () => {
    it('returns the tag the item advertises for that role, null when it has none', async () => {
        const movie = node(MOVIE, 'movie', { poster_src: '/p.jpg' });
        mockGetJellyfinItemImages.mockResolvedValue({
            nodes: new Map([[MOVIE, movie]]),
            chains: new Map([[MOVIE, { itemId: MOVIE, nodeIds: [MOVIE] }]]),
        });
        expect(await currentImageTag({} as never, MOVIE, 'Primary')).toBe(
            jellyfinImageTag(MOVIE, 'Primary', '/p.jpg'),
        );
        expect(await currentImageTag({} as never, MOVIE, 'Logo')).toBeNull();
        expect(await currentImageTag({} as never, SERIES, 'Primary')).toBeNull();
    });

    it('a failed lookup is null (the route then keeps normal caching)', async () => {
        mockGetJellyfinItemImages.mockRejectedValueOnce(new Error('db down'));
        expect(await currentImageTag({} as never, MOVIE, 'Primary')).toBeNull();
    });
});
