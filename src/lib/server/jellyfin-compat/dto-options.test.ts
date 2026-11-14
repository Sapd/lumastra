// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    imageLimit,
    parseDtoOptions,
    parseDtoOptionsFromBody,
    shapeItems,
    shapeItemsResponse,
    wantsField,
} from './dto-options';
import type { JellyfinBaseItemDto } from './types';
import { addSourceDerivedFields, seriesStatus } from './item-details-enrichment';

function opts(query: string): ReturnType<typeof parseDtoOptions> {
    return parseDtoOptions(new URL(`http://localhost/j/Items?${query}`));
}

function episode(): JellyfinBaseItemDto {
    return {
        Name: 'Pilot',
        Id: 'e1',
        ServerId: 's',
        Type: 'Episode',
        Overview: 'It begins.',
        Genres: ['Drama'],
        GenreItems: [{ Name: 'Drama', Id: 'g' }],
        ProviderIds: { Tmdb: '1' },
        Path: '/tv/pilot.mkv',
        ParentId: 'season',
        SortName: '001 - 0001 - pilot',
        Etag: 'etag',
        CanDownload: true,
        PrimaryImageAspectRatio: 16 / 9,
        Chapters: [{ StartPositionTicks: 0, ImageDateModified: '0001-01-01T00:00:00.0000000Z' }],
        MediaSources: [
            {
                Id: 'e1',
                Container: 'mkv',
                Protocol: 'File',
                Type: 'Default',
                IsRemote: false,
                ReadAtNativeFramerate: false,
                IgnoreDts: false,
                IgnoreIndex: false,
                GenPtsInput: false,
                IsInfiniteStream: false,
                RequiresOpening: false,
                RequiresClosing: false,
                SupportsProbing: true,
                RequiresLooping: false,
                HasSegments: false,
                SupportsDirectPlay: true,
                SupportsDirectStream: true,
                SupportsTranscoding: true,
            },
        ],
        ImageTags: { Primary: 'p', Thumb: 't' },
        BackdropImageTags: ['b1', 'b2'],
        ImageBlurHashes: { Primary: { p: 'hash' }, Backdrop: { b1: 'hash' } },
        ParentPrimaryImageItemId: 'season',
        ParentPrimaryImageTag: 'sp',
        ParentLogoItemId: 'series',
        ParentLogoImageTag: 'l',
        ParentBackdropItemId: 'series',
        ParentBackdropImageTags: ['sb'],
        UserData: { PlaybackPositionTicks: 0, PlayCount: 0, IsFavorite: false, Played: false },
        RunTimeTicks: 10,
    } as unknown as JellyfinBaseItemDto;
}

describe('parseDtoOptions', () => {
    it('defaults to everything when nothing is sent', () => {
        const o = opts('');
        expect(o).toEqual({
            fields: null,
            enableImages: true,
            imageTypes: null,
            imageTypeLimit: null,
            enableUserData: true,
            enableTotalRecordCount: true,
        });
        expect(wantsField(o, 'Overview')).toBe(true);
    });

    it('reads every option case-insensitively', () => {
        const o = opts(
            'fields=Overview,PrimaryImageAspectRatio&enableImages=false&ImageTypeLimit=1&EnableImageTypes=Primary,Backdrop&EnableUserData=false&EnableTotalRecordCount=false',
        );
        expect([...(o.fields ?? [])]).toEqual(['overview', 'primaryimageaspectratio']);
        expect(o.enableImages).toBe(false);
        expect(o.imageTypeLimit).toBe(1);
        expect([...(o.imageTypes ?? [])]).toEqual(['primary', 'backdrop']);
        expect(o.enableUserData).toBe(false);
        expect(o.enableTotalRecordCount).toBe(false);
    });

    it('ignores a blank Fields and a bad ImageTypeLimit', () => {
        const o = opts('Fields=&ImageTypeLimit=-3');
        expect(o.fields).toBeNull();
        expect(o.imageTypeLimit).toBeNull();
    });

    it('reads the same options from a POST body', () => {
        const o = parseDtoOptionsFromBody({
            Fields: ['Overview', 'ChannelInfo'],
            EnableImages: false,
            EnableTotalRecordCount: 'false',
        });
        expect([...(o.fields ?? [])]).toEqual(['overview', 'channelinfo']);
        expect(o.enableImages).toBe(false);
        expect(o.enableTotalRecordCount).toBe(false);
        expect(parseDtoOptionsFromBody(null).fields).toBeNull();
    });
});

