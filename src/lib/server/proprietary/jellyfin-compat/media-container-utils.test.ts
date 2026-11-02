// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { describe, it, expect } from 'vitest';
import { containerFromPath, isAudioContainer, deriveQualityLabel } from './media-container-utils';

describe('containerFromPath', () => {
    it('maps common video extensions', () => {
        expect(containerFromPath('/data/movies/Film.mkv')).toBe('mkv');
        expect(containerFromPath('/data/movies/Film.mp4')).toBe('mp4');
        expect(containerFromPath('/data/movies/Film.m4v')).toBe('mp4');
        expect(containerFromPath('/data/movies/Film.avi')).toBe('avi');
        expect(containerFromPath('/data/movies/Film.webm')).toBe('webm');
        expect(containerFromPath('/data/movies/Film.mov')).toBe('mov');
        expect(containerFromPath('/data/movies/Film.ts')).toBe('ts');
        expect(containerFromPath('/data/movies/Film.wmv')).toBe('wmv');
    });

    it('maps audio extensions', () => {
        expect(containerFromPath('/data/music/Song.flac')).toBe('flac');
        expect(containerFromPath('/data/music/Song.mp3')).toBe('mp3');
        expect(containerFromPath('/data/music/Song.m4a')).toBe('m4a');
        expect(containerFromPath('/data/music/Song.aac')).toBe('aac');
        expect(containerFromPath('/data/music/Song.ogg')).toBe('ogg');
        expect(containerFromPath('/data/music/Song.opus')).toBe('opus');
        expect(containerFromPath('/data/music/Song.wav')).toBe('wav');
        expect(containerFromPath('/data/music/Song.wma')).toBe('wma');
    });

    it('handles case-insensitive extensions', () => {
        expect(containerFromPath('/data/Film.MKV')).toBe('mkv');
        expect(containerFromPath('/data/Song.FLAC')).toBe('flac');
        expect(containerFromPath('/data/Film.Mp4')).toBe('mp4');
    });

    it('returns extension as-is for unknown formats', () => {
        expect(containerFromPath('/data/file.divx')).toBe('divx');
        expect(containerFromPath('/data/file.rmvb')).toBe('rmvb');
    });

    it('defaults to mkv for empty path', () => {
        expect(containerFromPath('')).toBe('mkv');
    });

    it('returns path as-is for extensionless files (no dot)', () => {
        // '/data/file'.split('.') = ['/data/file'], pop() = '/data/file'
        // Not a real-world case — all media files have extensions
        expect(containerFromPath('/data/file')).toBe('/data/file');
    });

    it('handles paths with dots in directory names', () => {
        expect(containerFromPath('/data/v2.0/movies/Film.mkv')).toBe('mkv');
        expect(containerFromPath('/data/movies/Film (2024) [imdbid-tt123]/Film.mp4')).toBe('mp4');
    });
});

describe('isAudioContainer', () => {
    it('returns true for audio containers', () => {
        for (const c of ['flac', 'mp3', 'm4a', 'aac', 'ogg', 'opus', 'wav', 'wma']) {
            expect(isAudioContainer(c)).toBe(true);
        }
    });

    it('returns false for video containers', () => {
        for (const c of ['mkv', 'mp4', 'avi', 'webm', 'mov', 'ts', 'wmv']) {
            expect(isAudioContainer(c)).toBe(false);
        }
    });

    it('returns false for unknown containers', () => {
        expect(isAudioContainer('divx')).toBe(false);
        expect(isAudioContainer('')).toBe(false);
    });
});

describe('deriveQualityLabel', () => {
    it("returns '4K' when path contains '4k'", () => {
        expect(deriveQualityLabel('/data/movies/Film.4k.mkv')).toBe('4K');
    });

    it("returns '4K' when path contains '2160'", () => {
        expect(deriveQualityLabel('/data/movies/Film.2160p.mkv')).toBe('4K');
    });

    it("returns '1080p' when path contains '1080'", () => {
        expect(deriveQualityLabel('/data/movies/Film.1080p.mkv')).toBe('1080p');
    });

    it("returns '720p' when path contains '720'", () => {
        expect(deriveQualityLabel('/data/movies/Film.720p.mkv')).toBe('720p');
    });

    it("returns '480p' when path contains '480'", () => {
        expect(deriveQualityLabel('/data/movies/Film.480p.mkv')).toBe('480p');
    });

    it('returns uppercase file extension for normal file without quality hint', () => {
        expect(deriveQualityLabel('/data/movies/Film.mkv')).toBe('MKV');
    });

    it('returns uppercased extension for file with mixed-case extension and no quality hint', () => {
        expect(deriveQualityLabel('/data/movies/Film.Mkv')).toBe('MKV');
    });
});
