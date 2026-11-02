// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { musicImagesFixture } from '$lib/server/services/music/__tests__/image-fixtures.js';
/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for track-projection.ts.
 *
 * Covers the two public helpers:
 *   - extractAudioFeatures(customMetadata)
 *   - toMusicTrack(row, images)
 */

import { describe, test, expect, vi } from 'vitest';

// Mock the external helpers that track-projection imports so this test
// runs without a real SvelteKit build environment.
vi.mock('$lib/utils/image-utils', () => ({
    getCatalogPosterUrl: vi.fn((id: string) => `https://example.com/art/${id}`),
}));
vi.mock('$lib/utils/music-track-metadata', () => ({
    parseMusicChapters: vi.fn(() => undefined),
}));
vi.mock('$lib/server/utils/music-artist-key', () => ({
    isVariousArtistsName: vi.fn(() => false),
    UNKNOWN_ARTIST_KEY: '__unknown_artist__',
    effectiveArtistKey: vi.fn(
        ({ artistName }: { artistName?: string | null }) =>
            artistName?.trim().toLowerCase() ?? '__unknown_artist__',
    ),
    // Mirrors the real helper: first structured credit, else undefined so the
    // caller falls through to the display-name chain.
    primaryCreditArtistName: vi.fn(
        (trackArtists?: Array<{ id: string | null; title: string }> | null) => {
            const first = trackArtists?.[0]?.title?.trim();
            return first && first.length > 0 ? first : undefined;
        },
    ),
}));

import {
    extractAudioFeatures,
    toMusicTrack,
    toAlbum,
    toIsoTimestamp,
    musicArtistDiversityKey,
    projectTrackMetadataForClient,
    projectTrackRowForClient,
    parseTagPosition,
} from './track-projection';
import type { MusicTrackRow } from './track-projection';
import { MusicAlbumDetailResponseSchema } from '$lib/schemas/api-music-responses';

// ---------------------------------------------------------------------------
// extractAudioFeatures
// ---------------------------------------------------------------------------

describe('extractAudioFeatures', () => {
    test('returns undefined when custom_metadata is null', () => {
        expect(extractAudioFeatures(null)).toBeUndefined();
    });

    test('returns undefined when essentia block is missing', () => {
        expect(extractAudioFeatures({ title: 'track' })).toBeUndefined();
    });

    test('returns undefined when essentia has no recognised fields', () => {
        expect(extractAudioFeatures({ essentia: {} })).toBeUndefined();
    });

    test('returns defined when essentia has bpm', () => {
        const result = extractAudioFeatures({ essentia: { bpm: 120 } });
        expect(result).toBeDefined();
        expect(result?.bpm).toBe(120);
    });

    test('coerces string bpm to number', () => {
        const result = extractAudioFeatures({ essentia: { bpm: '98.5' } });
        expect(result?.bpm).toBeCloseTo(98.5);
    });

    test('includes ALL AudioFeatures fields (D4 bug fix)', () => {
        const input = {
            essentia: {
                bpm: 120,
                key: 'C maj',
                energy: 0.7,
                danceability: 0.8,
                loudness_lufs: -14.2,
                beat_grid: [0, 500, 1000],
                downbeats: [0, 2000],
                intro_end_ms: 12000,
                outro_start_ms: 180000,
                outro_source: 'downbeat' as const,
                energy_curve: [0.5, 0.6, 0.8],
                mood_tags: ['happy', 'energetic'],
                vocal_instrumental: 'voice' as const,
                vocal_confidence: 0.92,
                dj_intro_end_ms: 8000,
            },
        };

        const result = extractAudioFeatures(input);
        expect(result).toBeDefined();
        expect(result?.beatGrid).toEqual([0, 500, 1000]);
        expect(result?.energyCurve).toEqual([0.5, 0.6, 0.8]);
        expect(result?.vocalInstrumental).toBe('voice');
        expect(result?.vocalConfidence).toBeCloseTo(0.92);
        expect(result?.djIntroEndMs).toBe(8000);
        expect(result?.introEndMs).toBe(12000);
        expect(result?.outroSource).toBe('downbeat');
    });
});

