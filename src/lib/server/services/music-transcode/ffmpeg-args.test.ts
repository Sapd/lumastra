// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    buildMp3EncodeArgs,
    buildOpusEncodeArgs,
    buildAacEncodeArgs,
    buildM4aEncodeArgs,
    buildStreamCopySeekArgs,
    containerFor,
    mimeFor,
} from './ffmpeg-args.js';

describe('music-transcode ffmpeg args', () => {
    it('buildMp3EncodeArgs at offset=0 omits -ss', () => {
        expect(
            buildMp3EncodeArgs({
                srcPath: '/a.flac',
                bitrateKbps: 192,
                timeOffset: 0,
            }),
        ).toEqual([
            '-protocol_whitelist',
            'file',
            '-i',
            '/a.flac',
            '-vn',
            '-map',
            '0:a:0',
            '-c:a',
            'libmp3lame',
            '-b:a',
            '192k',
            '-ac',
            '2',
            '-ar',
            '44100',
            '-f',
            'mp3',
            '-id3v2_version',
            '0',
            '-write_id3v1',
            '0',
            '-write_xing',
            '0',
            'pipe:1',
        ]);
    });

    it('buildMp3EncodeArgs at offset>0 prefixes -ss before -i', () => {
        const args = buildMp3EncodeArgs({
            srcPath: '/a.flac',
            bitrateKbps: 192,
            timeOffset: 30,
        });
        expect(args[0]).toBe('-ss');
        expect(args[1]).toBe('30');
        expect(args[2]).toBe('-protocol_whitelist');
        expect(args[3]).toBe('file');
        expect(args[4]).toBe('-i');
    });

    it('buildOpusEncodeArgs uses -vbr off and 48000 Hz', () => {
        const args = buildOpusEncodeArgs({
            srcPath: '/a.flac',
            bitrateKbps: 128,
            timeOffset: 0,
        });
        expect(args).toContain('-vbr');
        expect(args[args.indexOf('-vbr') + 1]).toBe('off');
        expect(args).toContain('-ar');
        expect(args[args.indexOf('-ar') + 1]).toBe('48000');
        expect(args).toContain('-f');
        expect(args[args.indexOf('-f') + 1]).toBe('ogg');
    });

    it('buildAacEncodeArgs prefers libfdk_aac when available', () => {
        const args = buildAacEncodeArgs(
            { srcPath: '/a.flac', bitrateKbps: 192, timeOffset: 0 },
            { hasFdkAac: true },
        );
        expect(args).toContain('libfdk_aac');
        expect(args).toContain('-profile:a');
        expect(args[args.indexOf('-profile:a') + 1]).toBe('aac_low');
        expect(args).toContain('adts');
    });

    it('buildAacEncodeArgs falls back to aac without -profile:a', () => {
        const args = buildAacEncodeArgs(
            { srcPath: '/a.flac', bitrateKbps: 192, timeOffset: 0 },
            { hasFdkAac: false },
        );
        expect(args).toContain('aac');
        expect(args).not.toContain('libfdk_aac');
        expect(args).not.toContain('-profile:a');
    });

    it('buildStreamCopySeekArgs uses -c copy and -ss before -i', () => {
        const args = buildStreamCopySeekArgs({
            cachedPath: '/c.mp3',
            codec: 'mp3',
            timeOffset: 15,
        });
        expect(args).toEqual([
            '-ss',
            '15',
            '-protocol_whitelist',
            'file',
            '-i',
            '/c.mp3',
            '-vn',
            '-map',
            '0:a:0',
            '-c:a',
            'copy',
            '-f',
            'mp3',
            'pipe:1',
        ]);
    });

    // m4a is the only target that must NOT end up on a pipe. ffmpeg does not
    // fail when you try — `-f mp4 … pipe:1` exits 0 having written a moof
    // whose size field is still 0x00000000, so `mdat` is unreachable and
    // AVFoundation refuses the file while ffprobe reports it as healthy.
    describe('buildM4aEncodeArgs', () => {
        it('writes a non-fragmented faststart mp4 to the given path', () => {
            const args = buildM4aEncodeArgs(
                { srcPath: '/a.flac', bitrateKbps: 256, timeOffset: 0 },
                { hasFdkAac: false },
                '/cache/ab/deadbeef.m4a.partial',
            );
            expect(args).toEqual([
                '-protocol_whitelist',
                'file',
                '-i',
                '/a.flac',
                '-vn',
                '-map',
                '0:a:0',
                '-c:a',
                'aac',
                '-b:a',
                '256k',
                '-ac',
                '2',
                '-ar',
                '44100',
                '-f',
                'mp4',
                '-movflags',
                '+faststart',
                '-y',
                '/cache/ab/deadbeef.m4a.partial',
            ]);
            // The fragmented-mp4 flags are what shipped broken. If any of them
            // comes back, the output stops being openable from disk.
            expect(args.join(' ')).not.toContain('frag_keyframe');
            expect(args.join(' ')).not.toContain('empty_moov');
            expect(args).not.toContain('pipe:1');
        });

        it('uses libfdk_aac and its profile flag when available', () => {
            const args = buildM4aEncodeArgs(
                { srcPath: '/a.flac', bitrateKbps: 192, timeOffset: 0 },
                { hasFdkAac: true },
                '/out.m4a',
            );
            expect(args).toContain('libfdk_aac');
            expect(args.join(' ')).toContain('-profile:a aac_low');
        });

        it('keeps the -ss prefix for a seek', () => {
            const args = buildM4aEncodeArgs(
                { srcPath: '/a.flac', bitrateKbps: 192, timeOffset: 30 },
                { hasFdkAac: false },
                '/out.m4a',
            );
            expect(args.slice(0, 2)).toEqual(['-ss', '30']);
        });

        it.each(['pipe:1', 'pipe:', '-', ''])('refuses %j as an output', (outPath) => {
            expect(() =>
                buildM4aEncodeArgs(
                    { srcPath: '/a.flac', bitrateKbps: 256, timeOffset: 0 },
                    { hasFdkAac: false },
                    outPath,
                ),
            ).toThrow(/seekable output/);
        });
    });

    it('stream-copy seek into mp4 goes to a file with +faststart', () => {
        expect(
            buildStreamCopySeekArgs({
                cachedPath: '/c.m4a',
                codec: 'm4a',
                timeOffset: 12,
                outPath: '/scratch/x.m4a.partial',
            }),
        ).toEqual([
            '-ss',
            '12',
            '-protocol_whitelist',
            'file',
            '-i',
            '/c.m4a',
            '-vn',
            '-map',
            '0:a:0',
            '-c:a',
            'copy',
            '-f',
            'mp4',
            '-movflags',
            '+faststart',
            '-y',
            '/scratch/x.m4a.partial',
        ]);
    });

    it('stream-copy seek into mp4 without an outPath throws rather than piping', () => {
        expect(() =>
            buildStreamCopySeekArgs({ cachedPath: '/c.m4a', codec: 'm4a', timeOffset: 12 }),
        ).toThrow(/seekable output/);
    });

    it('containerFor returns ffmpeg -f names', () => {
        expect(containerFor('mp3')).toBe('mp3');
        expect(containerFor('opus')).toBe('ogg');
        expect(containerFor('aac')).toBe('adts');
        expect(containerFor('m4a')).toBe('mp4');
    });

    it('mimeFor returns audio MIME types', () => {
        expect(mimeFor('mp3')).toBe('audio/mpeg');
        expect(mimeFor('opus')).toBe('audio/ogg; codecs=opus');
        expect(mimeFor('aac')).toBe('audio/aac');
        expect(mimeFor('m4a')).toBe('audio/mp4');
    });

    it('throws on NaN bitrate', () => {
        expect(() =>
            buildMp3EncodeArgs({
                srcPath: '/a',
                bitrateKbps: NaN,
                timeOffset: 0,
            }),
        ).toThrow();
    });

    it('throws on negative bitrate', () => {
        expect(() =>
            buildMp3EncodeArgs({
                srcPath: '/a',
                bitrateKbps: -1,
                timeOffset: 0,
            }),
        ).toThrow();
    });

    it('throws on negative timeOffset', () => {
        expect(() =>
            buildOpusEncodeArgs({
                srcPath: '/a',
                bitrateKbps: 128,
                timeOffset: -5,
            }),
        ).toThrow();
    });

    it('throws on NaN timeOffset (seek)', () => {
        expect(() =>
            buildStreamCopySeekArgs({
                cachedPath: '/c',
                codec: 'mp3',
                timeOffset: NaN,
            }),
        ).toThrow();
    });

    // F1c (fix plan 6, Task 7 fix round 1): music files never get a scan-time
    // ffprobe/playlist-container check (processAudioFile parses tags with
    // music-metadata, not ffmpeg), so a file that reaches one of these ffmpeg
    // inputs is not otherwise gated. Same shared MEDIA_PROTOCOL_WHITELIST as
    // the two HLS/transcode sites, applied directly at each -i site instead.
    describe('protocol whitelist (F1c)', () => {
        it('buildMp3EncodeArgs carries -protocol_whitelist file immediately before -i', () => {
            const args = buildMp3EncodeArgs({
                srcPath: '/a.flac',
                bitrateKbps: 192,
                timeOffset: 0,
            });
            const i = args.indexOf('-i');
            expect(args[i - 2]).toBe('-protocol_whitelist');
            expect(args[i - 1]).toBe('file');
        });

        it('buildOpusEncodeArgs carries -protocol_whitelist file immediately before -i', () => {
            const args = buildOpusEncodeArgs({
                srcPath: '/a.flac',
                bitrateKbps: 128,
                timeOffset: 0,
            });
            const i = args.indexOf('-i');
            expect(args[i - 2]).toBe('-protocol_whitelist');
            expect(args[i - 1]).toBe('file');
        });

        it('buildAacEncodeArgs carries -protocol_whitelist file immediately before -i', () => {
            const args = buildAacEncodeArgs(
                { srcPath: '/a.flac', bitrateKbps: 192, timeOffset: 0 },
                { hasFdkAac: false },
            );
            const i = args.indexOf('-i');
            expect(args[i - 2]).toBe('-protocol_whitelist');
            expect(args[i - 1]).toBe('file');
        });

        it('buildM4aEncodeArgs carries -protocol_whitelist file immediately before -i', () => {
            const args = buildM4aEncodeArgs(
                { srcPath: '/a.flac', bitrateKbps: 256, timeOffset: 0 },
                { hasFdkAac: false },
                '/out.m4a',
            );
            const i = args.indexOf('-i');
            expect(args[i - 2]).toBe('-protocol_whitelist');
            expect(args[i - 1]).toBe('file');
        });

        it('buildStreamCopySeekArgs carries -protocol_whitelist file immediately before -i', () => {
            const args = buildStreamCopySeekArgs({
                cachedPath: '/c.mp3',
                codec: 'mp3',
                timeOffset: 15,
            });
            const i = args.indexOf('-i');
            expect(args[i - 2]).toBe('-protocol_whitelist');
            expect(args[i - 1]).toBe('file');
        });

        // Control: seek prefix still lands before the whitelist, which still
        // lands immediately before -i.
        it('places the whitelist after -ss but still immediately before -i', () => {
            const args = buildMp3EncodeArgs({
                srcPath: '/a.flac',
                bitrateKbps: 192,
                timeOffset: 30,
            });
            const ssIndex = args.indexOf('-ss');
            const i = args.indexOf('-i');
            expect(ssIndex).toBeLessThan(i);
            expect(args[i - 2]).toBe('-protocol_whitelist');
            expect(args[i - 1]).toBe('file');
        });
    });
});
