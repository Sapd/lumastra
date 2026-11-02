// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('music-metadata', () => ({ parseFile: vi.fn() }));
vi.mock('./vorbis-raw-reader.js', () => ({
    readFlacVorbisCommentsRaw: vi.fn().mockResolvedValue(null),
}));

import { parseFile } from 'music-metadata';
import { parseAudioTags } from './audio-tag-parser.js';

const first = 'a1111111-1111-4111-8111-111111111111';
const second = 'b2222222-2222-4222-8222-222222222222';
const third = 'c3333333-3333-4333-8333-333333333333';

beforeEach(() => {
    vi.mocked(parseFile).mockReset();
});

describe('parseAudioTags artist provider identity evidence', () => {
    it('preserves ordered validated artist IDs alongside the ordered names', async () => {
        vi.mocked(parseFile).mockResolvedValueOnce({
            common: {
                title: 'Fixture Song',
                artist: 'North Lantern',
                artists: ['North Lantern', 'Amber Harbor', 'Silver Meadow'],
                musicbrainz_artistid: [first.toUpperCase(), second, third],
            },
            format: { duration: 2 },
        } as never);
        const tags = await parseAudioTags('/fixtures/ordered-artist-identities.mp3');
        expect(tags.musicbrainzArtistIds).toEqual([first, second, third]);
        expect(tags.artists).toEqual(['North Lantern', 'Amber Harbor', 'Silver Meadow']);
        expect(tags.rawArtistTags).toMatchObject({
            source: 'file',
            musicbrainz_artist_ids: [first, second, third],
            artists: ['North Lantern', 'Amber Harbor', 'Silver Meadow'],
        });
    });

    it('rejects the entire positional mapping when an invalid ID is between valid IDs', async () => {
        vi.mocked(parseFile).mockResolvedValueOnce({
            common: {
                title: 'Fixture Song',
                artist: 'North Lantern',
                artists: ['North Lantern', 'Amber Harbor', 'Silver Meadow'],
                musicbrainz_artistid: [first, 'invalid-middle-identity', third],
            },
            format: { duration: 2 },
        } as never);
        const tags = await parseAudioTags('/fixtures/invalid-middle-artist-identity.mp3');
        expect(tags.artists).toEqual(['North Lantern', 'Amber Harbor', 'Silver Meadow']);
        expect(tags.musicbrainzArtistIds).toEqual([]);
        expect(tags.rawArtistTags?.musicbrainz_artist_ids).toEqual([]);
    });
});
