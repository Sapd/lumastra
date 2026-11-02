// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { condenseFailureReason, MAX_REASON_LEN } from './failure-reason.js';

/** A faithful shape of what prod actually stored: ffmpeg's banner, long
 *  enough on its own to consume the entire 500-char budget. */
const FFMPEG_BANNER = [
    'ffmpeg version 7.1.4-Jellyfin Copyright (c) 2000-2026 the FFmpeg developers',
    '  built with gcc 12 (Debian 12.2.0-14)',
    '  configuration: --prefix=/usr/lib/jellyfin-ffmpeg --target-os=linux --extra-version=Jellyfin --extra-cflags= --extra-cxxflags= --extra-ldflags= --extra-ldexeflags=-pie --extra-libs=-ldl --enable-gpl --enable-version3 --disable-ffplay --disable-debug --disable-doc --disable-ptx-compression --disable-vulkan --enable-lto=auto --enable-gmp --enable-gnutls --enable-chromaprint',
    '  libavutil      59. 39.100 / 59. 39.100',
    '  libavcodec     61. 19.100 / 61. 19.100',
    '  libavformat    61.  7.100 / 61.  7.100',
    '  libavdevice    61.  3.100 / 61.  3.100',
    '  libavfilter    10.  4.100 / 10.  4.100',
    '  libswscale      8.  3.100 /  8.  3.100',
    '  libswresample   5.  3.100 /  5.  3.100',
    '  libpostproc    58.  3.100 / 58.  3.100',
].join('\n');

describe('condenseFailureReason', () => {
    it('drops the ffmpeg banner and keeps the real error', () => {
        const raw = `${FFMPEG_BANNER}\n[mp3 @ 0x55] Header missing\n/data/music/x.mp3: Invalid data found when processing input`;

        const out = condenseFailureReason(raw);

        expect(out).toContain('Invalid data found when processing input');
        expect(out).toContain('Header missing');
        expect(out).not.toContain('configuration:');
        expect(out).not.toContain('libavcodec');
        expect(out).not.toContain('ffmpeg version');
    });

    it('regression: a banner-only reason no longer fills the cap with boilerplate', () => {
        // Prod 2026-09-11: 705 rows, all exactly 500 chars, all banner. The
        // head-slice that produced them is what this asserts against.
        const raw = `${FFMPEG_BANNER}\nFFmpeg exited with code 1`;
        expect(raw.slice(0, MAX_REASON_LEN)).not.toContain('exited with code 1');

        const out = condenseFailureReason(raw);

        expect(out).toContain('FFmpeg exited with code 1');
        expect(out.length).toBeLessThanOrEqual(MAX_REASON_LEN);
    });

    it('strips banners that appear mid-text, not just as a prefix', () => {
        const raw = `pass 1 of 2 failed\n${FFMPEG_BANNER}\nOutput file is empty`;

        const out = condenseFailureReason(raw);

        expect(out).toContain('pass 1 of 2 failed');
        expect(out).toContain('Output file is empty');
        expect(out).not.toContain('libswscale');
    });

    it('never returns empty when the reason was nothing but a banner', () => {
        const out = condenseFailureReason(FFMPEG_BANNER);
        expect(out.length).toBeGreaterThan(0);
        expect(out.length).toBeLessThanOrEqual(MAX_REASON_LEN);
    });

    it('keeps both ends when still over the cap, and says how much it dropped', () => {
        const raw = `FIRST LINE MARKER\n${'x'.repeat(5000)}\nLAST LINE MARKER`;

        const out = condenseFailureReason(raw);

        expect(out.length).toBeLessThanOrEqual(MAX_REASON_LEN);
        expect(out).toContain('FIRST LINE MARKER');
        expect(out).toContain('LAST LINE MARKER');
        expect(out).toMatch(/\[\d+ chars omitted\]/);
    });

    it('never exceeds the cap, for any input length', () => {
        for (const len of [0, 1, 499, 500, 501, 5_000, 250_000]) {
            const out = condenseFailureReason('e'.repeat(len));
            expect(out.length).toBeLessThanOrEqual(MAX_REASON_LEN);
        }
    });

    it('honours a custom cap, degrading to a head slice when too small for two ends', () => {
        const out = condenseFailureReason('y'.repeat(1000), 20);
        expect(out.length).toBe(20);
    });

    it('leaves a short reason untouched apart from trimming', () => {
        expect(condenseFailureReason('  RuntimeError: Failed to decode audio.  ')).toBe(
            'RuntimeError: Failed to decode audio.',
        );
    });
});
