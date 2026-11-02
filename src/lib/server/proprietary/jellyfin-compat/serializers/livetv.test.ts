// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { programFlagsForCategory, serializeChannel, serializeProgram } from './livetv';
import type { LiveTvChannel, LiveTvFeedProgram } from '$lib/schemas/livetv';

const baseChannel: LiveTvChannel = {
    images: {},
    id: 'channel-uuid',
    name: 'VDD',
    sortOrder: 1,
    isVisible: true,
};

const baseProgram: LiveTvFeedProgram = {
    id: 'program-uuid',
    channelId: 'channel-uuid',
    title: 'Breaking News',
    startTime: '2030-01-01T10:00:00.000Z',
    endTime: '2030-01-01T11:00:00.000Z',
};

describe('serializeChannel', () => {
    it('serializes basic channel fields', () => {
        const result = serializeChannel(baseChannel);
        expect(result.Name).toBe('VDD');
        expect(result.Id).toBe('channel-uuid');
        expect(result.Type).toBe('TvChannel');
        expect(result.Number).toBe('1');
        expect(result.MediaType).toBe('Video');
        expect((result.UserData as Record<string, unknown>).IsFavorite).toBe(false);
    });

    it('supplies a source before Android TV scans its forced audio language', () => {
        const channel = { ...baseChannel, id: '11111111-1111-4111-8111-111111111111' };
        const result = serializeChannel(channel);
        const sources = result.MediaSources as Array<{
            Id: string;
            MediaStreams: Array<{ Language?: string }>;
        }>;
        expect(sources).toHaveLength(1);
        expect(sources[0]).toMatchObject({
            Id: channel.id,
            Container: 'mpegts',
            Protocol: 'Http',
            Type: 'Default',
            IsLiveTv: true,
            IsInfiniteStream: true,
            SupportsDirectPlay: false,
            SupportsDirectStream: false,
            SupportsTranscoding: true,
            TranscodingSubProtocol: 'hls',
        });
        // Android TV does this scan before requesting PlaybackInfo. Neither the
        // source nor its streams list may be null, even without a live session.
        expect(sources[0].MediaStreams.filter((stream) => stream.Language === 'eng')).toEqual([]);
        for (const field of ['Path', 'TranscodingUrl', 'DirectStreamUrl', 'LiveStreamId']) {
            expect(sources[0]).not.toHaveProperty(field);
        }
    });

    it('sets empty ImageTags when no primary image', () => {
        const result = serializeChannel(baseChannel);
        expect(result.ImageTags).toEqual({});
    });

    it('sets Primary ImageTag when a primary image is present', () => {
        const result = serializeChannel({
            ...baseChannel,
            images: {
                primary: { href: 'http://example.com/logo.png', revision: '0', source: 'self' },
            },
        });
        expect((result.ImageTags as Record<string, string>)['Primary']).toBe('0');
    });

    it('includes CurrentProgram when present', () => {
        const result = serializeChannel({
            ...baseChannel,
            currentProgram: baseProgram,
        });
        expect(result.CurrentProgram).toBeDefined();
        expect((result.CurrentProgram as Record<string, unknown>)?.Name).toBe('Breaking News');
    });

    it('omits CurrentProgram when absent', () => {
        const result = serializeChannel(baseChannel);
        expect(result.CurrentProgram).toBeUndefined();
    });

    // sortOrder is a WITHIN-CATEGORY ordering key that restarts at 0 for every
    // category, so it is not a usable channel number — prod has 9 categories and
    // therefore up to 9 channels sharing each value. Callers pass the channel's
    // global position instead.
    it('uses the supplied channel number over sortOrder', () => {
        const result = serializeChannel({ ...baseChannel, sortOrder: 0 }, 130);
        expect(result.Number).toBe('130');
    });

    it('falls back to sortOrder when no channel number is supplied', () => {
        const result = serializeChannel({ ...baseChannel, sortOrder: 7 });
        expect(result.Number).toBe('7');
    });

    it('sets favorite state in UserData when supplied', () => {
        const result = serializeChannel(baseChannel, 1, true);
        expect((result.UserData as Record<string, unknown>).IsFavorite).toBe(true);
    });

    it("flags CurrentProgram.IsMovie from the channel's own admin-configured category", () => {
        const result = serializeChannel({
            ...baseChannel,
            category: 'Movies',
            currentProgram: baseProgram,
        });
        expect((result.CurrentProgram as Record<string, unknown>)?.IsMovie).toBe(true);
    });
});

