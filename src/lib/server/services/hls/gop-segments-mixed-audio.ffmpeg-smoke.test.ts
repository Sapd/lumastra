// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real ffmpeg: a GOP-mode demux copy job whose audio renditions MIX copied and
 * transcoded tracks serves every rendition on the declared grid.
 *
 * Found on prod 2026-11-02 (TNG S3E16, German AC3 + English AC3 + English DTS
 * + English AC3 on an Apple TV): the copied AC3 renditions were right, but the
 * DTS track — transcoded to AAC because DTS is not HLS-compatible — came out
 * with segment_1 holding a single 0.49 s part at 5.995 s under an EXTINF of
 * 14.431 s. AVPlayer froze the moment that rendition was selected. The
 * existing smoke test only covers "every track transcoded" (-af aresample) and
 * "every track copied"; this one is the mixed layout.
 *
 * Runs only with LUMASTRA_FFMPEG_SMOKE=1 and ffmpeg/ffprobe on PATH.
 */

import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';

import { FullTranscodeStrategy } from '../transcoding/full-transcode-strategy';
import {
    GOP_AUDIO_PART_PREFIX,
    GOP_VIDEO_PART_PREFIX,
    gopAudioPartsDirName,
    gopVideoPartsDirName,
} from '../transcoding/gop-output-args';
import type { FullStrategyConfig } from '../transcoding/transcode-strategy';
import { readFragmentStart, readTrackTimescale } from './fmp4-timing';
import { buildGopGrid, type GopGrid } from './gop-grid';
import { GopSegmentAssembler } from './gop-segment-assembler';

