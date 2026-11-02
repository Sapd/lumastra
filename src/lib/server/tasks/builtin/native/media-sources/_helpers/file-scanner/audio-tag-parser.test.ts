// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Unit tests for `safeParseFile` timeout / abort behavior and
 * `parseAudioTags` empty-fallback behavior.
 *
 * The timeout was added after a worker hang traced to `music-metadata`'s
 * `parseFile()` never resolving on a stalled NFS read. The catch path in
 * `parseAudioTags` already swallows rejections into a filename-derived
 * fallback, so a timeout-induced rejection produces the right outcome.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('music-metadata', () => {
    return {
        parseFile: vi.fn(),
    };
});

vi.mock('./vorbis-raw-reader.js', () => ({
    readFlacVorbisCommentsRaw: vi.fn().mockResolvedValue(null),
}));

import { parseFile } from 'music-metadata';
import { readFlacVorbisCommentsRaw } from './vorbis-raw-reader.js';
import {
    safeParseFile,
    parseAudioTags,
    PARSE_FILE_TIMEOUT_MS,
    trackTitleSource,
} from './audio-tag-parser.js';

const mockedParseFile = vi.mocked(parseFile);

describe('PARSE_FILE_TIMEOUT_MS', () => {
    it('defaults to 30 seconds', () => {
        expect(PARSE_FILE_TIMEOUT_MS).toBe(30_000);
    });
});

describe('safeParseFile timeout', () => {
    it('rejects when parseFile does not resolve within timeoutMs', async () => {
        // Never-resolving stand-in for a stalled NFS read.
        mockedParseFile.mockImplementationOnce(() => new Promise(() => undefined));

        const start = Date.now();
        await expect(safeParseFile('/fake/stalled.mp3', { timeoutMs: 100 })).rejects.toThrow(
            /timed out after 100ms/,
        );
        const elapsed = Date.now() - start;

        // Should reject around the timeout window, not block forever.
        expect(elapsed).toBeLessThan(2_000);
    });

    it('resolves normally when parseFile finishes before timeoutMs', async () => {
        const fakeMeta = {
            common: { title: 'OK' },
            format: { duration: 1 },
        };
        mockedParseFile.mockImplementationOnce(() => Promise.resolve(fakeMeta as never));

        await expect(safeParseFile('/fake/ok.mp3', { timeoutMs: 5_000 })).resolves.toBe(fakeMeta);
    });

    it('rejects immediately when given an already-aborted signal', async () => {
        mockedParseFile.mockImplementationOnce(() => new Promise(() => undefined));
        const ac = new AbortController();
        ac.abort();

        await expect(
            safeParseFile('/fake/aborted.mp3', {
                timeoutMs: 60_000,
                signal: ac.signal,
            }),
        ).rejects.toThrow(/aborted/);
    });

    it('rejects when signal aborts mid-parse', async () => {
        mockedParseFile.mockImplementationOnce(() => new Promise(() => undefined));
        const ac = new AbortController();
        setTimeout(() => ac.abort(), 30);

        await expect(
            safeParseFile('/fake/will-abort.mp3', {
                timeoutMs: 60_000,
                signal: ac.signal,
            }),
        ).rejects.toThrow(/aborted/);
    });

    it('propagates the strtok3 RangeError via the rejection path (no uncaughtException listener)', async () => {
        // On current music-metadata/strtok3 the "ignore length must be ≥ 0
        // bytes" RangeError is thrown from an async tokenizer method, so it
        // arrives as a promise rejection — caught locally by safeParseFile's
        // .catch, with no process-global uncaughtException listener involved.
        // Clear any mockImplementationOnce leaked by an earlier test that
        // short-circuited before calling parseFile (e.g. the pre-aborted-signal
        // case) so our rejecting impl is the one actually consumed.
        mockedParseFile.mockReset();
        const rangeErr = new RangeError('ignore length must be ≥ 0 bytes');
        mockedParseFile.mockImplementationOnce(() => Promise.reject(rangeErr));

        await expect(safeParseFile('/fake/corrupt.mp3', { timeoutMs: 5_000 })).rejects.toBe(
            rangeErr,
        );
    });
});

