// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const execFileSync = vi.hoisted(() => vi.fn());
const execFile = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('node:child_process')>()),
    execFileSync,
    execFile,
}));

import {
    buildFormatWhitelist,
    getConcatListFormatWhitelist,
    getConcatPartFormatWhitelist,
    getMediaFormatWhitelist,
    parseDemuxerNames,
    parseLibavformatVersion,
    prepareMediaFormatWhitelist,
    resetMediaFormatWhitelistCache,
} from './media-format-whitelist.js';

/**
 * Verbatim rows of `ffmpeg -hide_banner -demuxers` from the pinned
 * jellyfin-ffmpeg 7.1.4-3 (linuxarm64): the legend, every excluded demuxer,
 * device rows (`D d`), comma-joined aliases, and a name longer than the
 * 15-column pad.
 */
const OUTPUT_714 = [
    'Formats:',
    ' D.. = Demuxing supported',
    ' .E. = Muxing supported',
    ' ..d = Is a device',
    ' ---',
    ' D   3dostr          3DO STR',
    ' D   aac             raw ADTS AAC (Advanced Audio Coding)',
    ' D   amr             3GPP AMR',
    ' D   asf             ASF (Advanced / Active Streaming Format)',
    ' D   avi             AVI (Audio Video Interleaved)',
    ' D   concat          Virtual concatenation script',
    ' D   dash            Dynamic Adaptive Streaming over HTTP',
    ' D d fbdev           Linux framebuffer',
    ' D   hls             Apple HTTP Live Streaming',
    ' D   imf             IMF (Interoperable Master Format)',
    ' D d lavfi           Libavfilter virtual input device',
    ' D   matroska,webm   Matroska / WebM',
    ' D   mov,mp4,m4a,3gp,3g2,mj2 QuickTime / MOV',
    ' D   mpegts          MPEG-TS (MPEG-2 Transport Stream)',
    ' D   sap             SAP input',
    ' D   sdp             SDP',
    ' D d video4linux2,v4l2 Video4Linux2 device grab',
    ' D   webm_dash_manifest WebM DASH Manifest',
    '',
].join('\n');

describe('parseDemuxerNames', () => {
    it('reads every row after the separator, device rows and aliases included, and not the legend', () => {
        expect(parseDemuxerNames(OUTPUT_714)).toEqual([
            '3dostr',
            'aac',
            'amr',
            'asf',
            'avi',
            'concat',
            'dash',
            'fbdev',
            'hls',
            'imf',
            'lavfi',
            'matroska,webm',
            'mov,mp4,m4a,3gp,3g2,mj2',
            'mpegts',
            'sap',
            'sdp',
            'video4linux2,v4l2',
            'webm_dash_manifest',
        ]);
    });

    it('returns null for output without the separator (the legend alone would parse as "=")', () => {
        expect(parseDemuxerNames(OUTPUT_714.replace(' ---\n', ''))).toBeNull();
    });

    it('returns null when no row follows the separator', () => {
        expect(parseDemuxerNames('Formats:\n ---\n')).toBeNull();
        expect(parseDemuxerNames('')).toBeNull();
    });
});

describe('buildFormatWhitelist', () => {
    const names = parseDemuxerNames(OUTPUT_714)!;

    it('drops hls, dash, concat, imf, sdp and sap and keeps everything else, devices included', () => {
        expect(buildFormatWhitelist(names, false)).toBe(
            '3dostr,aac,amr,asf,avi,fbdev,lavfi,matroska,webm,mov,mp4,m4a,3gp,3g2,mj2,mpegts,' +
                'video4linux2,v4l2,webm_dash_manifest',
        );
    });

    it('keeps concat, and only concat, for the concat-list variant', () => {
        const list = buildFormatWhitelist(names, true).split(',');
        expect(list).toContain('concat');
        for (const excluded of ['hls', 'dash', 'imf', 'sdp', 'sap']) {
            expect(list).not.toContain(excluded);
        }
    });

    it('drops a row when ANY of its aliases is reference-following', () => {
        expect(buildFormatWhitelist(['hls,applehttp', 'mpegts'], false)).toBe('mpegts');
    });

    it('does not drop a name that merely contains an excluded one', () => {
        expect(buildFormatWhitelist(['webm_dash_manifest', 'sdp2', 'imfx'], false)).toBe(
            'webm_dash_manifest,sdp2,imfx',
        );
    });
});