function haveFfmpeg(): boolean {
    try {
        execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
        execFileSync('ffprobe', ['-version'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

/** Irregular keyframes (seconds): 10.4 / 14.4 / 10 … like a Blu-ray remux. */
const FORCED_KEYFRAMES = [0, 10.4, 24.8, 35, 48, 61.5, 72, 85.5, 96, 108];
const DURATION = 115;

const AUDIO = [0, 1, 2, 3];
let dir: string;
let source: string;
let grid: GopGrid;

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function probe(args: string[]): string {
    return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' });
}

interface Fragment {
    start: number;
    span: number;
}

/** Decode start and summed sample duration of every moof in a segment. */
function fragments(seg: Buffer, timescale: number): Fragment[] {
    const out: Fragment[] = [];
    let off = 0;
    while (off + 8 <= seg.length) {
        const size = seg.readUInt32BE(off);
        const type = seg.toString('latin1', off + 4, off + 8);
        if (type === 'moof') {
            const t = readFragmentStart(seg.subarray(off, off + size), timescale);
            if (t) out.push({ start: t.decodeSeconds, span: 0 });
        }
        off += size || seg.length;
    }
    return out;
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('GOP-mode demux copy with copied AND transcoded audio renditions, real ffmpeg', () => {
    const streams: Record<string, number[]> = {};
    const spans: Record<string, number[]> = {};
    /** Largest baseMediaDecodeTime (unsigned, in ticks) across a rendition's segments. */
    const rawTfdtMax: Record<string, number> = {};
    let root: string;

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'gop-mixed-'));
        source = join(dir, 'src.mkv');
        // Four audio tracks like the prod file: AC3 (copied), AC3 (copied),
        // DTS 5.1 (not HLS-compatible → 6-channel AAC), AC3 (copied).
        execFileSync(
            'ffmpeg',
            [
                ...['-hide_banner', '-loglevel', 'error', '-y'],
                ...['-f', 'lavfi', '-i', `testsrc2=size=320x240:rate=24:duration=${DURATION}`],
                ...[
                    '-f',
                    'lavfi',
                    '-i',
                    `sine=frequency=440:sample_rate=48000:duration=${DURATION}`,
                ],
                ...[
                    '-f',
                    'lavfi',
                    '-i',
                    `sine=frequency=660:sample_rate=48000:duration=${DURATION}`,
                ],
                ...[
                    '-f',
                    'lavfi',
                    '-i',
                    `sine=frequency=880:sample_rate=48000:duration=${DURATION}`,
                ],
                ...[
                    '-f',
                    'lavfi',
                    '-i',
                    `anoisesrc=color=pink:sample_rate=48000:duration=${DURATION}:seed=7,aformat=channel_layouts=5.1`,
                ],
                ...['-map', '0:v', '-map', '1:a', '-map', '2:a', '-map', '4:a', '-map', '3:a'],
                ...['-c:v', 'libx264', '-preset', 'ultrafast'],
                ...['-x264-params', 'keyint=100000:min-keyint=1:scenecut=0:bframes=2'],
                ...['-force_key_frames', FORCED_KEYFRAMES.join(',')],
                ...['-c:a:0', 'ac3', '-b:a:0', '192k'],
                ...['-c:a:1', 'ac3', '-b:a:1', '192k'],
                ...['-c:a:2', 'dca', '-strict', '-2', '-b:a:2', '768k'],
                ...['-c:a:3', 'ac3', '-b:a:3', '192k'],
                source,
            ],
            { stdio: 'pipe', timeout: 180_000 },
        );
        const keyframes = probe([
            '-select_streams',
            'v:0',
            '-show_entries',
            'packet=pts_time,flags',
            '-of',
            'csv=p=0',
            source,
        ])
            .trim()
            .split('\n')
            .filter((l) => l.includes('K'))
            .map((l) => parseFloat(l.split(',')[0]));
        const total = parseFloat(
            probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', source]),
        );
        grid = buildGopGrid(keyframes, total, 10)!;

        root = join(dir, 'gen');
        const audioTracks = [
            {
                index: asAbsoluteStreamIndex(1),
                displayTitle: 'German',
                language: 'ger',
                channels: 2,
                codec: 'ac3',
                isDefault: true,
            },
            {
                index: asAbsoluteStreamIndex(2),
                displayTitle: 'English',
                language: 'eng',
                channels: 2,
                codec: 'ac3',
                isDefault: false,
            },
            {
                index: asAbsoluteStreamIndex(3),
                displayTitle: 'English',
                language: 'eng',
                channels: 6,
                codec: 'dts',
                isDefault: false,
            },
            {
                index: asAbsoluteStreamIndex(4),
                displayTitle: 'English',
                language: 'eng',
                channels: 2,
                codec: 'ac3',
                isDefault: false,
            },
        ];
        for (const d of [
            ...AUDIO.map((i) => `stream_${i}`),
            'stream_4',
            ...AUDIO.map(gopAudioPartsDirName),
            gopVideoPartsDirName(4),
        ]) {
            mkdirSync(join(root, d), { recursive: true });
        }
        const config: FullStrategyConfig = {
            localFilePath: source,
            outputDir: root,
            segmentDuration: 10,
            startTimeSeconds: undefined,
            gpuAcceleration: 'none',
            encodingPreset: 'ultrafast',
            nvencPreset: 'p4',
            h264Crf: 23,
            h265Crf: 28,
            videoBitrateMbps: 0,
            maxWidth: 0,
            maxHeight: 0,
            tonemappingAlgorithm: 'bt2390',
            deinterlaceMethod: 'yadif',
            audioCodec: 'aac',
            audioBitrateStereo: '128k',
            audioBitrateSurround: '256k',
            audioVbr: false,
            audioBoost: 1,
            audioTracks,
            videoInfo: { codec: 'h264', width: 320, height: 240 },
            hlsOutput: { hlsAudioMode: 'demux' },
            // Prod's remux plan: copy what HLS can carry, transcode only the rest.
            forceAudioTranscode: false,
            decision: {
                mode: 'full',
                reasons: 0,
                videoAction: 'copy',
                audioAction: 'copy',
                useGpu: false,
                needsTonemapping: false,
                preserveHdr10: false,
            },
            gopSegments: { videoStartKeyframe: grid.firstKeyframe[0] },
        };
        const { args } = new FullTranscodeStrategy().buildArgs(config);
        // LUMASTRA_FFMPEG_SMOKE_ARGS=<file> writes the command so it can be replayed by hand on a real file.
        if (process.env.LUMASTRA_FFMPEG_SMOKE_ARGS) {
            writeFileSync(process.env.LUMASTRA_FFMPEG_SMOKE_ARGS, JSON.stringify(args, null, 1));
        }
        execFileSync(
            'ffmpeg',
            ['-hide_banner', '-loglevel', 'error', ...args.filter((a) => a !== '-stats')],
            {
                cwd: root,
                stdio: 'pipe',
                timeout: 180_000,
            },
        );

        const assembler = new GopSegmentAssembler({
            grid,
            gridOffset: 0,
            log,
            streams: [
                ...AUDIO.map((i) => ({
                    kind: 'audio' as const,
                    streamDir: join(root, `stream_${i}`),
                    partsDir: join(root, gopAudioPartsDirName(i)),
                    partPrefix: GOP_AUDIO_PART_PREFIX,
                    initName: `init_${i}.mp4`,
                })),
                {
                    kind: 'video' as const,
                    streamDir: join(root, 'stream_4'),
                    partsDir: join(root, gopVideoPartsDirName(4)),
                    partPrefix: GOP_VIDEO_PART_PREFIX,
                    initName: 'init_4.mp4',
                },
            ],
        });
        await assembler.tick({ final: true });
        expect(assembler.broken).toBeNull();
        expect(assembler.complete).toBe(true);
        await assembler.stop();

        for (const s of AUDIO.map((i) => `stream_${i}`)) {
            const sd = join(root, s);
            const ts = readTrackTimescale(readFileSync(join(sd, `init_${s.slice(-1)}.mp4`)))!;
            const segs = readdirSync(sd)
                .filter((n) => /^segment_\d+\.m4s$/.test(n))
                .sort();
            streams[s] = [];
            spans[s] = [];
            rawTfdtMax[s] = 0;
            for (const n of segs) {
                const bytes = readFileSync(join(sd, n));
                for (
                    let at = bytes.indexOf('tfdt');
                    at !== -1;
                    at = bytes.indexOf('tfdt', at + 4)
                ) {
                    const version = bytes[at + 4];
                    const raw =
                        version === 1
                            ? Number(bytes.readBigUInt64BE(at + 8))
                            : bytes.readUInt32BE(at + 8);
                    rawTfdtMax[s] = Math.max(rawTfdtMax[s], raw);
                }
                const frags = fragments(bytes, ts);
                streams[s].push(frags[0]?.start ?? NaN);
                // Span of the segment = next fragment start − first start, from the
                // fragment list; the last fragment's own length is below one part.
                spans[s].push(
                    frags.length > 1 ? frags[frags.length - 1].start - frags[0].start : 0,
                );
            }
        }
    }, 600_000);

    afterAll(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('assembles every grid entry for every rendition', () => {
        for (const s of AUDIO.map((i) => `stream_${i}`)) {
            expect(streams[s].length, s).toBe(grid.count);
        }
    });

    it('never serves a fragment that starts before 0 (the encoder priming is trimmed)', () => {
        // The signed tfdt read alone would make a wrapped part key correctly and
        // still ship 2^64 − 1024 to the player; this pins the served bytes.
        for (const s of AUDIO.map((i) => `stream_${i}`)) {
            expect(streams[s][0], `${s} first fragment`).toBeGreaterThanOrEqual(0);
            expect(rawTfdtMax[s], `${s} raw tfdt`).toBeLessThan(2 ** 62);
        }
    });

    it('starts each audio entry within one part of its declared start, copied or transcoded', () => {
        for (const s of AUDIO.map((i) => `stream_${i}`)) {
            for (let n = 0; n < grid.count; n++) {
                expect(Math.abs(streams[s][n] - grid.starts[n]), `${s} entry ${n}`).toBeLessThan(
                    0.6,
                );
            }
        }
    });

    it('fills each entry with (nearly) the declared duration, copied or transcoded', () => {
        for (const s of AUDIO.map((i) => `stream_${i}`)) {
            for (let n = 0; n < grid.count - 1; n++) {
                // A segment holds the parts that start inside the entry: its
                // fragment span is the declared duration less at most one part.
                expect(
                    spans[s][n],
                    `${s} entry ${n} (declared ${grid.durations[n]} s)`,
                ).toBeGreaterThan(grid.durations[n] - 1.2);
            }
        }
    });
});