// ---------------------------------------------------------------------------
// toMusicTrack
// ---------------------------------------------------------------------------

function mkRow(overrides: Partial<MusicTrackRow> = {}): MusicTrackRow {
    return {
        custom_poster_url: '/cover.jpg',
        id: 'track-1',
        title: 'Test Track',
        custom_metadata: {},
        ...overrides,
    };
}

describe('toMusicTrack', () => {
    test('keeps an explicit empty track_artists projection empty (all credits filtered, e.g. Various Artists)', () => {
        const row = mkRow({
            custom_metadata: {
                track_artist_credits: [{ id: null, credited_name: 'Various Artists' }],
                artist: 'Old Performer',
                album_artist: 'Album Owner',
            },
            artist_id: 'album-owner-id',
            artist_title: 'Album Owner',
            track_artists: [],
        });
        const track = toMusicTrack(row, {});
        expect(track.artists).toEqual([]);
    });

    test('an empty track_artist_credits list falls back to legacy tags like a missing key', () => {
        const row = mkRow({
            custom_metadata: {
                track_artist_credits: [],
                artist: 'Old Performer',
                artists: ['Old Performer'],
                album_artist: 'Album Owner',
            },
            artist_id: 'album-owner-id',
            artist_title: 'Album Owner',
        });
        const track = toMusicTrack(row, {});
        expect(track.artists).toEqual([{ id: null, title: 'Old Performer' }]);
    });

    test('an empty list without tags falls back to the album artist', () => {
        const row = mkRow({
            custom_metadata: { track_artist_credits: [] },
            artist_id: 'album-owner-id',
            artist_title: 'Album Owner',
        });
        const track = toMusicTrack(row, {});
        expect(track.artists).toEqual([{ id: 'album-owner-id', title: 'Album Owner' }]);
    });

    test('keeps explicit empty performers authoritative when metadata is omitted', () => {
        const row = mkRow({
            custom_metadata: {},
            artist_id: 'album-owner-id',
            artist_title: 'Album Owner',
            track_artists: [],
            remixer_artists: [{ id: 'remixer-id', title: 'Title Remixer' }],
        });
        const track = toMusicTrack(row, {});
        expect(track.artists).toEqual([]);
        expect(track.remixerArtists).toEqual([{ id: 'remixer-id', title: 'Title Remixer' }]);
    });

    test('preserves unresolved canonical names without recovering an album link', () => {
        const row = mkRow({
            custom_metadata: {
                track_artist_credits: [{ id: null, credited_name: 'Guest Singer' }],
            },
            artist_id: 'album-owner-id',
            artist_title: 'Album Owner',
            track_artists: [{ id: null, title: 'Guest Singer' }],
        });
        expect(toMusicTrack(row, {}).artists).toEqual([{ id: null, title: 'Guest Singer' }]);
    });

    test('uses artist_title from hierarchy if present', () => {
        const row = mkRow({ artist_title: 'The Lanterns' });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.artists[0]?.title).toBe('The Lanterns');
    });

    test('falls back to resolved_artist when artist_title missing', () => {
        const row = mkRow({ resolved_artist: 'Pink Harbor' });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.artists[0]?.title).toBe('Pink Harbor');
    });

    test('falls back to custom_metadata.artist', () => {
        const row = mkRow({ custom_metadata: { artist: 'Led Zeppelin' } });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.artists[0]?.title).toBe('Led Zeppelin');
    });

    test('defaults to Unknown Artist when no artist info', () => {
        const row = mkRow();
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.artists[0]?.title).toBe('Unknown Artist');
    });

    test('sets albumId from album_id then parent_id', () => {
        const row = mkRow({
            album_id: 'album-uuid',
            album_title: 'Album',
            parent_id: 'other-uuid',
        });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.album?.id).toBe('album-uuid');
    });

    test('falls back albumId to parent_id when album_id absent', () => {
        const row = mkRow({ parent_id: 'parent-uuid', album_title: 'Album' });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.album?.id).toBe('parent-uuid');
    });

    test('includes audioFeatures when essentia present', () => {
        const row = mkRow({
            custom_metadata: {
                essentia: {
                    bpm: 130,
                    energy: 0.9,
                    beat_grid: [0, 461],
                    energy_curve: [0.8],
                    vocal_instrumental: 'instrumental',
                    dj_intro_end_ms: 5000,
                },
            },
        });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.audioFeatures).toBeDefined();
        expect(track.audioFeatures?.bpm).toBe(130);
        expect(track.audioFeatures?.beatGrid).toEqual([0, 461]);
        expect(track.audioFeatures?.energyCurve).toEqual([0.8]);
        expect(track.audioFeatures?.vocalInstrumental).toBe('instrumental');
        expect(track.audioFeatures?.djIntroEndMs).toBe(5000);
    });

    test('passes resolved images.primary.href through', () => {
        const row = mkRow({ id: 'my-track' });
        const images = musicImagesFixture(row.id, 'internal');
        const track = toMusicTrack(row, images);
        expect(track.images).toBe(images);
        expect(track.images?.primary?.href).toContain('my-track');
    });

    test('emits every images.primary preset variant', () => {
        const row = mkRow({ id: 'img-track' });
        const track = toMusicTrack(row, musicImagesFixture(row.id, 'internal'));
        expect(track.images?.primary?.href).toContain('img-track');
        expect(track.images?.primary?.variants?.thumb).toContain('thumb');
        expect(track.images?.primary?.variants?.card).toContain('card');
        expect(track.images?.primary?.variants?.full).toContain('full');
    });

    test('keeps an empty resolved image set', () => {
        const row = mkRow({ id: 'no-img-track' });
        const track = toMusicTrack(row, {});
        expect(track.images).toEqual({});
    });

    test('preserves the surface of the resolved descriptors', () => {
        const row = mkRow({ id: 'surf-track' });
        expect(
            toMusicTrack(row, musicImagesFixture(row.id, 'internal')).images?.primary?.href,
        ).toBe('/api/media/surf-track/images/poster?size=card&v=fixture-cover-revision');
        expect(toMusicTrack(row, musicImagesFixture(row.id, 'v1')).images?.primary?.href).toBe(
            '/api/v1/media/surf-track/images/poster?size=card&v=fixture-cover-revision',
        );
    });
});

