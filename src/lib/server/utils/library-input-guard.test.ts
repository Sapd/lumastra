// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWhitelist } = vi.hoisted(() => ({ mockWhitelist: vi.fn() }));

vi.mock('../config.js', () => ({ config: { FFMPEG_PATH: 'ffmpeg' } }));
vi.mock('./logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./media-format-whitelist.js', () => ({
    getMediaFormatWhitelist: (...a: unknown[]) => mockWhitelist(...a),
    prepareMediaFormatWhitelist: () => null,
}));

import { ffprobeLibraryInputArgs, guardLibraryInput } from './library-input-guard.js';

beforeEach(() => {
    mockWhitelist.mockReset().mockReturnValue('matroska,webm,mov');
});

describe('guardLibraryInput', () => {
    it('puts -format_whitelist directly before the library -i', () => {
        const args = ['-ss', '5', '-i', '/lib/a.mkv', '-map', '0:s:0', 'out.vtt'];
        expect(guardLibraryInput(args, '/lib/a.mkv')).toEqual([
            '-ss',
            '5',
            '-format_whitelist',
            'matroska,webm,mov',
            '-i',
            '/lib/a.mkv',
            '-map',
            '0:s:0',
            'out.vtt',
        ]);
    });

    it('guards every -i of the same file (multi-seek candidate extraction)', () => {
        const args = ['-ss', '1', '-i', '/lib/a.mkv', '-ss', '2', '-i', '/lib/a.mkv', 'o.jpg'];
        const out = guardLibraryInput(args, '/lib/a.mkv');
        expect(out.filter((a) => a === '-format_whitelist')).toHaveLength(2);
        out.forEach((a, i) => {
            if (a === '-i') expect(out[i - 2]).toBe('-format_whitelist');
        });
    });

    it('leaves other inputs (overlay PNG, lavfi) alone', () => {
        const args = ['-i', '/lib/a.mkv', '-i', '/tmp/logo.png'];
        const out = guardLibraryInput(args, '/lib/a.mkv');
        expect(out).toEqual([
            '-format_whitelist',
            'matroska,webm,mov',
            '-i',
            '/lib/a.mkv',
            '-i',
            '/tmp/logo.png',
        ]);
    });

    it('keeps a caller-supplied whitelist', () => {
        const args = ['-format_whitelist', 'mov', '-i', '/lib/a.mkv'];
        expect(guardLibraryInput(args, '/lib/a.mkv')).toEqual(args);
    });

    it('is a no-op when the binary demuxers could not be enumerated', () => {
        mockWhitelist.mockReturnValue(null);
        const args = ['-i', '/lib/a.mkv'];
        expect(guardLibraryInput(args, '/lib/a.mkv')).toEqual(args);
    });

    it('is a no-op when the input is not in the argv', () => {
        const args = ['-i', '/lib/b.mkv'];
        expect(guardLibraryInput(args, '/lib/a.mkv')).toEqual(args);
    });

    it('does not mutate its input', () => {
        const args = ['-i', '/lib/a.mkv'];
        guardLibraryInput(args, '/lib/a.mkv');
        expect(args).toEqual(['-i', '/lib/a.mkv']);
    });
});

describe('ffprobeLibraryInputArgs', () => {
    it('returns the option pair, or nothing without a whitelist', async () => {
        expect(await ffprobeLibraryInputArgs()).toEqual(['-format_whitelist', 'matroska,webm,mov']);
        mockWhitelist.mockReturnValue(null);
        expect(await ffprobeLibraryInputArgs()).toEqual([]);
    });
});
