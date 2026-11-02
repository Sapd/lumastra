// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { confirmStackedPart } from './stacked-parts';
import { splitPartToken } from '$lib/server/utils/filename-parser';

describe('splitPartToken', () => {
    it('separates the part token from the stack key', () => {
        expect(splitPartToken('/m/The Light of Dawn (2014) - Part1.mkv')).toEqual({
            part: 1,
            stackKey: 'the light of dawn (2014) -',
        });
        expect(splitPartToken('Voll im Bild Part 2_4.mp4')).toEqual({
            part: 2,
            stackKey: 'voll im bild_4',
        });
    });

    it('returns null without a part token', () => {
        expect(splitPartToken('/m/Spaceballs (1987).mkv')).toBeNull();
    });
});

describe('confirmStackedPart', () => {
    let dir: string;
    const touch = (...names: string[]) =>
        Promise.all(names.map((name) => writeFile(path.join(dir, name), '')));

    beforeEach(async () => {
        dir = await mkdtemp(path.join(tmpdir(), 'stacked-parts-'));
    });
    afterEach(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    it('keeps the part when the folder holds the other part', async () => {
        await touch('The Light of Dawn (2014) - Part1.mkv', 'The Light of Dawn (2014) - Part2.mkv');
        const result = await confirmStackedPart(
            path.join(dir, 'The Light of Dawn (2014) - Part1.mkv'),
            1,
        );
        expect(result).toEqual({
            part: 1,
            siblings: [
                { filePath: path.join(dir, 'The Light of Dawn (2014) - Part2.mkv'), part: 2 },
            ],
        });
    });

    it('drops a "Part N" that is the film title (no sibling part)', async () => {
        const name = 'Milo Farrow and the Distant Harbors Part 1 (2010) - Bluray-1080p.mkv';
        // Another version of the same film carries the same number: still no stack.
        await touch(name, 'Milo Farrow and the Distant Harbors Part 1 (2010) - WEBDL-2160p.mkv');
        expect(await confirmStackedPart(path.join(dir, name), 1)).toEqual({
            part: undefined,
            siblings: [],
        });
    });

    it('ignores non-video files and other names', async () => {
        await touch('Movie - Part1.mkv', 'Movie - Part2.srt', 'Other - Part2.mkv');
        expect((await confirmStackedPart(path.join(dir, 'Movie - Part1.mkv'), 1)).part).toBe(
            undefined,
        );
    });

    it('keeps the parsed part when the folder cannot be read', async () => {
        const missing = path.join(dir, 'gone', 'Movie - Part1.mkv');
        expect(await confirmStackedPart(missing, 1)).toEqual({ part: 1, siblings: [] });
    });

    it('does nothing for a file without a parsed part', async () => {
        expect(await confirmStackedPart(path.join(dir, 'Movie.mkv'), undefined)).toEqual({
            part: undefined,
            siblings: [],
        });
    });
});