// ---------------------------------------------------------------------------
// musicArtistDiversityKey
// ---------------------------------------------------------------------------

describe('toMusicTrack — genre and year', () => {
    const base = { id: 't1', title: 'Song', custom_metadata: {} as Record<string, unknown> };

    test('emits genre as an array of trimmed tags', () => {
        const out = toMusicTrack(
            { ...base, custom_metadata: { genre: ['Rock', '  Acoustic Rock  '] } },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.genres).toEqual(['Rock', 'Acoustic Rock']);
    });

    test('promotes a bare-string genre to a one-element array', () => {
        // The corpus stores arrays, but a hand-edited row can hold a string,
        // and emitting a string where the schema says string[] would fail a
        // strict client's decode of the WHOLE response.
        const out = toMusicTrack(
            { ...base, custom_metadata: { genre: 'Metal' } },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.genres).toEqual(['Metal']);
    });

    test('emits an empty genres array when tags are absent or empty', () => {
        expect(toMusicTrack(base, musicImagesFixture(base.id, 'internal')).genres).toEqual([]);
        expect(
            toMusicTrack(
                { ...base, custom_metadata: { genre: ['', '  '] } },
                musicImagesFixture(base.id, 'internal'),
            ).genres,
        ).toEqual([]);
        expect(
            toMusicTrack(
                { ...base, custom_metadata: { genre: [1, 2] } },
                musicImagesFixture(base.id, 'internal'),
            ).genres,
        ).toEqual([]);
    });

    test('drops the tag-artifact year 1 instead of showing it (166 prod tracks carry it)', () => {
        const out = toMusicTrack(
            { ...base, custom_metadata: { year: 1 } },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.year).toBeNull();
    });

    test('falls back to the album year when the track has no plausible one', () => {
        const out = toMusicTrack(
            { ...base, custom_metadata: { year: 1 }, album_year: 1994 },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.year).toBe(1994);
    });

    test("prefers the track's own year over the album's", () => {
        const out = toMusicTrack(
            { ...base, custom_metadata: { year: 1971 }, album_year: 1994 },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.year).toBe(1971);
    });

    test('rejects a far-future year from either source', () => {
        expect(
            toMusicTrack(
                { ...base, custom_metadata: { year: 9999 } },
                musicImagesFixture(base.id, 'internal'),
            ).year,
        ).toBeNull();
        expect(
            toMusicTrack({ ...base, album_year: 9999 }, musicImagesFixture(base.id, 'internal'))
                .year,
        ).toBeNull();
    });

    test('accepts a numeric string year', () => {
        const out = toMusicTrack(
            { ...base, custom_metadata: { year: '1985' } },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.year).toBe(1985);
    });

    test('keeps a forward-dated year from the date tag (2030) on the track and album', () => {
        // Files tagged date=2030 / 2030-05-01: the scanner stores 2030 and the
        // DTOs must not drop it as far-future.
        const out = toMusicTrack(
            { ...base, custom_metadata: { year: 2030 } },
            musicImagesFixture(base.id, 'internal'),
        );
        expect(out.year).toBe(2030);

        const album = toAlbum(
            {
                id: '22222222-2222-4222-8222-222222222222',
                title: 'Assorted Evenings',
                year: 2030,
                custom_metadata: {},
            } as never,
            {},
        );
        expect(album.year).toBe(2030);
    });
});