describe('serializeProgram', () => {
    it('serializes basic program fields', () => {
        const result = serializeProgram(baseProgram, 'VDD');
        expect(result.Name).toBe('Breaking News');
        expect(result.Id).toBe('program-uuid');
        expect(result.ChannelId).toBe('channel-uuid');
        expect(result.ChannelName).toBe('VDD');
        expect(result.Type).toBe('Program');
    });

    it('sets IsLive=true when isLive param is true regardless of timestamps', () => {
        const pastProgram: LiveTvFeedProgram = {
            ...baseProgram,
            startTime: '2000-01-01T00:00:00.000Z',
            endTime: '2000-01-01T01:00:00.000Z',
        };
        const result = serializeProgram(pastProgram, 'VDD', true);
        expect(result.IsLive).toBe(true);
    });

    it('sets IsLive=false when isLive param is false regardless of timestamps', () => {
        const futureProgram: LiveTvFeedProgram = {
            ...baseProgram,
            startTime: '2040-01-01T00:00:00.000Z',
            endTime: '2040-01-01T01:00:00.000Z',
        };
        const result = serializeProgram(futureProgram, 'VDD', false);
        expect(result.IsLive).toBe(false);
    });

    it('computes IsLive from timestamps when param is omitted (past program = not live)', () => {
        const pastProgram: LiveTvFeedProgram = {
            ...baseProgram,
            startTime: '2000-01-01T00:00:00.000Z',
            endTime: '2000-01-01T01:00:00.000Z',
        };
        const result = serializeProgram(pastProgram, 'VDD');
        expect(result.IsLive).toBe(false);
    });

    it('computes IsLive from timestamps when param is omitted (future program = not live)', () => {
        const futureProgram: LiveTvFeedProgram = {
            ...baseProgram,
            startTime: '2040-01-01T00:00:00.000Z',
            endTime: '2040-01-01T01:00:00.000Z',
        };
        const result = serializeProgram(futureProgram, 'VDD');
        expect(result.IsLive).toBe(false);
    });

    it('includes genres when present', () => {
        const result = serializeProgram({ ...baseProgram, genres: ['News', 'Politics'] }, 'VDD');
        expect(result.Genres).toEqual(['News', 'Politics']);
    });

    it('defaults to empty genres array when absent', () => {
        const result = serializeProgram(baseProgram, 'VDD');
        expect(result.Genres).toEqual([]);
    });

    it('defaults all content-type flags to false when no channel category is given', () => {
        const result = serializeProgram(baseProgram, 'VDD');
        expect(result.IsMovie).toBe(false);
        expect(result.IsSports).toBe(false);
        expect(result.IsKids).toBe(false);
        expect(result.IsNews).toBe(false);
    });

    it('sets IsMovie from an admin-configured "Movies" channel category', () => {
        const result = serializeProgram(baseProgram, 'VDD', undefined, false, 'Movies');
        expect(result.IsMovie).toBe(true);
        expect(result.IsSports).toBe(false);
    });

    it('sets IsSports from an admin-configured "Sports" channel category', () => {
        const result = serializeProgram(baseProgram, 'VDD', undefined, false, 'Sports');
        expect(result.IsSports).toBe(true);
        expect(result.IsMovie).toBe(false);
    });

    it('does not flag an unrelated bouquet category like "Orb" or "MTK+ Event"', () => {
        const result = serializeProgram(baseProgram, 'VDD', undefined, false, 'Orb');
        expect(result.IsMovie).toBe(false);
        expect(result.IsSports).toBe(false);
        expect(result.IsKids).toBe(false);
        expect(result.IsNews).toBe(false);
    });
});

describe('Program DTOs carry the fields Jellyfin clients dereference without a null check', () => {
    // jellyfin-androidtv's FullDetailsFragment.addButtons() reads
    // baseItem.getUserData().getPlayedPercentage() for every playable item. Real
    // Jellyfin always attaches UserData to a program, so the app never guards it —
    // a program without UserData crashes the app with a NullPointerException the
    // moment its details page opens (prod: three crashes in 15 minutes on the
    // "On Now" row, 2026-09-13).
    it('serializeProgram attaches a zeroed UserData block keyed by the program id', () => {
        const result = serializeProgram(baseProgram, 'VDD');
        expect(result.UserData).toEqual({
            PlaybackPositionTicks: 0,
            PlayedPercentage: 0,
            Played: false,
            IsFavorite: false,
            PlayCount: 0,
            Key: 'program-uuid',
            ItemId: 'program-uuid',
        });
    });

    it('serializeProgram derives RunTimeTicks from the listing duration', () => {
        // 1 hour = 3600 s × 10,000,000 ticks/s
        const result = serializeProgram(baseProgram, 'VDD');
        expect(result.RunTimeTicks).toBe(36_000_000_000);
    });

    it('serializeChannel gives CurrentProgram the same UserData and RunTimeTicks', () => {
        const result = serializeChannel({ ...baseChannel, currentProgram: baseProgram });
        const current = result.CurrentProgram as Record<string, unknown>;
        expect(current.UserData).toEqual({
            PlaybackPositionTicks: 0,
            PlayedPercentage: 0,
            Played: false,
            IsFavorite: false,
            PlayCount: 0,
            Key: 'program-uuid',
            ItemId: 'program-uuid',
        });
        expect(current.RunTimeTicks).toBe(36_000_000_000);
    });
});

describe('programFlagsForCategory', () => {
    it('returns all-false for undefined category', () => {
        expect(programFlagsForCategory(undefined)).toEqual({
            IsMovie: false,
            IsSports: false,
            IsKids: false,
            IsNews: false,
        });
    });

    it('matches German bouquet names (Filme, Kinder, Nachrichten)', () => {
        expect(programFlagsForCategory('Filme').IsMovie).toBe(true);
        expect(programFlagsForCategory('Kinder').IsKids).toBe(true);
        expect(programFlagsForCategory('Nachrichten').IsNews).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(programFlagsForCategory('SPORTS').IsSports).toBe(true);
        expect(programFlagsForCategory('kids').IsKids).toBe(true);
    });
});
