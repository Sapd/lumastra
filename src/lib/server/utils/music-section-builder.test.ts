// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { toMusicTrack } from '$lib/server/services/music/track-projection.js';
import {
    buildBecauseYouListenedSection,
    buildGenreTrackSection,
    buildMoodShelfSection,
    buildNewForYouSection,
    buildQuickPicksSection,
    buildSmartMixSection,
    buildSonicFingerprintSection,
} from './music-section-builder.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';

const TRACK = {
    id: 't1',
    bucket: 'heavy-rotation',
    title: 'Track One',
    artist_title: 'Some Artist',
    artist_id: 'ar1',
    album_id: 'al1',
} as never;

describe('buildQuickPicksSection', () => {
    it('defaults to internal-surface image URLs (existing page caller relies on this)', () => {
        const section = buildQuickPicksSection([TRACK]);
        expect(section?.items[0].image).toContain('/api/media/t1/images/poster');
        expect(section?.items[0].image).not.toContain('/api/v1/');
    });

    it('emits v1-surface image URLs when surface is explicitly "v1"', () => {
        const section = buildQuickPicksSection([TRACK], 'v1');
        expect(section?.items[0].image).toContain('/api/v1/media/t1/images/poster');
        expect(section?.items[0].id).toBe('t1');
        expect(section?.items[0].itemKey).toBe('qp:heavy-rotation:t1');
        expect(section?.items[0].externalIds?.internal).toBeUndefined();
    });
});

describe('buildBecauseYouListenedSection', () => {
    const SOURCE = { title: 'Seed Song', artist: 'Artist' };
    const REC = {
        id: 'rec1',
        title: 'Rec',
        artist_id: 'ar1',
        artist_title: 'Other',
        album_id: 'al1',
        similarity: 0.9,
    } as never;

    it('carries the surface-resolved ImageSet on each item and derives image from it', () => {
        const images = new Map<string, ImageSet>([
            [
                'rec1',
                {
                    primary: {
                        href: '/api/v1/media/rec1/images/primary?v=r1',
                        revision: 'r1',
                        source: 'self' as const,
                        variants: { thumb: '/api/v1/media/rec1/images/primary?size=thumb&v=r1' },
                    },
                },
            ],
        ]);
        const item = buildBecauseYouListenedSection(SOURCE, [REC], images)?.items[0];
        expect(item?.images).toEqual(images.get('rec1'));
        expect(item?.image).toBe('/api/v1/media/rec1/images/primary?size=thumb&v=r1');
        expect(item?.image).not.toContain('/api/media/');
    });

    it('emits an empty image and images object when no ImageSet resolved for an item', () => {
        const item = buildBecauseYouListenedSection(SOURCE, [REC], new Map())?.items[0];
        expect(item?.image).toBe('');
        expect(item?.images).toEqual({});
    });
});

describe('surface-resolved ImageSets on the other music sections', () => {
    const THUMB = '/api/v1/media/t1/images/primary?size=thumb&v=r1';
    const IMAGE_SET: ImageSet = {
        primary: {
            href: '/api/v1/media/t1/images/primary?v=r1',
            revision: 'r1',
            source: 'self' as const,
            variants: { thumb: THUMB },
        },
    };
    const IMAGES = new Map<string, ImageSet>([['t1', IMAGE_SET]]);
    const ROW = {
        id: 't1',
        title: 'Track',
        artist_id: 'ar1',
        artist_title: 'Artist',
        album_id: 'al1',
        similarity: 0.8,
    } as never;

    it.each([
        ['new-for-you', () => buildNewForYouSection([ROW], IMAGES)],
        ['mood-shelf', () => buildMoodShelfSection({ genre: 'chill' } as never, [ROW], IMAGES)],
        [
            'smart-mix',
            () => buildSmartMixSection({ genre: 'rock', tracks: [ROW] } as never, IMAGES),
        ],
        ['genre', () => buildGenreTrackSection('Rock', [ROW], IMAGES)],
    ])('%s items carry the ImageSet and derive image from it', (_name, build) => {
        const item = build()?.items[0];
        expect(item?.images).toEqual(IMAGE_SET);
        expect(item?.image).toBe(THUMB);
        expect(item?.image).not.toContain('/api/media/');
    });

    it.each([
        ['new-for-you', () => buildNewForYouSection([ROW], new Map())],
        ['mood-shelf', () => buildMoodShelfSection({ genre: 'chill' } as never, [ROW], new Map())],
        [
            'smart-mix',
            () => buildSmartMixSection({ genre: 'rock', tracks: [ROW] } as never, new Map()),
        ],
        ['genre', () => buildGenreTrackSection('Rock', [ROW], new Map())],
    ])('%s emits an empty image and images object when no ImageSet resolved', (_name, build) => {
        const item = build()?.items[0];
        expect(item?.image).toBe('');
        expect(item?.images).toEqual({});
    });
});

it('preserves resolved owner, revision and surface on sonic fingerprint cards', () => {
    const images = {
        primary: {
            href: '/api/v1/media/album/images/poster?size=card&v=cover-revision',
            revision: 'cover-revision',
            source: 'album' as const,
        },
    };
    const track = toMusicTrack({ id: 'track', title: 'Track', custom_metadata: null }, images);
    expect(buildSonicFingerprintSection([track])?.items[0].image).toBe(images.primary.href);
});

it('preserves empty canonical performer credits on sonic fingerprint cards', () => {
    const track = toMusicTrack(
        {
            id: 'track',
            title: 'Song (Cascada remix)',
            custom_metadata: { track_artist_credits: [], artist: 'Stale Performer' },
            track_artists: [],
            remixer_artists: [{ id: 'remixer-id', title: 'Cascada' }],
        },
        {},
    );
    const card = buildSonicFingerprintSection([track])?.items[0];
    expect(card?.artists).toEqual([]);
    expect(card?.clickData?.artistId).toBeUndefined();
    expect(card?.remixerArtists).toEqual([{ id: 'remixer-id', title: 'Cascada' }]);
});

it('does not crash on sonic fingerprint tracks without an artists array', () => {
    const track = { id: 'track', title: 'T', images: {} } as unknown as Parameters<
        typeof buildSonicFingerprintSection
    >[0][number];
    const card = buildSonicFingerprintSection([track])?.items[0];
    expect(card?.artists).toEqual([]);
    expect(card?.clickData?.artistId).toBeUndefined();
});