describe('musicArtistDiversityKey', () => {
    test('returns lowercased artist_title', () => {
        const row = mkRow({ artist_title: 'David Linden' });
        const key = musicArtistDiversityKey(row);
        expect(key).toBe('david linden');
    });

    test('uses resolved_artist when artist_title absent', () => {
        const row = mkRow({ resolved_artist: 'Riverglass' });
        const key = musicArtistDiversityKey(row);
        expect(key).toBe('riverglass');
    });

    test('returns unknown sentinel when no artist info', () => {
        const row = mkRow();
        const key = musicArtistDiversityKey(row);
        expect(key).toBe('__unknown_artist__');
    });
});

// ---------------------------------------------------------------------------
// projectTrackMetadataForClient / projectTrackRowForClient
// ---------------------------------------------------------------------------

const FULL_ESSENTIA_METADATA = {
    essentia: {
        bpm: 128,
        key: 'Am',
        energy: 0.8,
        danceability: 1.4,
        loudness_lufs: -12.3,
        beat_grid: [0.1, 0.6, 1.1],
        downbeats: [0.1, 2.1],
        intro_end_ms: 4000,
        outro_start_ms: 180000,
        mood_tags: ['energetic'],
        vocal_instrumental: 'instrumental',
        vocal_confidence: 0.9,
        outro_source: 'downbeat',
        dj_intro_end_ms: 3500,
        first_vocal_start_ms: 5000,
        last_vocal_end_ms: 170000,
        energy_curve: [0.1, 0.2, 0.3],
        essentia_analyzed: true,
    },
};