describe('parseAudioTags timeout fallback', () => {
    // Reset the queued `mockImplementationOnce` stack between tests so a
    // leaked impl from one test (e.g. a pre-aborted signal that short-
    // circuits before parseFile is called) doesn't get popped by the next
    // test, causing a 30 s wait on the default timeout.
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    it('returns filename-derived fallback when parseFile stalls past the timeout', async () => {
        // Cause safeParseFile to time out by stalling parseFile, then verify
        // parseAudioTags translates that rejection into the empty-result path.
        mockedParseFile.mockImplementationOnce(() => new Promise(() => undefined));

        // parseAudioTags doesn't take an override, but we use a short signal
        // abort to short-circuit safeParseFile in the same code path that
        // a timeout would hit (both surface as rejections caught by the
        // outer try in parseAudioTags).
        const ac = new AbortController();
        queueMicrotask(() => ac.abort());

        const result = await parseAudioTags('/music/Foo Artist - Bar Title.mp3', {
            signal: ac.signal,
        });

        // Filename split: "Foo Artist - Bar Title" → artist + title
        expect(result.title).toBe('Bar Title');
        expect(result.artistFromFilename).toBe('Foo Artist');
        // No tag-sourced fields should be set on the fallback path.
        expect(result.artist).toBeUndefined();
        expect(result.album).toBeUndefined();
        // parseError = 'aborted' because the abort signal short-circuited
        // the safeParseFile call.
        expect(result.parseError).toBe('aborted');
    });

    it('sets parseError=timeout when safeParseFile rejects with a timeout', async () => {
        // Reject synchronously with the message safeParseFile uses on timeout.
        mockedParseFile.mockImplementationOnce(() =>
            Promise.reject(new Error('parseFile timed out after 30000ms: /x')),
        );

        const result = await parseAudioTags('/music/14-secal-désenchantée.flac');

        // parseError surfaces the timeout — caller decides whether to skip.
        // Without the parseError signal, the scanner would create a track row
        // with title="14-secal-désenchantée" (and a dup on every scan).
        expect(result.parseError).toBe('timeout');
        // Fallback title is still populated for callers that DO want it.
        expect(result.title).toBeTruthy();
    });

    it('sets parseError=corrupt for any non-timeout/non-aborted parse failure', async () => {
        mockedParseFile.mockImplementationOnce(() =>
            Promise.reject(new Error('FLAC stream marker missing')),
        );

        const result = await parseAudioTags('/music/broken.flac');

        expect(result.parseError).toBe('corrupt');
    });

    it('sets parseError=corrupt when parseFile rejects with the strtok3 RangeError', async () => {
        // Regression guard for removing the per-call uncaughtException listener:
        // the corrupt-file RangeError now flows through the normal rejection
        // path and is classified 'corrupt' — no crash, no cross-parse mis-route.
        mockedParseFile.mockImplementationOnce(() =>
            Promise.reject(new RangeError('ignore length must be ≥ 0 bytes')),
        );

        const result = await parseAudioTags('/music/corrupt.mp3');

        expect(result.parseError).toBe('corrupt');
    });

    it('does not set parseError when parseFile returns successfully (empty tags)', async () => {
        // Genuinely tag-less file — parseFile resolves with empty common fields.
        // This case must remain distinguishable from a parse failure.
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: {},
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/01 - Some Artist - Some Title.mp3');

        expect(result.parseError).toBeUndefined();
        expect(result.title).toBe('Some Title');
        expect(result.artistFromFilename).toBe('Some Artist');
    });
});

describe('parseAudioTags MusicBrainz recording MBID extraction', () => {
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    it('extracts and lowercases a valid recording MBID', async () => {
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: {
                        title: 'Track',
                        musicbrainz_recordingid: 'A1B2C3D4-E5F6-4789-A012-B3C4D5E6F789',
                    },
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/track.flac');

        expect(result.recordingMbid).toBe('a1b2c3d4-e5f6-4789-a012-b3c4d5e6f789');
    });

    it('rejects a junk (non-UUID-shaped) recording MBID tag value', async () => {
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: {
                        title: 'Track',
                        musicbrainz_recordingid: 'not-a-real-mbid',
                    },
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/track.flac');

        expect(result.recordingMbid).toBeUndefined();
    });

    it('leaves recordingMbid unset when the tag is absent', async () => {
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: { title: 'Track' },
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/track.flac');

        expect(result.recordingMbid).toBeUndefined();
    });
});

