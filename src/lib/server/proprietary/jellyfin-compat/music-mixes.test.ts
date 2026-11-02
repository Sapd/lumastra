// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Pure helpers behind the /j music endpoints (Instant Mix, genres, lyrics,
// audio HLS, stream.{container}). The routes themselves are covered by
// music-mixes.integration.test.ts and the contract suite.

import { createHash } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { interleaveSeedTracks, parseDtoOptions, parseLimit } from './instant-mix';
import { musicGenreId, musicGenreIdCandidates } from './music-genres';
import { toJellyfinLyricDto } from './lyrics-dto';
import { buildAudioMasterPlaylist, rewriteSegmentUris } from './audio-hls';
import { normalizeContainer, requestedKbps } from './audio-stream-container';
import { isCleanDirectMatch } from './universal-audio';
import { parseExcludeArtistIds } from './music-similar';

const TRACK = { title: 'Song', artist: 'Band', album: 'Record', runtimeSeconds: 200 };

describe('interleaveSeedTracks', () => {
    it('puts a seed track in every fourth slot', () => {
        const out = interleaveSeedTracks(['n1', 'n2', 'n3', 'n4', 'n5', 'n6'], ['s1', 's2']);
        expect(out).toEqual(['n1', 'n2', 'n3', 's1', 'n4', 'n5', 'n6', 's2']);
    });

    it('appends the remaining seeds when neighbours run out', () => {
        expect(interleaveSeedTracks(['n1'], ['s1', 's2'])).toEqual(['n1', 's1', 's2']);
        expect(interleaveSeedTracks([], ['s1'])).toEqual(['s1']);
    });
});

describe('parseLimit / parseDtoOptions', () => {
    it('reads Limit case-insensitively and ignores junk', () => {
        expect(parseLimit(new URL('http://x/?limit=5'))).toBe(5);
        expect(parseLimit(new URL('http://x/?Limit=0'))).toBe(0);
        expect(parseLimit(new URL('http://x/?Limit=-3'))).toBeNull();
        expect(parseLimit(new URL('http://x/?Limit=abc'))).toBeNull();
        expect(parseLimit(new URL('http://x/'))).toBeNull();
    });

    it('defaults EnableImages / EnableUserData to true', () => {
        expect(parseDtoOptions(new URL('http://x/'))).toEqual({
            enableImages: true,
            enableUserData: true,
        });
        expect(
            parseDtoOptions(new URL('http://x/?enableImages=false&EnableUserData=False')),
        ).toEqual({ enableImages: false, enableUserData: false });
    });
});

describe('music genre ids', () => {
    it('is stable and resolvable from every /j spelling', () => {
        expect(musicGenreId('Rock')).toBe(musicGenreId('Rock'));
        expect(musicGenreId('Rock')).toMatch(/^[0-9a-f]{8}-0000-4000-8000-000000000000$/);
        const ids = musicGenreIdCandidates('Rock');
        expect(ids).toContain(musicGenreId('Rock'));
        // GenreItems[].Id on items: md5 of the lowercased name, bare hex.
        const itemHex = createHash('md5').update('rock').digest('hex');
        expect(ids).toContain(itemHex);
        // GET /j/Genres: md5("genre:" + lowercased name) as a UUID.
        const genresHex = createHash('md5').update('genre:rock').digest('hex');
        expect(ids).toContain(
            `${genresHex.slice(0, 8)}-${genresHex.slice(8, 12)}-${genresHex.slice(12, 16)}-${genresHex.slice(16, 20)}-${genresHex.slice(20)}`,
        );
    });
});

describe('toJellyfinLyricDto', () => {
    it('maps synced LRC to ticks and metadata', () => {
        const dto = toJellyfinLyricDto(
            {
                synced: '[ar:LRC Artist]\n[offset:+250]\n[length:3:20]\n[00:01.50]Hello\n[00:03.00]World',
                plain: 'Hello\nWorld',
                source: 'lrclib',
                fetchedAt: null,
            },
            TRACK,
        );
        expect(dto).toEqual({
            Metadata: {
                Artist: 'LRC Artist',
                Album: 'Record',
                Title: 'Song',
                Author: null,
                Length: 200 * 10_000_000,
                By: null,
                Offset: 250 * 10_000,
                Creator: null,
                Version: null,
                IsSynced: true,
            },
            Lyrics: [
                { Text: 'Hello', Start: 15_000_000 },
                { Text: 'World', Start: 30_000_000 },
            ],
        });
    });

    it('serves plain lyrics without Start, keeping inner blank lines', () => {
        const dto = toJellyfinLyricDto(
            { synced: null, plain: '\nVerse one\n\nVerse two\n', source: 'user', fetchedAt: null },
            TRACK,
        );
        expect(dto?.Metadata.IsSynced).toBe(false);
        expect(dto?.Lyrics).toEqual([{ Text: 'Verse one' }, { Text: '' }, { Text: 'Verse two' }]);
    });

    it('falls back to plain when the LRC has no timed lines, null when empty', () => {
        expect(
            toJellyfinLyricDto(
                { synced: '[ar:x]', plain: 'Only line', source: null, fetchedAt: null },
                TRACK,
            )?.Lyrics,
        ).toEqual([{ Text: 'Only line' }]);
        expect(
            toJellyfinLyricDto(
                { synced: null, plain: '  \n ', source: null, fetchedAt: null },
                TRACK,
            ),
        ).toBeNull();
    });
});