describe('projectTrackMetadataForClient', () => {
    test('defaults to compact BPM and loudness essentia fields (narrow mode)', () => {
        const out = projectTrackMetadataForClient(FULL_ESSENTIA_METADATA);
        expect(out.essentia).toEqual({ bpm: 128, loudness_lufs: -12.3 });
    });

    test('narrow mode is also explicit when fullAudioFeatures:false', () => {
        const out = projectTrackMetadataForClient(FULL_ESSENTIA_METADATA, {
            fullAudioFeatures: false,
        });
        expect(out.essentia).toEqual({ bpm: 128, loudness_lufs: -12.3 });
    });

    test('full mode returns all 16 requested fields', () => {
        const out = projectTrackMetadataForClient(FULL_ESSENTIA_METADATA, {
            fullAudioFeatures: true,
        }) as { essentia: Record<string, unknown> };
        expect(out.essentia).toEqual({
            bpm: 128,
            key: 'Am',
            energy: 0.8,
            danceability: 1.4,
            loudness_lufs: -12.3,
            beat_grid: [0.1, 0.6, 1.1],
            downbeats: [0.1, 2.1],
            intro_end_ms: 4000,
            outro_start_ms: 180000,
            mood_tags: ['energetic'],
            vocal_instrumental: 'instrumental',
            vocal_confidence: 0.9,
            outro_source: 'downbeat',
            dj_intro_end_ms: 3500,
            first_vocal_start_ms: 5000,
            last_vocal_end_ms: 170000,
        });
    });

    test('full mode never leaks energy_curve or essentia_analyzed', () => {
        const out = projectTrackMetadataForClient(FULL_ESSENTIA_METADATA, {
            fullAudioFeatures: true,
        }) as { essentia: Record<string, unknown> };
        expect(out.essentia.energyCurve).toBeUndefined();
        expect(out.essentia.essentia_analyzed).toBeUndefined();
    });

    test('full mode strips null-valued essentia fields (schema rejects null)', () => {
        // storeAnalysis() writes dj_intro_end_ms / first_vocal_start_ms /
        // last_vocal_end_ms as `number | null` and they are frequently null.
        // JsonMetadataSchema declares them `z.number().int().optional()`, which
        // accepts number|undefined but REJECTS null — a null on the wire fails
        // mount()'s response-conformance check and silently disables the
        // stripping guard for that response.
        const out = projectTrackMetadataForClient(
            {
                essentia: {
                    ...FULL_ESSENTIA_METADATA.essentia,
                    dj_intro_end_ms: null,
                    first_vocal_start_ms: null,
                    last_vocal_end_ms: null,
                },
            },
            { fullAudioFeatures: true },
        ) as { essentia: Record<string, unknown> };

        expect(out.essentia).not.toHaveProperty('dj_intro_end_ms');
        expect(out.essentia).not.toHaveProperty('first_vocal_start_ms');
        expect(out.essentia).not.toHaveProperty('last_vocal_end_ms');
        // The non-null neighbours still come through.
        expect(out.essentia.bpm).toBe(128);
        expect(out.essentia.intro_end_ms).toBe(4000);
    });

    test('narrows essentia to compact display fields and drops bulk analysis arrays', () => {
        const out = projectTrackMetadataForClient({
            essentia: {
                bpm: 174,
                key: 'A#',
                beat_grid: [0.1, 0.2, 0.3],
                downbeats: [0.1],
                energy_curve: [0.5],
            },
        });
        expect(out.essentia).toEqual({ bpm: 174 });
    });

    test('drops lyrics', () => {
        const out = projectTrackMetadataForClient({ lyrics: 'a whole song of text' });
        expect(out).not.toHaveProperty('lyrics');
    });

    test('omits essentia entirely when no compact display field is present', () => {
        const out = projectTrackMetadataForClient({ essentia: { beat_grid: [0.1] } });
        expect(out).not.toHaveProperty('essentia');
    });

    test('keeps loudness when BPM is absent', () => {
        const out = projectTrackMetadataForClient({ essentia: { loudness_lufs: -11.7 } });
        expect(out.essentia).toEqual({ loudness_lufs: -11.7 });
    });

    test('keeps every key the client actually reads', () => {
        const meta = {
            chapters: [{ start: 0 }],
            album: 'Eskalation',
            artist: 'Picco',
            artists: ['Picco', 'Megalanterns'],
            album_artist: 'Various Artists',
            genre: ['Hardstyle'],
            disc_number: 2,
            featuring_artists: [{ name: 'Guest', mbid: 'abc' }],
        };
        expect(projectTrackMetadataForClient(meta)).toEqual(meta);
    });

    test('returns an empty object for null metadata', () => {
        expect(projectTrackMetadataForClient(null)).toEqual({});
    });
});

describe('parseTagPosition', () => {
    test.each([
        [3, 3],
        ['3', 3],
        [' 2/3 ', 2],
        [0, null],
        [-1, null],
        [1.5, null],
        ['', null],
        ['A', null],
        [null, null],
        [undefined, null],
    ])('%j -> %j', (input, expected) => {
        expect(parseTagPosition(input)).toBe(expected);
    });
});

