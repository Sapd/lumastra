// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tags written with `_` for every space must come out with spaces, on REAL
 * bytes through the REAL music-metadata (the sibling audio-tag-parser.test.ts
 * mocks it). Same frames and file name shape as the prod file that showed the
 * bug (names invented).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAudioTags } from './audio-tag-parser.js';
import { resolveArtistNamesFromTags } from './audio-processor.js';
import { ID3_LATIN1, textFrameBody, writeId3Mp3 } from './id3-mp3-fixture.test-helpers.js';
import { writeFile } from 'node:fs/promises';

describe('parseAudioTags: underscore-for-space tags (real music-metadata)', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-underscore-tags-'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('spaces artist and album of a prod-shaped file, keeps the spaced title', async () => {
        const p = await writeId3Mp3(
            join(dir, 'Corin_Vale - Hold_The_Signal - 05 - hold the signal.mp3'),
            3,
            [
                { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['hold the signal']) },
                { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['Corin_Vale']) },
                { id: 'TALB', body: textFrameBody(ID3_LATIN1, ['Hold_The_Signal']) },
                { id: 'TRCK', body: textFrameBody(ID3_LATIN1, ['5/25']) },
            ],
        );
        const tags = await parseAudioTags(p);
        expect(tags.artist).toBe('Corin Vale');
        expect(tags.album).toBe('Hold The Signal');
        expect(tags.title).toBe('hold the signal');
        expect(tags.titleFromFilename).toBe(false);
    });

    it('spaces a no-space title and album artist, so the credit splitter sees the joiner', async () => {
        const p = await writeId3Mp3(join(dir, 'no-space.mp3'), 3, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Faro_del_mar']) },
            { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['NVX_feat_Orrin']) },
            { id: 'TPE2', body: textFrameBody(ID3_LATIN1, ['Harbor_and_Lane']) },
        ]);
        const tags = await parseAudioTags(p);
        expect(tags.title).toBe('Faro del mar');
        expect(tags.artist).toBe('NVX feat Orrin');
        expect(tags.rawArtistTags).toMatchObject({
            source: 'file',
            artist: 'NVX_feat_Orrin',
            album_artist: 'Harbor_and_Lane',
        });
        expect(tags.albumArtist).toBe('Harbor and Lane');
    });

    it('leaves a value that already has a space alone', async () => {
        const p = await writeId3Mp3(join(dir, 'spaced.mp3'), 3, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Quien Sabe_ (Remix Edit)']) },
            { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['Mara Feat_ Tessa']) },
            { id: 'TALB', body: textFrameBody(ID3_LATIN1, ['Quiet Full_VLS']) },
        ]);
        const tags = await parseAudioTags(p);
        expect(tags.artist).toBe('Mara Feat_ Tessa');
        expect(tags.album).toBe('Quiet Full_VLS');
        expect(tags.title).toBe('Quien Sabe_ (Remix Edit)');
    });

    it('spaces both sides of an `Artist - Title` file name when the file has no tags', async () => {
        // Not an MP3 at all: the parser fails and falls back to the file name.
        const p = join(dir, 'Corin_Vale - Hold_The_Signal.mp3');
        await writeFile(p, 'not audio');
        const tags = await parseAudioTags(p);
        expect(tags.titleFromFilename).toBe(true);
        expect(tags.artistFromFilename).toBe('Corin Vale');
        expect(tags.rawArtistTags?.artist).toBeUndefined();
        expect(tags.title).toBe('Hold The Signal');
    });

    it('spaces every entry of an ID3v2.4 multi-value TPE1', async () => {
        const p = await writeId3Mp3(join(dir, 'multi.mp3'), 4, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['T']) },
            { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['Iris_van_Dalen', 'Lantern_Gate']) },
        ]);
        const tags = await parseAudioTags(p);
        expect(tags.artist).toBe('Iris van Dalen');
        expect(tags.artists).toEqual(['Iris van Dalen', 'Lantern Gate']);
    });
});

describe('parseAudioTags: track number in front of the artist tag (real music-metadata)', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-track-prefix-'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('drops the "NN-" a ripper put into TPE1 when the file name proves it', async () => {
        const p = await writeId3Mp3(
            join(dir, '09-Corin_Vale - Dance_Mix_vol_3 - 09 - Hold_the_signal.mp3'),
            3,
            [
                { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Hold_the_signal']) },
                { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['09-Corin_Vale']) },
                { id: 'TALB', body: textFrameBody(ID3_LATIN1, ['Dance_Mix_vol_3_CD1']) },
            ],
        );
        const tags = await parseAudioTags(p);
        expect(tags.artist).toBe('Corin Vale');
        expect(tags.artists).toBeUndefined();
    });

    it('strips album artist and every multi-value entry the file proves', async () => {
        const p = await writeId3Mp3(
            join(dir, '09-Corin_Vale - Dance_Mix_vol_3 - 09 - Hold_the_signal.mp3'),
            3,
            [
                { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Hold_the_signal']) },
                { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['09-Corin_Vale']) },
                { id: 'TPE2', body: textFrameBody(ID3_LATIN1, ['09-Corin_Vale']) },
                { id: 'TRCK', body: textFrameBody(ID3_LATIN1, ['9']) },
            ],
        );
        const tags = await parseAudioTags(p);
        expect(tags.albumArtist).toBe('Corin Vale');
        expect(tags.artist).toBe('Corin Vale');
    });

    it('keeps "2-4 Grooves" tagged as track 2, even with a "- 02 -" file name', async () => {
        const p = await writeId3Mp3(join(dir, '2-4 Grooves - Album - 02 - Some Title.mp3'), 3, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Some Title']) },
            { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['2-4 Grooves']) },
            { id: 'TRCK', body: textFrameBody(ID3_LATIN1, ['2']) },
        ]);
        expect((await parseAudioTags(p)).artist).toBe('2-4 Grooves');
    });

    it('keeps "2-4 Grooves" and "18-2000_Canarias"-style legit names intact', async () => {
        const legit = await writeId3Mp3(join(dir, '2-4 Grooves - Some Title.mp3'), 3, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Some Title']) },
            { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['2-4 Grooves']) },
        ]);
        expect((await parseAudioTags(legit)).artist).toBe('2-4 Grooves');
        const spaced = await writeId3Mp3(
            join(dir, '18-2000_Canarias - Dance_Mix_vol_3 - 18 - Beach.mp3'),
            3,
            [
                { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['Beach']) },
                { id: 'TPE1', body: textFrameBody(ID3_LATIN1, ['18-2000_Canarias']) },
            ],
        );
        expect((await parseAudioTags(spaced)).artist).toBe('2000 Canarias');
    });
});

describe('resolveArtistNamesFromTags: tag copies stored before the fix', () => {
    it('spaces a stored "Corin_Vale" so the per-scan relink finds "Corin Vale"', () => {
        expect(resolveArtistNamesFromTags(undefined, 'Corin_Vale')).toEqual(['Corin Vale']);
    });

    it('splits a stored "NVX_feat_Orrin" at the spaced joiner', () => {
        expect(resolveArtistNamesFromTags(undefined, 'NVX_feat_Orrin')).toEqual(['NVX', 'Orrin']);
    });

    it('spaces each entry of a stored multi-value array', () => {
        expect(resolveArtistNamesFromTags(['Iris_van_Dalen', 'Lantern_Gate'], undefined)).toEqual([
            'Iris van Dalen',
            'Lantern Gate',
        ]);
    });
});
