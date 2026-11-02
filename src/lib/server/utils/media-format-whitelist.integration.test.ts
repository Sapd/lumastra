// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `media-format-whitelist.ts` against the REAL ffmpeg (FFMPEG_PATH — the pinned
 * jellyfin-ffmpeg on the CI integration shards). This is the gate for wiring
 * the list into `FFmpegArgsBuilder` (fix plan 6, final wave F4): a wrong list
 * fails EVERY playback of the containers it misses (precedent: `a81a3e769`,
 * the audiobook remux's static list refused real `.amr` books), so it has to
 * be shown on the production binary, not a developer's ffmpeg.
 *
 * 1. The enumeration parses the binary's `-demuxers` output.
 * 2. Real mp4/mkv/webm/avi/ts/m2ts/wmv inputs transcode with the list, each
 *    through the demuxer that normally reads it.
 * 3. ffconcat, HLS and MPD bodies saved as `.mkv` are refused without opening
 *    the file they name. Each has a no-whitelist control run, so "not opened"
 *    is measured against a run that shows what opening looks like.
 * 4. The concat-list variant (the app's own `-f concat` list): real parts
 *    play; a part rewritten into an MPD body is refused.
 *
 * Every ffmpeg run here is argv the builder would emit around `-i`:
 * `-protocol_whitelist file -format_whitelist <list> -i <path>`.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    getConcatListFormatWhitelist,
    getConcatPartFormatWhitelist,
    getMediaFormatWhitelist,
    parseDemuxerNames,
    prepareMediaFormatWhitelist,
    resetMediaFormatWhitelistCache,
} from './media-format-whitelist.js';
import { FFmpegArgsBuilder } from '../services/transcoding/ffmpeg-args-builder.js';
import { buildConcatListContent } from '../services/hls/playback.service.js';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';

function run(args: string[]): { code: number | null; stderr: string } {
    const r = spawnSync(FFMPEG, ['-hide_banner', '-nostdin', ...args], {
        encoding: 'utf-8',
        timeout: 120_000,
        maxBuffer: 64 * 1024 * 1024,
    });
    return { code: r.status, stderr: r.stderr ?? '' };
}

function tryOutput(args: string[]): string {
    try {
        return execFileSync(FFMPEG, args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
        return '';
    }
}

const DEMUXERS_OUTPUT = tryOutput(['-hide_banner', '-demuxers']);
const VERSION_LINE = tryOutput(['-version']).split('\n')[0] ?? '';
const HAS_FFMPEG = DEMUXERS_OUTPUT !== '';
const RAW_NAMES = new Set(
    DEMUXERS_OUTPUT.split('\n')
        .map((l) => /^ D[E. ][d. ] (\S+)/.exec(l)?.[1])
        .filter((n): n is string => !!n && n !== '='),
);
const HAS_DASH = RAW_NAMES.has('dash');

/** The pinned version from the Dockerfile (`ENV FFMPEG_VERSION=v7.1.4-3` → `7.1.4`). */
const PINNED = /ENV FFMPEG_VERSION=v(\d+\.\d+\.\d+)/.exec(
    readFileSync(join(process.cwd(), 'Dockerfile'), 'utf-8'),
)?.[1];
const IS_PINNED = !!PINNED && VERSION_LINE.includes(`version ${PINNED}-Jellyfin`);

/** `-t 1` transcode of `input` to nothing, the input carrying `formatWhitelist`. */
function transcode(inputArgs: string[]) {
    return run([
        ...['-loglevel', 'info', '-stats'],
        ...inputArgs,
        ...['-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'null', '-'],
    ]);
}

function framesOut(stderr: string): number {
    const all = [...stderr.matchAll(/frame=\s*(\d+)/g)];
    return all.length ? Number(all[all.length - 1][1]) : 0;
}

/** Whether ffmpeg opened `sub/ref.mp4` — io_open_default's debug line, printed for every open. */
function openedRef(stderr: string): boolean {
    return stderr.includes("sub/ref.mp4' for reading");
}

describe.skipIf(!HAS_FFMPEG)('media format whitelist on the real ffmpeg', () => {
    let dir: string;
    let whitelist: string;
    let concatWhitelist: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-fmt-wl-'));
        await mkdir(join(dir, 'sub'));
        const src = [
            ...['-loglevel', 'error', '-f', 'lavfi', '-i'],
            'testsrc2=size=320x240:rate=25:duration=2',
            ...['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2'],
        ];
        const make = (codecs: string[], out: string) => {
            const r = run([...src, ...codecs, join(dir, out)]);
            if (r.code !== 0) throw new Error(`fixture ${out}: ${r.stderr}`);
        };
        make(['-c:v', 'libx264', '-c:a', 'aac'], 'a.mp4');
        make(['-c:v', 'libx264', '-c:a', 'aac'], 'a.mkv');
        make(['-c:v', 'libvpx-vp9', '-c:a', 'libopus'], 'a.webm');
        make(['-c:v', 'mpeg4', '-c:a', 'libmp3lame'], 'a.avi');
        make(['-c:v', 'mpeg2video', '-c:a', 'ac3', '-f', 'mpegts'], 'a.ts');
        // Blu-ray style: 192-byte packets (4-byte timestamp prefix).
        make(
            ['-c:v', 'libx264', '-c:a', 'ac3', '-f', 'mpegts', '-mpegts_m2ts_mode', '1'],
            'a.m2ts',
        );
        make(['-c:v', 'wmv2', '-c:a', 'wmav2', '-f', 'asf'], 'a.wmv');
        make(['-c:v', 'libx264', '-c:a', 'aac'], 'sub/ref.mp4');

        // Bodies naming `sub/ref.mp4` RELATIVELY: the concat demuxer's default
        // `-safe 1` refuses absolute paths, and dash refuses `.mkv` segments
        // (allowed_extensions), so these are the forms that DO get followed.
        await writeFile(join(dir, 'concat-body.mkv'), 'ffconcat version 1.0\nfile sub/ref.mp4\n');
        await writeFile(
            join(dir, 'hls-body.mkv'),
            '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nsub/ref.mp4\n#EXT-X-ENDLIST\n',
        );
        await writeFile(
            join(dir, 'mpd-body.mkv'),
            '<?xml version="1.0"?>\n' +
                '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ' +
                'mediaPresentationDuration="PT2S" minBufferTime="PT1S" ' +
                'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period>' +
                '<AdaptationSet mimeType="video/mp4"><Representation id="v" bandwidth="64000">' +
                '<BaseURL>sub/ref.mp4</BaseURL></Representation></AdaptationSet></Period></MPD>\n',
        );

        whitelist = getMediaFormatWhitelist(FFMPEG)!;
        concatWhitelist = getConcatListFormatWhitelist(FFMPEG)!;
    }, 300_000);

    afterAll(async () => {
        if (dir) await rm(dir, { recursive: true, force: true });
    });

    describe('the binary under test', () => {
        it.runIf(!!process.env.CI && !!process.env.FFMPEG_PATH)(
            'on CI it is the pinned jellyfin-ffmpeg, with the dash and imf demuxers',
            () => {
                expect(VERSION_LINE).toContain(`version ${PINNED}-Jellyfin`);
                expect(RAW_NAMES.has('dash')).toBe(true);
                expect(RAW_NAMES.has('imf')).toBe(true);
            },
        );
    });

    describe('enumeration', () => {
        it('parses one name per demuxer row, device rows included', () => {
            const names = parseDemuxerNames(DEMUXERS_OUTPUT)!;

            expect(new Set(names)).toEqual(RAW_NAMES);
            expect(names).toEqual(
                expect.arrayContaining(['matroska,webm', 'mov,mp4,m4a,3gp,3g2,mj2', 'avi', 'asf']),
            );
            expect(names).toContain('mpegts');
            expect(names.every((n) => /^[\w,-]+$/.test(n))).toBe(true);
            if (IS_PINNED) {
                // Linux build: device demuxers print as `D d <name>`.
                expect(names).toEqual(expect.arrayContaining(['lavfi', 'video4linux2,v4l2']));
            }
        });

        it('the media list is every demuxer but hls, dash, concat, imf, sdp and sap', () => {
            const listed = new Set(whitelist.split(','));
            const excluded = ['hls', 'dash', 'concat', 'imf', 'sdp', 'sap'];
            for (const name of excluded) expect(listed.has(name)).toBe(false);

            const expected = [...RAW_NAMES].filter((n) => !excluded.includes(n));
            expect(whitelist).toBe(expected.join(','));
            // What this binary would otherwise have picked (dash/imf only on a libxml2 build).
            expect(excluded.filter((n) => RAW_NAMES.has(n)).length).toBeGreaterThanOrEqual(4);
        });

        it('the async prepare (the spawn paths) yields the same lists as the sync probe', async () => {
            resetMediaFormatWhitelistCache();
            await prepareMediaFormatWhitelist(FFMPEG);

            expect(getMediaFormatWhitelist(FFMPEG)).toBe(whitelist);
            expect(getConcatListFormatWhitelist(FFMPEG)).toBe(concatWhitelist);
        });

        it('the concat-list variant adds concat and nothing else', () => {
            expect(concatWhitelist.split(',').sort()).toEqual(
                [...whitelist.split(','), 'concat'].sort(),
            );
        });
    });

    describe('real media transcodes with the list', () => {
        const CASES: Array<[file: string, demuxer: string]> = [
            ['a.mp4', 'mov,mp4,m4a,3gp,3g2,mj2'],
            ['a.mkv', 'matroska,webm'],
            ['a.webm', 'matroska,webm'],
            ['a.avi', 'avi'],
            ['a.ts', 'mpegts'],
            ['a.m2ts', 'mpegts'],
            ['a.wmv', 'asf'],
        ];

        it.each(CASES)('%s (read by %s)', (file, demuxer) => {
            const r = transcode([
                ...['-protocol_whitelist', 'file', '-format_whitelist', whitelist],
                ...['-i', join(dir, file)],
            ]);

            expect(r.stderr).not.toContain('not on whitelist');
            expect(r.code).toBe(0);
            expect(r.stderr).toContain(`Input #0, ${demuxer}, from`);
            expect(framesOut(r.stderr)).toBeGreaterThanOrEqual(20);
        });
    });

    describe('playlist bodies saved as .mkv are refused before the file they name is opened', () => {
        function probe(file: string, withWhitelist: boolean) {
            return run([
                ...['-loglevel', 'debug', '-protocol_whitelist', 'file'],
                ...(withWhitelist ? ['-format_whitelist', whitelist] : []),
                ...['-i', join(dir, file), '-t', '1', '-f', 'null', '-'],
            ]);
        }

        it('ffconcat: the control follows the reference; with the list, concat is refused', () => {
            const control = probe('concat-body.mkv', false);
            expect(control.stderr).toContain('Format concat probed');
            expect(openedRef(control.stderr)).toBe(true);

            const r = probe('concat-body.mkv', true);
            expect(r.stderr).toContain('Format not on whitelist');
            expect(openedRef(r.stderr)).toBe(false);
            expect(r.code).not.toBe(0);
        });

        it.skipIf(!HAS_DASH)(
            'MPD: the control follows the BaseURL; with the list, dash is refused',
            () => {
                const control = probe('mpd-body.mkv', false);
                expect(control.stderr).toContain('Format dash probed');
                expect(openedRef(control.stderr)).toBe(true);

                const r = probe('mpd-body.mkv', true);
                expect(r.stderr).toContain('Format not on whitelist');
                expect(openedRef(r.stderr)).toBe(false);
                expect(r.code).not.toBe(0);
            },
        );

        it('HLS: not followed with the list (hls is excluded above)', () => {
            // On 7.1.4 hls_probe itself declines an `#EXTM3U` body whose name
            // does not end in .m3u8/.m3u/.hls ("Not detecting m3u8/hls with
            // non standard extension"), so the control does not follow either;
            // the list is the second line should a build ever detect it.
            const control = probe('hls-body.mkv', false);
            const r = probe('hls-body.mkv', true);

            expect(openedRef(r.stderr)).toBe(false);
            expect(r.code).not.toBe(0);
            if (openedRef(control.stderr)) expect(r.stderr).toContain('Format not on whitelist');
        });
    });

    describe('the concat-list variant (-f concat -safe 0, the app’s own list)', () => {
        const listLine = (p: string) => `file '${p.replace(/'/g, "'\\''")}'`;

        async function concatRun(name: string, parts: string[], wl: string | null, extra = '') {
            const list = join(dir, name);
            await writeFile(list, parts.map((p) => listLine(join(dir, p)) + extra).join('\n'));
            return run([
                ...['-loglevel', 'debug', '-stats'],
                ...['-f', 'concat', '-safe', '0', '-protocol_whitelist', 'file'],
                ...(wl ? ['-format_whitelist', wl] : []),
                ...['-i', list],
                ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-f', 'null', '-'],
            ]);
        }

        it('real parts play through', async () => {
            const r = await concatRun('list-real.txt', ['a.mkv', 'a.mp4'], concatWhitelist);

            expect(r.stderr).not.toContain('not on whitelist');
            expect(r.code).toBe(0);
            // Two 2 s parts at 25 fps.
            expect(framesOut(r.stderr)).toBeGreaterThanOrEqual(90);
        });

        it.skipIf(!HAS_DASH)('a part rewritten into an MPD body is refused', async () => {
            const control = await concatRun(
                'list-mpd-control.txt',
                ['a.mkv', 'mpd-body.mkv'],
                null,
            );
            expect(openedRef(control.stderr)).toBe(true);

            const r = await concatRun('list-mpd.txt', ['a.mkv', 'mpd-body.mkv'], concatWhitelist);
            expect(r.stderr).toContain('Format not on whitelist');
            expect(openedRef(r.stderr)).toBe(false);
        });

        it('RESIDUAL: a part rewritten into an ffconcat body is still followed (concat is copied into part opens)', async () => {
            const r = await concatRun(
                'list-concat.txt',
                ['a.mkv', 'concat-body.mkv'],
                concatWhitelist,
            );

            expect(openedRef(r.stderr)).toBe(true);
        });

        it('a per-part `option format_whitelist` directive closes that residual, and real parts still play', async () => {
            const perPart = `\noption format_whitelist '${whitelist}'`;

            const nested = await concatRun(
                'list-concat-opt.txt',
                ['a.mkv', 'concat-body.mkv'],
                concatWhitelist,
                perPart,
            );
            expect(nested.stderr).toContain('Format not on whitelist');
            expect(openedRef(nested.stderr)).toBe(false);

            const real = await concatRun(
                'list-real-opt.txt',
                ['a.mkv', 'a.mp4'],
                concatWhitelist,
                perPart,
            );
            expect(real.stderr).not.toContain('not on whitelist');
            expect(real.code).toBe(0);
            expect(framesOut(real.stderr)).toBeGreaterThanOrEqual(90);
        });
    });
    // The seam: the argv the app's own builder emits (config.FFMPEG_PATH is
    // this same binary here), not a hand-written copy of it.
    describe('through FFmpegArgsBuilder.addInputFile', () => {
        /** The builder's global + input args at debug level, then a `-t 1` transcode. */
        function builderRun(file: string) {
            const args = new FFmpegArgsBuilder().addInputFile(join(dir, file)).build();
            args[args.indexOf('-loglevel') + 1] = 'debug';
            return {
                args,
                ...run([
                    ...args,
                    ...['-t', '1', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'],
                    ...['-f', 'null', '-'],
                ]),
            };
        }

        it('carries the enumerated list on the input', () => {
            const { args } = builderRun('a.mkv');

            expect(args[args.indexOf('-format_whitelist') + 1]).toBe(whitelist);
            expect(args.indexOf('-format_whitelist')).toBeLessThan(args.indexOf('-i'));
        });

        it.each(['a.mp4', 'a.mkv', 'a.webm', 'a.avi', 'a.ts', 'a.m2ts', 'a.wmv'])(
            'real %s transcodes',
            (file) => {
                const r = builderRun(file);

                expect(r.stderr).not.toContain('not on whitelist');
                expect(r.code).toBe(0);
                expect(framesOut(r.stderr)).toBeGreaterThanOrEqual(20);
            },
        );

        it('an ffconcat body saved as .mkv is refused without opening what it names', () => {
            const r = builderRun('concat-body.mkv');

            expect(r.stderr).toContain('Format not on whitelist');
            expect(openedRef(r.stderr)).toBe(false);
            expect(r.code).not.toBe(0);
        });

        it.skipIf(!HAS_DASH)(
            'an MPD body saved as .mkv is refused without opening what it names',
            () => {
                const r = builderRun('mpd-body.mkv');

                expect(r.stderr).toContain('Format not on whitelist');
                expect(openedRef(r.stderr)).toBe(false);
                expect(r.code).not.toBe(0);
            },
        );
    });
    // The seam for the concat path: the list the app writes
    // (buildConcatListContent with the per-part option line) opened with the
    // argv addConcatInputFile emits.
    describe('through buildConcatListContent + FFmpegArgsBuilder.addConcatInputFile', () => {
        async function appConcatRun(name: string, parts: string[]) {
            const list = join(dir, name);
            const partWhitelist = getConcatPartFormatWhitelist(FFMPEG);
            await writeFile(
                list,
                buildConcatListContent(
                    parts.map((p) => join(dir, p)),
                    partWhitelist,
                ),
            );
            const args = new FFmpegArgsBuilder().addConcatInputFile(list).build();
            args[args.indexOf('-loglevel') + 1] = 'debug';
            return {
                partWhitelist,
                ...run([
                    ...args,
                    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac'],
                    ...['-f', 'null', '-'],
                ]),
            };
        }

        it('this binary gets the per-part line (libavformat >= 59.16)', async () => {
            const { partWhitelist } = await appConcatRun('app-list-real.txt', ['a.mkv']);

            expect(partWhitelist).toBe(whitelist);
        });

        it('real parts play through', async () => {
            const r = await appConcatRun('app-list-real2.txt', ['a.mkv', 'a.mp4']);

            expect(r.stderr).not.toContain('not on whitelist');
            expect(r.code).toBe(0);
            expect(framesOut(r.stderr)).toBeGreaterThanOrEqual(90);
        });

        it('a part rewritten into an ffconcat body is refused (the residual above, closed)', async () => {
            const r = await appConcatRun('app-list-concat.txt', ['a.mkv', 'concat-body.mkv']);

            expect(r.stderr).toContain('Format not on whitelist');
            expect(openedRef(r.stderr)).toBe(false);
        });

        it.skipIf(!HAS_DASH)('a part rewritten into an MPD body is refused', async () => {
            const r = await appConcatRun('app-list-mpd.txt', ['a.mkv', 'mpd-body.mkv']);

            expect(r.stderr).toContain('Format not on whitelist');
            expect(openedRef(r.stderr)).toBe(false);
        });
    });
});