describe('projectTrackRowForClient', () => {
    test('drops the server-side file_path', () => {
        const out = projectTrackRowForClient({
            id: 't1',
            custom_metadata: {},
            file_path: '/data/media/libraries/music/x.flac',
        });
        expect(out).not.toHaveProperty('file_path');
        expect(out.id).toBe('t1');
    });

    test('leaves other row fields untouched', () => {
        const out = projectTrackRowForClient({
            id: 't1',
            title: 'Mein Herz',
            sort_order: 3,
            custom_metadata: { disc_number: 1 },
            file_path: '/data/x.flac',
        });
        expect(out).toEqual({
            id: 't1',
            title: 'Mein Herz',
            sort_order: 3,
            custom_metadata: { disc_number: 1 },
            disc_number: 1,
            track_number: null,
        });
    });

    test('lifts disc_number and track_number to top-level ints', () => {
        const out = projectTrackRowForClient({
            id: 't1',
            custom_metadata: { disc_number: '2/3', track_number: 7 },
        });
        expect(out.disc_number).toBe(2);
        expect(out.track_number).toBe(7);
        // track_number is not a client metadata key; it only ships top-level.
        expect(out.custom_metadata).toEqual({ disc_number: '2/3' });
    });

    test('a projected row survives the album-detail response schema with disc_number intact', () => {
        // Regression guard: disc_number/artists/featuring_artists were read by
        // AlbumModal but undeclared in JsonMetadataSchema, so Zod silently
        // stripped them and multi-disc grouping collapsed to a single disc.
        const response = {
            album: {
                album: {
                    id: 'a1',
                    title: 'Eskalation',
                    overview: null,
                    custom_poster_url: null,
                    custom_backdrop_url: null,
                    custom_metadata: {},
                    year: 2026,
                    artist_id: null,
                    artist_title: null,
                    track_count: 1,
                    total_duration: 200,
                    created_at: '2026-01-01T00:00:00Z',
                },
                tracks: [
                    projectTrackRowForClient({
                        id: 't1',
                        title: 'Mein Herz',
                        sort_order: 1,
                        runtime_seconds: 200,
                        custom_poster_url: null,
                        parent_id: 'a1',
                        track_artist_id: null,
                        track_artist_title: 'Picco',
                        track_artists: null,
                        created_at: '2026-01-01T00:00:00Z',
                        file_path: '/data/media/libraries/music/x.flac',
                        custom_metadata: {
                            disc_number: 2,
                            artists: ['Picco'],
                            essentia: { bpm: 150, beat_grid: [0.1] },
                            lyrics: 'text',
                        },
                    }),
                ],
            },
        };

        const parsed = MusicAlbumDetailResponseSchema.parse({
            ...toAlbum(response.album.album, {}),
            tracks: response.album.tracks.map((row) =>
                toMusicTrack(row, musicImagesFixture(row.id, 'internal')),
            ),
        });
        const track = parsed.tracks[0];
        expect(track.discNumber).toBe(2);
        expect(track).not.toHaveProperty('disc_number');
        expect(track.artists[0].title).toBe('Picco');
        expect(track.audioFeatures).toEqual({ bpm: 150 });
        expect(track).not.toHaveProperty('file_path');
    });

    test('a FULL-mode projection with null vocal/dj fields conforms to the response schema', () => {
        // Regression guard: JsonMetadataSchema declares dj_intro_end_ms /
        // first_vocal_start_ms / last_vocal_end_ms as z.number().int().optional(),
        // which REJECTS null. storeAnalysis() writes them as `number | null`, so
        // letting null through made mount()'s response-conformance check fail —
        // which silently disables the stripping guard for that response.
        const response = {
            album: {
                album: {
                    id: 'a1',
                    title: 'Eskalation',
                    overview: null,
                    custom_poster_url: null,
                    custom_backdrop_url: null,
                    custom_metadata: {},
                    year: 2026,
                    artist_id: null,
                    artist_title: null,
                    track_count: 1,
                    total_duration: 200,
                    created_at: '2026-01-01T00:00:00Z',
                },
                tracks: [
                    projectTrackRowForClient(
                        {
                            id: 't1',
                            title: 'Mein Herz',
                            sort_order: 1,
                            runtime_seconds: 200,
                            custom_poster_url: null,
                            parent_id: 'a1',
                            track_artist_id: null,
                            track_artist_title: 'Picco',
                            track_artists: null,
                            created_at: '2026-01-01T00:00:00Z',
                            file_path: '/data/media/libraries/music/x.flac',
                            custom_metadata: {
                                essentia: {
                                    bpm: 150,
                                    dj_intro_end_ms: null,
                                    first_vocal_start_ms: null,
                                    last_vocal_end_ms: null,
                                },
                            },
                        },
                        { fullAudioFeatures: true },
                    ),
                ],
            },
        };

        const result = MusicAlbumDetailResponseSchema.safeParse({
            ...toAlbum(response.album.album, {}),
            tracks: response.album.tracks.map((row) =>
                toMusicTrack(row, musicImagesFixture(row.id, 'internal')),
            ),
        });
        expect(result.success).toBe(true);
        expect(result.data?.tracks[0].audioFeatures).toEqual({ bpm: 150 });
    });
});