describe('shapeItems', () => {
    it('without Fields keeps the full shape', () => {
        const item = episode();
        shapeItems([item], opts(''));
        expect(item).toEqual(episode());
    });

    it('Fields=PrimaryImageAspectRatio still returns every field sent before this branch', () => {
        const item = episode();
        Object.assign(item, { DateCreated: '2026-01-01T00:00:00.0000000Z', CanDelete: false });
        shapeItems([item], opts('Fields=PrimaryImageAspectRatio'));
        for (const kept of [
            'Overview',
            'Genres',
            'GenreItems',
            'ProviderIds',
            'Path',
            'ParentId',
            'SortName',
            'DateCreated',
            'Etag',
            'CanDownload',
            'PrimaryImageAspectRatio',
            'Chapters',
        ]) {
            expect(item, kept).toHaveProperty(kept);
        }
        expect(item.ProviderIds).toEqual({ Tmdb: '1' });
        expect(item.Path).toBe('/tv/pilot.mkv');
        expect(item.Overview).toBe('It begins.');
        // Only what this branch added is gated.
        expect(item).not.toHaveProperty('CanDelete');
        // Never shaped: identity, runtime, user data, and MediaSources (Infuse).
        expect(item.Id).toBe('e1');
        expect(item.Type).toBe('Episode');
        expect(item.RunTimeTicks).toBe(10);
        expect(item.UserData).toBeDefined();
        expect(item.MediaSources).toHaveLength(1);
    });

    it('EnableImages=false empties the image tags and drops the parent images', () => {
        const item = episode();
        shapeItems([item], opts('EnableImages=false'));
        expect(item.ImageTags).toEqual({});
        expect(item.BackdropImageTags).toEqual([]);
        expect(item.ImageBlurHashes).toEqual({});
        expect(item).not.toHaveProperty('ParentPrimaryImageTag');
        expect(item).not.toHaveProperty('ParentLogoImageTag');
        expect(item).not.toHaveProperty('ParentBackdropImageTags');
    });

    it('EnableImageTypes and ImageTypeLimit narrow the images', () => {
        const item = episode();
        shapeItems([item], opts('EnableImageTypes=Primary,Backdrop&ImageTypeLimit=1'));
        expect(item.ImageTags).toEqual({ Primary: 'p' });
        expect(item.BackdropImageTags).toEqual(['b1']);
        expect(item.ParentPrimaryImageTag).toBe('sp');
        expect(item.ParentBackdropImageTags).toEqual(['sb']);
        expect(item).not.toHaveProperty('ParentLogoImageTag');
        expect(Object.keys(item.ImageBlurHashes ?? {})).toEqual(['Primary', 'Backdrop']);
        expect(imageLimit(opts('ImageTypeLimit=0'), 'Primary')).toBe(0);
    });

    it('EnableUserData=false drops UserData', () => {
        const item = episode();
        shapeItems([item], opts('EnableUserData=false'));
        expect(item).not.toHaveProperty('UserData');
    });
});

describe('shapeItemsResponse', () => {
    it('EnableTotalRecordCount=false reports the items returned, like Jellyfin', () => {
        const response = shapeItemsResponse(
            { Items: [episode()], TotalRecordCount: 50, StartIndex: 10 },
            opts('EnableTotalRecordCount=false'),
        );
        expect(response.TotalRecordCount).toBe(1);
        expect(response.StartIndex).toBe(10);
    });
});

describe('source-derived fields', () => {
    function withVideo(height: number, sources = 1): JellyfinBaseItemDto {
        const item = episode();
        const source = item.MediaSources![0];
        source.MediaStreams = [
            { Index: 0, Type: 'Video', Width: height * 2, Height: height } as never,
            { Index: 1, Type: 'Audio' } as never,
        ];
        item.MediaSources = Array.from({ length: sources }, () => source);
        return item;
    }

    it('adds Width / Height / IsHD / MediaSourceCount, MediaStreams only on request', () => {
        const hd = withVideo(1080, 2);
        addSourceDerivedFields([hd], { mediaStreams: false });
        expect(hd).toMatchObject({ Width: 2160, Height: 1080, IsHD: true, MediaSourceCount: 2 });
        expect(hd).not.toHaveProperty('MediaStreams');

        const sd = withVideo(480);
        addSourceDerivedFields([sd], { mediaStreams: true });
        expect(sd).not.toHaveProperty('IsHD');
        expect(sd).not.toHaveProperty('MediaSourceCount');
        expect(sd.MediaStreams).toHaveLength(2);
    });

    it('shapeItems gates the derived fields like any other', () => {
        const item = withVideo(720);
        shapeItems([item], opts('Fields=MediaStreams,Height'));
        expect(item.Height).toBe(720);
        expect(item.MediaStreams).toHaveLength(2);
        expect(item).not.toHaveProperty('Width');
        expect(item).not.toHaveProperty('IsHD');
    });
});

describe('seriesStatus', () => {
    it('maps TMDB statuses to Jellyfin SeriesStatus', () => {
        expect(seriesStatus('Returning Series')).toBe('Continuing');
        expect(seriesStatus('Canceled')).toBe('Ended');
        expect(seriesStatus('In Production')).toBe('Unreleased');
        expect(seriesStatus(null)).toBeUndefined();
    });
});
