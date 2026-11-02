// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { selectFileForPlayback } from './file-selection.js';

describe('selectFileForPlayback', () => {
    it('returns single file directly', () => {
        const files = [
            {
                id: '1',
                file_path: '/media/movie.mkv',
                edition: null,
                part_number: null,
            },
        ];
        const result = selectFileForPlayback(files, null);
        expect(result.type).toBe('single');
        if (result.type === 'single') {
            expect(result.path).toBe('/media/movie.mkv');
            expect(result.fileId).toBe('1');
        }
    });

    it('filters by edition when specified', () => {
        const files = [
            {
                id: '1',
                file_path: '/media/movie.mkv',
                edition: null,
                part_number: null,
            },
            {
                id: '2',
                file_path: '/media/movie.dc.mkv',
                edition: 'directors_cut',
                part_number: null,
            },
        ];
        const result = selectFileForPlayback(files, 'directors_cut');
        expect(result.type).toBe('single');
        if (result.type === 'single') {
            expect(result.path).toBe('/media/movie.dc.mkv');
            expect(result.fileId).toBe('2');
        }
    });

    it('returns concat paths for split files', () => {
        const files = [
            {
                id: '1',
                file_path: '/media/Part1.mkv',
                edition: null,
                part_number: 1,
            },
            {
                id: '2',
                file_path: '/media/Part2.mkv',
                edition: null,
                part_number: 2,
            },
        ];
        const result = selectFileForPlayback(files, null);
        expect(result.type).toBe('concat');
        if (result.type === 'concat') {
            expect(result.paths).toEqual(['/media/Part1.mkv', '/media/Part2.mkv']);
            expect(result.fileIds).toEqual(['1', '2']);
        }
    });

    it('defaults to null-edition files when no edition specified', () => {
        const files = [
            {
                id: '1',
                file_path: '/media/movie.mkv',
                edition: null,
                part_number: null,
            },
            {
                id: '2',
                file_path: '/media/movie.dc.mkv',
                edition: 'directors_cut',
                part_number: null,
            },
        ];
        const result = selectFileForPlayback(files, null);
        expect(result.type).toBe('single');
        if (result.type === 'single') {
            expect(result.path).toBe('/media/movie.mkv');
        }
    });

    it('falls back to all files when edition filter yields nothing', () => {
        const files = [
            {
                id: '1',
                file_path: '/media/movie.mkv',
                edition: null,
                part_number: null,
            },
        ];
        const result = selectFileForPlayback(files, 'nonexistent');
        expect(result.type).toBe('single');
        if (result.type === 'single') {
            expect(result.path).toBe('/media/movie.mkv');
        }
    });

    it('orders split files by part_number ascending', () => {
        const files = [
            {
                id: '2',
                file_path: '/media/Part2.mkv',
                edition: null,
                part_number: 2,
            },
            {
                id: '1',
                file_path: '/media/Part1.mkv',
                edition: null,
                part_number: 1,
            },
            {
                id: '3',
                file_path: '/media/Part3.mkv',
                edition: null,
                part_number: 3,
            },
        ];
        const result = selectFileForPlayback(files, null);
        expect(result.type).toBe('concat');
        if (result.type === 'concat') {
            expect(result.paths).toEqual([
                '/media/Part1.mkv',
                '/media/Part2.mkv',
                '/media/Part3.mkv',
            ]);
        }
    });
});

// "Part N" in a film title used to be stored as a part number. Two unlabelled
// versions of "Distant Harbors Part 1" then both carried part 1 and were
// concatenated: the film twice in a row (2026-10-03).
describe('selectFileForPlayback — versions are not parts', () => {
    const file = (id: string, part_number: number | null, edition: string | null = null) => ({
        id,
        file_path: `/media/${id}.mkv`,
        edition,
        part_number,
    });

    it('plays one file when two versions share a part number', () => {
        const result = selectFileForPlayback([file('1080p', 1), file('720p', 1)], null);
        expect(result).toEqual({ type: 'single', path: '/media/1080p.mkv', fileId: '1080p' });
    });

    it('plays one file for a lone part next to an un-numbered version', () => {
        const result = selectFileForPlayback([file('plain', null), file('part', 1)], null);
        expect(result).toEqual({ type: 'single', path: '/media/plain.mkv', fileId: 'plain' });
    });

    it('concatenates one file per part when a stack has two versions', () => {
        const result = selectFileForPlayback(
            [file('a1', 1), file('a2', 2), file('b1', 1), file('b2', 2)],
            null,
        );
        expect(result).toEqual({
            type: 'concat',
            paths: ['/media/a1.mkv', '/media/a2.mkv'],
            fileIds: ['a1', 'a2'],
        });
    });

    it('leaves an un-numbered file out of a real stack', () => {
        const result = selectFileForPlayback(
            [file('p2', 2), file('plain', null), file('p1', 1)],
            null,
        );
        expect(result).toEqual({
            type: 'concat',
            paths: ['/media/p1.mkv', '/media/p2.mkv'],
            fileIds: ['p1', 'p2'],
        });
    });
});