describe('musicArtistDiversityKey — credit-first', () => {
    test('prefers the structured credit over the combined display string', () => {
        // The prod failure: "Eloren Ft 50 Sparks & Dr. Vale" followed "Eloren"
        // because the display strings differ as keys.
        const key = musicArtistDiversityKey({
            id: 't1',
            resolved_artist: 'Eloren Ft 50 Sparks & Dr. Vale',
            track_artists: [
                { id: 'a', title: 'Eloren' },
                { id: 'b', title: '50 Sparks' },
            ],
        } as unknown as Parameters<typeof musicArtistDiversityKey>[0]);
        expect(key).toBe('eloren');
    });

    test('falls back to the display chain when there is no structured credit', () => {
        const key = musicArtistDiversityKey({
            id: 't2',
            resolved_artist: 'Some Artist',
            track_artists: null,
        } as unknown as Parameters<typeof musicArtistDiversityKey>[0]);
        expect(key).toBe('some artist');
    });
});

describe('toIsoTimestamp and addedAt', () => {
    test('normalises a Postgres created_at::text value to ISO 8601 UTC', () => {
        expect(toIsoTimestamp('2026-09-12 15:03:43+02')).toBe('2026-09-12T13:03:43.000Z');
        expect(toIsoTimestamp('2026-09-12 15:03:43.5+02')).toBe('2026-09-12T13:03:43.500Z');
        expect(toIsoTimestamp('2026-09-12 15:03:43+02:00')).toBe('2026-09-12T13:03:43.000Z');
    });

    test('reads a date-only value as UTC midnight and a timestamp without offset as UTC', () => {
        expect(toIsoTimestamp('2026-09-12')).toBe('2026-09-12T00:00:00.000Z');
        expect(toIsoTimestamp('2026-09-12 15:03:43')).toBe('2026-09-12T15:03:43.000Z');
    });

    test('applies the offset of a compact (+HHMM) or hour-only (+HH) suffix', () => {
        expect(toIsoTimestamp('2026-09-12 15:03:43+0530')).toBe('2026-09-12T09:33:43.000Z');
        expect(toIsoTimestamp('2026-09-12 15:03:43+02')).toBe('2026-09-12T13:03:43.000Z');
    });

    test('passes Date values through as ISO strings and maps junk to null', () => {
        expect(toIsoTimestamp(new Date('2026-09-12T13:03:43.000Z'))).toBe(
            '2026-09-12T13:03:43.000Z',
        );
        expect(toIsoTimestamp('not a timestamp')).toBeNull();
        expect(toIsoTimestamp('')).toBeNull();
        expect(toIsoTimestamp(null)).toBeNull();
    });

    test('album addedAt is ISO 8601 when the query selected created_at as text', () => {
        const album = toAlbum(
            {
                id: '11111111-1111-4111-8111-111111111111',
                title: 'Album',
                created_at: '2026-09-12 15:03:43+02',
                custom_metadata: {},
            } as never,
            {},
        );
        expect(album.addedAt).toBe('2026-09-12T13:03:43.000Z');
    });
});