describe('parseAudioTags disc number extraction', () => {
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    it('extracts disc number and total from the common.disk tag', async () => {
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: { title: 'Track', disk: { no: 2, of: 2 } },
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/track.flac');

        expect(result.discNumber).toBe(2);
        expect(result.discTotal).toBe(2);
    });

    it('extracts disc number when only disk.no is present (no total)', async () => {
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: { title: 'Track', disk: { no: 1 } },
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/track.flac');

        expect(result.discNumber).toBe(1);
        expect(result.discTotal).toBeUndefined();
    });

    it('leaves discNumber unset when the tag is absent or non-positive', async () => {
        mockedParseFile.mockImplementationOnce(
            async () =>
                ({
                    common: { title: 'Track', disk: { no: 0, of: 0 } },
                    format: {},
                }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>,
        );

        const result = await parseAudioTags('/music/track.flac');

        expect(result.discNumber).toBeUndefined();
        expect(result.discTotal).toBeUndefined();
    });
});

/**
 * `media_items.title_source` is written from these two: the music-hygiene
 * "title from file name" finding reads nothing else, so a title derived from
 * the file name that reports itself as a tag disappears from that list.
 */
describe('parseAudioTags title provenance', () => {
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    const meta = (common: Record<string, unknown>): Awaited<ReturnType<typeof mockedParseFile>> =>
        ({ common, format: {} }) as unknown as Awaited<ReturnType<typeof mockedParseFile>>;

    it('a title tag is a tag', async () => {
        mockedParseFile.mockImplementationOnce(async () => meta({ title: 'Real Song' }));
        const result = await parseAudioTags('/music/01 - Some Artist - Other Name.mp3');
        expect(result.title).toBe('Real Song');
        expect(result.titleFromFilename).toBe(false);
        expect(trackTitleSource(result)).toBe('tag');
    });

    it.each([
        ['the Artist - Title split', '/music/01 - Some Artist - Real Song.mp3', 'Real Song'],
        ['the track-number-stripped stem', '/music/05 Plain Title.mp3', 'Plain Title'],
        ['the underscore-normalised stem', '/music/another_song_here.mp3', 'another song here'],
    ])('no title tag: %s is a filename title', async (_label, filePath, title) => {
        mockedParseFile.mockImplementationOnce(async () => meta({}));
        const result = await parseAudioTags(filePath);
        expect(result.title).toBe(title);
        expect(result.titleFromFilename).toBe(true);
        expect(trackTitleSource(result)).toBe('filename');
    });

    it('a double-underscore separator in the title tag becomes " - "', async () => {
        mockedParseFile.mockImplementationOnce(async () =>
            meta({ title: 'Lantern Tango__Club Mix' }),
        );
        const result = await parseAudioTags('/music/01.mp3');
        expect(result.title).toBe('Lantern Tango - Club Mix');
        expect(trackTitleSource(result)).toBe('tag');
    });

    it('a whitespace-only title tag falls back to the file name', async () => {
        mockedParseFile.mockImplementationOnce(async () => meta({ title: '   ' }));
        const result = await parseAudioTags('/music/05 Plain Title.mp3');
        expect(result.title).toBe('Plain Title');
        expect(trackTitleSource(result)).toBe('filename');
    });

    it('a parse failure reports its fallback title as filename-derived', async () => {
        mockedParseFile.mockImplementationOnce(() => Promise.reject(new Error('corrupt')));
        const result = await parseAudioTags('/music/05 Plain Title.mp3');
        expect(result.parseError).toBe('corrupt');
        expect(trackTitleSource(result)).toBe('filename');
    });
});

describe('trackTitleSource', () => {
    it("treats a blank title as the scanner's own filename fallback", () => {
        // The insert path substitutes normalizeUnderscoreStem(stem) and the
        // re-scan the bare basename when the parser hands back a blank title.
        expect(trackTitleSource({ title: '' })).toBe('filename');
        expect(trackTitleSource({ title: '  ' })).toBe('filename');
        expect(trackTitleSource({})).toBe('filename');
    });

    it('is a tag only when non-blank and not derived', () => {
        expect(trackTitleSource({ title: 'Song' })).toBe('tag');
        expect(trackTitleSource({ title: 'Song', titleFromFilename: false })).toBe('tag');
        expect(trackTitleSource({ title: 'Song', titleFromFilename: true })).toBe('filename');
    });
});

describe('parseAudioTags tag text bounds', () => {
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    it('clamps and whitespace-collapses tag strings before anything downstream sees them', async () => {
        const huge = `A${' '.repeat(40_000)}B${'x'.repeat(200_000)}`;
        mockedParseFile.mockImplementationOnce(() =>
            Promise.resolve({
                common: {
                    title: huge,
                    artist: huge,
                    albumartist: huge,
                    album: huge,
                    artists: [huge, 'Other'],
                    albumartists: [huge, 'Other'],
                },
                format: { duration: 10 },
            } as never),
        );

        const result = await parseAudioTags('/music/Foo - Bar.mp3');

        for (const value of [
            result.title,
            result.artist,
            result.albumArtist,
            result.album,
            ...(result.artists ?? []),
            ...(result.albumArtists ?? []),
        ]) {
            expect(value!.length).toBeLessThanOrEqual(4096);
        }
        expect(result.artist!.startsWith('A B')).toBe(true);
    });

    it('leaves an ordinary tag untouched', async () => {
        mockedParseFile.mockImplementationOnce(() =>
            Promise.resolve({
                common: { title: 'Song  Name', artist: 'Some Artist', album: 'Record' },
                format: { duration: 10 },
            } as never),
        );

        const result = await parseAudioTags('/music/x.mp3');

        expect(result.title).toBe('Song  Name');
        expect(result.artist).toBe('Some Artist');
        expect(result.album).toBe('Record');
    });
});

describe('NUL-separated values (mocked shapes)', () => {
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    const parseWith = (
        common: Record<string, unknown>,
        format: Record<string, unknown> = { duration: 10 },
        file = '/music/x.mp3',
    ): ReturnType<typeof parseAudioTags> => {
        mockedParseFile.mockImplementationOnce(() => Promise.resolve({ common, format } as never));
        return parseAudioTags(file);
    };

    it('splits a NUL-joined albumartist and keeps the array exact', async () => {
        const r = await parseWith({ albumartist: 'A\0B', albumartists: ['A', 'B'] });
        expect(r.albumArtist).toBe('A');
        expect(r.albumArtists).toEqual(['A', 'B']);
    });

    it('does not add a plain joined scalar to the artists array', async () => {
        const r = await parseWith({ artist: 'A & B', artists: ['A', 'B'] });
        expect(r.artists).toEqual(['A', 'B']);
    });

    it('re-joins an ID3v2.3 TPE1 music-metadata cut at "/\\"', async () => {
        // music-metadata's shape for TPE1 "Axel /\\ Ingo" in an ID3v2.3 file.
        const r = await parseWith({ artist: 'Axel', artists: ['Axel', '\\ Ingo'] });
        expect(r.artist).toBe('Axel /\\ Ingo');
        expect(r.artists).toBeUndefined();
    });

    it('keeps a real ID3v2.3 slash list', async () => {
        const r = await parseWith({ artist: 'Foo', artists: ['Foo', 'Bar'] });
        expect(r.artist).toBe('Foo');
        expect(r.artists).toEqual(['Foo', 'Bar']);
    });

    it.each(['', '  '])('a blank artist %j stays undefined despite an artists array', async (v) => {
        const r = await parseWith({ artist: v, artists: ['A', 'B'] });
        expect(r.artist).toBeUndefined();
    });

    it('turns NULs in lyrics into newlines', async () => {
        const r = await parseWith({ lyrics: [{ text: 'line1\0line2' }] });
        expect(r.lyrics).toBe('line1\nline2');
    });

    it('strips NULs from the codec', async () => {
        expect((await parseWith({}, { codec: 'MPEG\0' })).codec).toBe('MPEG');
        expect((await parseWith({}, { codec: '\0' })).codec).toBeUndefined();
    });

    it('FLAC mojibake recovery keeps the first part of a NUL-packed value', async () => {
        vi.mocked(readFlacVorbisCommentsRaw).mockResolvedValueOnce(
            new Map([['ARTIST', [Buffer.from('A\0B', 'latin1')]]]),
        );
        const r = await parseWith({ artist: 'A\uFFFD' }, { duration: 10 }, '/music/x.flac');
        expect(r.artist).toBe('A');
    });
});

describe('parseAudioTags year from the date tag', () => {
    beforeEach(() => {
        mockedParseFile.mockReset();
    });

    it('keeps a forward-dated year (2030) that music-metadata reads from the date tag', async () => {
        // music-metadata maps DATE / TDRC / \u00A9day to common.year (first four digits),
        // so `date=2030-05-01` arrives here as year 2030.
        mockedParseFile.mockImplementationOnce(() =>
            Promise.resolve({
                common: { title: 'Salt Market', album: 'Tidewater Sketches', year: 2030 },
                format: { duration: 60 },
            } as never),
        );

        const result = await parseAudioTags(
            '/music/Marlow Fenwick/Tidewater Sketches (2030)/01 - Salt Market.flac',
        );

        expect(result.year).toBe(2030);
        expect(result.album).toBe('Tidewater Sketches');
    });
});

describe('release identifier tags', () => {
    it('reads common barcode and catalogue fields without losing leading zeroes', async () => {
        mockedParseFile.mockReset().mockResolvedValueOnce({
            common: { barcode: '0194111012158', catalognumber: ['ZYX 83064-2'] },
            format: {},
            native: {},
        } as never);
        expect(await parseAudioTags('/fake/release.mp3')).toMatchObject({
            barcode: '0194111012158',
            catalogueNumber: 'ZYX 83064-2',
        });
    });
    it('reads raw BARCODE and CATALOG# frames', async () => {
        mockedParseFile.mockReset().mockResolvedValueOnce({
            common: {},
            format: {},
            native: {
                vorbis: [
                    { id: 'BARCODE', value: '194111012158' },
                    { id: 'CATALOG#', value: 'ZYX 83064-2' },
                ],
            },
        } as never);
        expect(await parseAudioTags('/fake/release.mp3')).toMatchObject({
            barcode: '194111012158',
            catalogueNumber: 'ZYX 83064-2',
        });
    });
});
