// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * NUL-separated multi-value tag frames must never reach the caller with a raw
 * 0x00 (Postgres error 22021). Uses the REAL music-metadata on REAL bytes —
 * the sibling audio-tag-parser.test.ts mocks it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAudioTags } from './audio-tag-parser.js';
import {
    ID3_LATIN1,
    ID3_UTF8,
    ID3_UTF16_BOM,
    prodNulAlbumArtistFrames,
    textFrameBody,
    writeId3Mp3,
} from './id3-mp3-fixture.test-helpers.js';

function stringsOf(value: unknown, out: string[] = []): string[] {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
    else if (value && typeof value === 'object' && !Buffer.isBuffer(value))
        for (const v of Object.values(value)) stringsOf(v, out);
    return out;
}

describe('parseAudioTags: NUL-separated multi-value frames (real music-metadata)', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-nul-tags-'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('ID3v2.3 NUL-separated UTF-16 TPE2 (prod shape) splits into primary + array', async () => {
        const p = await writeId3Mp3(join(dir, 'prod.mp3'), 3, prodNulAlbumArtistFrames());
        const tags = await parseAudioTags(p);
        expect(tags.albumArtist).toBe("L'EXAIS");
        expect(tags.albumArtists).toEqual(["L'EXAIS", 'Perfect Pitch', 'Rocco']);
        expect(tags.artist).toBe("L'EXAIS x Perfect Pitch x Rocco");
        expect(tags.artists).toBeUndefined();
        expect(tags.title).toBe('Woodpecker');
        expect(tags.album).toBe('Woodpecker');
        expect(stringsOf(tags).some((s) => s.includes('\u0000') || s.includes('\uFEFF'))).toBe(
            false,
        );
    });

    it.each([
        ['ISO-8859-1', ID3_LATIN1],
        ['UTF-8', ID3_UTF8],
    ])('ID3v2.4 NUL-separated TPE1 (%s) gives first value + all values', async (_n, enc) => {
        const p = await writeId3Mp3(join(dir, `v24-${enc}.mp3`), 4, [
            { id: 'TIT2', body: textFrameBody(ID3_LATIN1, ['T']) },
            { id: 'TPE1', body: textFrameBody(enc, ['A', 'B']) },
        ]);
        const tags = await parseAudioTags(p);
        expect(tags.artist).toBe('A');
        expect(tags.artists).toEqual(['A', 'B']);
    });

    it('ID3v2.3 NUL inside TIT2 / TALB / TCON keeps the first title/album, splits genres', async () => {
        const p = await writeId3Mp3(join(dir, 'v23-misc.mp3'), 3, [
            { id: 'TIT2', body: textFrameBody(ID3_UTF16_BOM, ['Song', 'Song (Alt)']) },
            { id: 'TALB', body: textFrameBody(ID3_LATIN1, ['Album One', 'Album Two']) },
            { id: 'TCON', body: textFrameBody(ID3_UTF16_BOM, ['Trance', 'House']) },
        ]);
        const tags = await parseAudioTags(p);
        expect(tags.title).toBe('Song');
        expect(tags.album).toBe('Album One');
        expect(tags.genre).toEqual(['Trance', 'House']);
        expect(stringsOf(tags).some((s) => s.includes('\u0000') || s.includes('\uFEFF'))).toBe(
            false,
        );
    });
});