describe('getMediaFormatWhitelist / getConcatListFormatWhitelist', () => {
    beforeEach(() => {
        resetMediaFormatWhitelistCache();
        execFileSync.mockReset();
        vi.useRealTimers();
    });

    it('enumerates the given binary with -hide_banner -demuxers', () => {
        execFileSync.mockReturnValue(OUTPUT_714);

        expect(getMediaFormatWhitelist('/opt/ff/ffmpeg')?.split(',')).toContain('matroska');
        expect(execFileSync).toHaveBeenCalledWith(
            '/opt/ff/ffmpeg',
            ['-hide_banner', '-demuxers'],
            expect.objectContaining({ encoding: 'utf-8' }),
        );
    });

    it('enumerates once per binary path, shared by both variants', () => {
        execFileSync.mockReturnValue(OUTPUT_714);

        getMediaFormatWhitelist('/a/ffmpeg');
        getConcatListFormatWhitelist('/a/ffmpeg');
        getMediaFormatWhitelist('/a/ffmpeg');
        expect(execFileSync).toHaveBeenCalledTimes(1);

        getMediaFormatWhitelist('/b/ffmpeg');
        expect(execFileSync).toHaveBeenCalledTimes(2);
    });

    it('returns null when the binary cannot run, and retries only after a back-off', () => {
        vi.useFakeTimers();
        execFileSync.mockImplementation(() => {
            throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
        });

        expect(getMediaFormatWhitelist('/missing/ffmpeg')).toBeNull();
        expect(getConcatListFormatWhitelist('/missing/ffmpeg')).toBeNull();
        expect(execFileSync).toHaveBeenCalledTimes(1);

        execFileSync.mockReturnValue(OUTPUT_714);
        vi.advanceTimersByTime(61_000);
        expect(getMediaFormatWhitelist('/missing/ffmpeg')).not.toBeNull();
        expect(execFileSync).toHaveBeenCalledTimes(2);
    });

    it('returns null without spawning, and without throwing, for an empty path', () => {
        execFileSync.mockReturnValue(OUTPUT_714);

        expect(getMediaFormatWhitelist('')).toBeNull();
        expect(getConcatListFormatWhitelist('')).toBeNull();
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('returns null for output it does not recognise', () => {
        execFileSync.mockReturnValue('ffmpeg: unrecognized option -demuxers\n');

        expect(getMediaFormatWhitelist('/odd/ffmpeg')).toBeNull();
    });
});

/** `ffmpeg -hide_banner -version` of the pinned 7.1.4-3, trimmed to the lines that matter. */
const VERSION_714 = [
    'ffmpeg version 7.1.4-Jellyfin Copyright (c) 2000-2026 the FFmpeg developers',
    'libavutil      59. 39.100 / 59. 39.100',
    'libavformat    61.  7.103 / 61.  7.103',
    '',
].join('\n');

describe('parseLibavformatVersion', () => {
    it('reads major and minor, whatever the column padding', () => {
        expect(parseLibavformatVersion(VERSION_714)).toEqual([61, 7]);
        expect(parseLibavformatVersion('libavformat    58. 76.100 / 58. 76.100\n')).toEqual([
            58, 76,
        ]);
    });

    it('returns null when there is no libavformat line', () => {
        expect(parseLibavformatVersion('ffmpeg version N-1\nlibavutil 59. 1.100\n')).toBeNull();
    });
});

describe('getConcatPartFormatWhitelist (per-part concat option line)', () => {
    beforeEach(() => {
        resetMediaFormatWhitelistCache();
        execFileSync.mockReset();
    });

    function binary(version: string) {
        execFileSync.mockImplementation((_path: string, args: string[]) =>
            args.includes('-demuxers') ? OUTPUT_714 : version,
        );
    }

    it('is the media list (no concat) on a binary whose concat demuxer reads per-file options', () => {
        binary(VERSION_714);

        const part = getConcatPartFormatWhitelist('/ff/ffmpeg');
        expect(part).toBe(getMediaFormatWhitelist('/ff/ffmpeg'));
        expect(part!.split(',')).not.toContain('concat');
    });

    it.each([
        ['4.4 (lavf 58.76)', 'libavformat    58. 76.100 / 58. 76.100'],
        ['a git build before 5.0 (lavf 59.15)', 'libavformat    59. 15.100 / 59. 15.100'],
        ['an unrecognised -version', 'ffmpeg version ???'],
    ])(
        'is null on %s: a 4.x concat demuxer fails the whole list on the line',
        (_label, version) => {
            binary(version);

            expect(getConcatPartFormatWhitelist('/old/ffmpeg')).toBeNull();
            // The list-level whitelist does not depend on it.
            expect(getConcatListFormatWhitelist('/old/ffmpeg')).not.toBeNull();
        },
    );

    it('is non-null from 5.0 (lavf 59.16)', () => {
        binary('libavformat    59. 16.100 / 59. 16.100');

        expect(getConcatPartFormatWhitelist('/ff5/ffmpeg')).not.toBeNull();
    });

    it('is null when the demuxers could not be enumerated, without asking for the version', () => {
        execFileSync.mockImplementation(() => {
            throw new Error('spawn ENOENT');
        });

        expect(getConcatPartFormatWhitelist('/missing/ffmpeg')).toBeNull();
        expect(execFileSync).toHaveBeenCalledTimes(1);
    });

    it('asks each binary for its version once', () => {
        binary(VERSION_714);

        getConcatPartFormatWhitelist('/ff/ffmpeg');
        getConcatPartFormatWhitelist('/ff/ffmpeg');
        expect(execFileSync).toHaveBeenCalledTimes(2); // -demuxers + -version
    });
});

describe('prepareMediaFormatWhitelist (off the event loop)', () => {
    type Callback = (error: Error | null, stdout: string) => void;
    let pending: Array<{ args: string[]; cb: Callback }>;

    beforeEach(() => {
        resetMediaFormatWhitelistCache();
        execFileSync.mockReset();
        execFile.mockReset();
        pending = [];
        execFile.mockImplementation(
            (_path: string, args: string[], _opts: unknown, cb: Callback) => {
                pending.push({ args, cb });
            },
        );
    });

    function answer(version = VERSION_714) {
        for (const { args, cb } of pending.splice(0)) {
            cb(null, args.includes('-demuxers') ? OUTPUT_714 : version);
        }
    }

    it('probes with async execFile, and the sync getters then read the cache without spawning', async () => {
        const ready = prepareMediaFormatWhitelist('/ff/ffmpeg');
        expect(pending.map((p) => p.args)).toEqual([
            ['-hide_banner', '-demuxers'],
            ['-hide_banner', '-version'],
        ]);
        answer();
        await ready;

        expect(getMediaFormatWhitelist('/ff/ffmpeg')?.split(',')).toContain('matroska');
        expect(getConcatListFormatWhitelist('/ff/ffmpeg')?.split(',')).toContain('concat');
        expect(getConcatPartFormatWhitelist('/ff/ffmpeg')).not.toBeNull();
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('shares one run between concurrent callers, and does not re-probe once settled', async () => {
        const a = prepareMediaFormatWhitelist('/ff/ffmpeg');
        const b = prepareMediaFormatWhitelist('/ff/ffmpeg');
        answer();
        await Promise.all([a, b]);
        await prepareMediaFormatWhitelist('/ff/ffmpeg');

        expect(execFile).toHaveBeenCalledTimes(2);
    });

    it('caches a failure: the getters return null within the back-off without a sync spawn', async () => {
        const ready = prepareMediaFormatWhitelist('/hang/ffmpeg');
        for (const { cb } of pending.splice(0)) cb(new Error('timed out'), '');
        await ready;

        expect(getMediaFormatWhitelist('/hang/ffmpeg')).toBeNull();
        expect(getConcatPartFormatWhitelist('/hang/ffmpeg')).toBeNull();
        expect(execFileSync).not.toHaveBeenCalled();
    });

    it('never rejects, even when execFile throws synchronously', async () => {
        execFile.mockImplementation(() => {
            throw new TypeError('execFile is not a function');
        });

        await expect(prepareMediaFormatWhitelist('/bad/ffmpeg')).resolves.toBeUndefined();
        expect(getMediaFormatWhitelist('/bad/ffmpeg')).toBeNull();
    });

    it('returns null (nothing to await) for an empty path and once both probes settled', async () => {
        expect(prepareMediaFormatWhitelist('')).toBeNull();
        const ready = prepareMediaFormatWhitelist('/ff/ffmpeg');
        expect(ready).toBeInstanceOf(Promise);
        answer();
        await ready;
        expect(prepareMediaFormatWhitelist('/ff/ffmpeg')).toBeNull();
    });

    it('is a no-op for an empty path', async () => {
        await prepareMediaFormatWhitelist('');

        expect(execFile).not.toHaveBeenCalled();
    });

    it('keeps each binary path cached, so switching back and forth never re-probes', async () => {
        const a = prepareMediaFormatWhitelist('/a/ffmpeg');
        answer();
        await a;
        const b = prepareMediaFormatWhitelist('/b/ffmpeg');
        answer();
        await b;
        await prepareMediaFormatWhitelist('/a/ffmpeg');
        getMediaFormatWhitelist('/a/ffmpeg');
        getMediaFormatWhitelist('/b/ffmpeg');

        expect(execFile).toHaveBeenCalledTimes(4);
        expect(execFileSync).not.toHaveBeenCalled();
    });
});

describe('a binary with only reference-following demuxers', () => {
    beforeEach(() => {
        resetMediaFormatWhitelistCache();
        execFileSync.mockReset();
        execFileSync.mockImplementation((_path: string, args: string[]) =>
            args.includes('-demuxers')
                ? 'Formats:\n ---\n D   hls             Apple HTTP Live Streaming\n D   dash            DASH\n'
                : VERSION_714,
        );
    });

    it('yields null (warned), not an empty list the builder would silently skip', () => {
        expect(getMediaFormatWhitelist('/min/ffmpeg')).toBeNull();
        expect(getConcatPartFormatWhitelist('/min/ffmpeg')).toBeNull();
    });
});