describe('audio HLS playlists', () => {
    it('master points at main.m3u8 with the request query and the token', () => {
        const body = buildAudioMasterPlaylist(
            new URLSearchParams('PlaySessionId=abc&AudioCodec=aac'),
            'tok',
        );
        expect(body.split('\n')).toEqual([
            '#EXTM3U',
            '#EXT-X-STREAM-INF:BANDWIDTH=128000,AVERAGE-BANDWIDTH=128000,CODECS="mp4a.40.2"',
            'main.m3u8?PlaySessionId=abc&AudioCodec=aac&api_key=tok',
            '',
        ]);
        expect(buildAudioMasterPlaylist(new URLSearchParams('api_key=own'), 'tok')).toContain(
            'main.m3u8?api_key=own\n',
        );
    });

    it('moves pre-generated segment URIs under /Audio/{id}/hls1/main/', () => {
        const id = '11111111-1111-4111-8111-111111111111';
        const playlist = `#EXTM3U\n#EXTINF:6,\n/j/Videos/${id}/hls/segment_00000.ts?PlaySessionId=p\n`;
        expect(rewriteSegmentUris(playlist, id)).toBe(
            `#EXTM3U\n#EXTINF:6,\n/j/Audio/${id}/hls1/main/segment_00000.ts?PlaySessionId=p\n`,
        );
    });
});

describe('stream.{container} helpers', () => {
    it('normalizes the container token', () => {
        expect(normalizeContainer('MP3')).toBe('mp3');
        expect(normalizeContainer('../etc')).toBeNull();
        expect(normalizeContainer('')).toBeNull();
    });

    it('matches container family AND the codec the container means', () => {
        expect(isCleanDirectMatch('mp3', '.mp3', 'mp3')).toBe(true);
        expect(isCleanDirectMatch('mp4', '.M4A', 'aac')).toBe(true);
        expect(isCleanDirectMatch('ogg', '.opus', 'opus')).toBe(true);
        expect(isCleanDirectMatch('ogg', 'ogg', 'vorbis')).toBe(true);
        expect(isCleanDirectMatch('mp3', '.flac', 'flac')).toBe(false);
        expect(isCleanDirectMatch('flac', 'flac', 'flac')).toBe(true);
    });

    it('refuses a file whose codec is not what the container implies', () => {
        // stream.opus must never hand out a Vorbis .ogg, stream.m4a never ALAC.
        expect(isCleanDirectMatch('opus', 'ogg', 'vorbis')).toBe(false);
        expect(isCleanDirectMatch('m4a', 'm4a', 'alac')).toBe(false);
        expect(isCleanDirectMatch('ogg', 'ogg', 'flac')).toBe(false);
        // An unprobed file only matches a container that implies no codec.
        expect(isCleanDirectMatch('mp3', 'mp3', null)).toBe(false);
        expect(isCleanDirectMatch('wav', 'wav', null)).toBe(true);
        expect(isCleanDirectMatch('mp3', '', 'mp3')).toBe(false);
    });

    it('takes the tighter of AudioBitRate / MaxStreamingBitrate in kbps', () => {
        expect(requestedKbps(new URL('http://x/?AudioBitRate=192000'))).toBe(192);
        expect(
            requestedKbps(new URL('http://x/?audioBitRate=320000&MaxStreamingBitrate=128000')),
        ).toBe(128);
        expect(requestedKbps(new URL('http://x/'))).toBeNull();
    });
});

describe('parseExcludeArtistIds', () => {
    it('accepts comma lists and repeats, normalizes dashless ids, drops junk', () => {
        const a = '11111111-1111-4111-8111-111111111111';
        const b = '22222222222242228222222222222222';
        const set = parseExcludeArtistIds(
            new URL(`http://x/?excludeArtistIds=${a},junk&excludeArtistIds=${b}`),
        );
        expect([...set].sort()).toEqual([a, '22222222-2222-4222-8222-222222222222'].sort());
    });
});
