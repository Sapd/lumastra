// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicTrackFromCard } from '$lib/utils/music-track';

import { describe, expect, it } from 'vitest';
import type { MusicTrack } from '$lib/schemas/music';
import type { RadioNowPlaying } from '$lib/schemas/radio';
import { formatNowPlayingTitle } from './now-playing-title';

function track(overrides: Partial<MusicTrack> = {}): MusicTrack {
    return musicTrackFromCard({
        id: 'e6c2b8d0-0000-4000-8000-000000000001',
        type: 'track',
        title: 'Sabotage',
        artists: [{ id: null, title: 'Beastie Boys' }],
        ...overrides,
    });
}

function nowPlaying(trackInfo: RadioNowPlaying['track'] = {}): RadioNowPlaying {
    return {
        stationId: 'e6c2b8d0-0000-4000-8000-0000000000ff',
        fetchedAt: '2026-07-16T10:00:00.000Z',
        source: 'icy',
        track: trackInfo,
        show: {},
        dj: {},
        upNext: {},
    };
}

describe('formatNowPlayingTitle', () => {
    it('shows the playing track and artist', () => {
        expect(formatNowPlayingTitle({ track: track(), isPlaying: true })).toBe(
            '▶ Sabotage · Beastie Boys',
        );
    });

    it('yields the title back to the page when paused', () => {
        expect(formatNowPlayingTitle({ track: track(), isPlaying: false })).toBeNull();
    });

    it('yields the title back to the page when nothing is loaded', () => {
        expect(formatNowPlayingTitle({ track: null, isPlaying: true })).toBeNull();
    });

    it('drops the separator when the artist is unknown', () => {
        expect(
            formatNowPlayingTitle({ track: track({ artists: [{ id: null, title: 'Unknown Artist' }] }), isPlaying: true }),
        ).toBe('▶ Sabotage');
    });

    it('drops the separator when the artist is missing', () => {
        expect(formatNowPlayingTitle({ track: track({ artists: [{ id: null, title: '  ' }] }), isPlaying: true })).toBe(
            '▶ Sabotage',
        );
    });

    it('prefers the song on air over the station name for radio', () => {
        expect(
            formatNowPlayingTitle({
                track: track({ title: 'FIP', artists: [{ id: null, title: 'Radio France' }], isRadio: true }),
                isPlaying: true,
                radioNowPlaying: nowPlaying({ title: 'Luma Luma', artist: 'Bruma Vista' }),
            }),
        ).toBe('▶ Luma Luma · Bruma Vista');
    });

    it('does not pair the on-air song with the station as its artist', () => {
        expect(
            formatNowPlayingTitle({
                track: track({ title: 'FIP', artists: [{ id: null, title: 'Radio France' }], isRadio: true }),
                isPlaying: true,
                radioNowPlaying: nowPlaying({ title: 'Luma Luma' }),
            }),
        ).toBe('▶ Luma Luma');
    });

    it('falls back to the station name when the stream carries no metadata', () => {
        expect(
            formatNowPlayingTitle({
                track: track({ title: 'FIP', artists: [{ id: null, title: 'Radio France' }], isRadio: true }),
                isPlaying: true,
                radioNowPlaying: nowPlaying(),
            }),
        ).toBe('▶ FIP · Radio France');
    });

    it('ignores stale radio metadata on a non-radio track', () => {
        expect(
            formatNowPlayingTitle({
                track: track(),
                isPlaying: true,
                radioNowPlaying: nowPlaying({ title: 'Luma Luma', artist: 'Bruma Vista' }),
            }),
        ).toBe('▶ Sabotage · Beastie Boys');
    });

    it('yields the title back when the track has no name at all', () => {
        expect(formatNowPlayingTitle({ track: track({ title: '' }), isPlaying: true })).toBeNull();
    });
});
