// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real ffmpeg: demux copy-video GOP mode serves exactly the times it declares.
 *
 * Found on prod 2026-10-06: a resumed demux copy session (hls.js) showed PGS
 * subtitles ~2 s off because the playlist declared uniform 10 s entries while
 * FFmpeg cut copied video on its own relative grid. GOP mode writes one file
 * per keyframe and assembles keyframe-grid entries; this runs the args the
 * strategy really builds, for generation 0 and for seek generations, and holds
 * every assembled entry's presentation start against the grid.
 *
 * Skips when ffmpeg/ffprobe are absent; generates its own fixture otherwise.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { asAbsoluteStreamIndex } from '$lib/shared/stream-index';
import { haveFfmpeg } from '../../../../../tests/helpers/have-ffmpeg';
import { FullTranscodeStrategy } from '../transcoding/full-transcode-strategy';
import {
    GOP_AUDIO_PART_PREFIX,
    GOP_VIDEO_PART_PREFIX,
    gopAudioPartsDirName,
    gopVideoPartsDirName,
} from '../transcoding/gop-output-args';
import type { FullStrategyConfig } from '../transcoding/transcode-strategy';
import { readFragmentStart, readTrackTimescale } from './fmp4-timing';
import { buildGopGrid, gopStartSeekSeconds, type GopGrid } from './gop-grid';
import { GopSegmentAssembler } from './gop-segment-assembler';

// Irregular keyframes: a > 20 s GOP (31 → 52) and a 0.6 s burst after it.
const FORCED_KEYFRAMES = [
    0, 3.5, 13.25, 14, 27.875, 31, 52, 52.625, 53.25, 63.75, 71.25, 80.375, 95, 101.25, 109.875,
    118,
];
const DURATION = 125;

let dir: string;
let source: string;
let keyframes: number[];
let total: number;
let grid: GopGrid;

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

function probe(args: string[]): string {
    return execFileSync('ffprobe', ['-v', 'error', ...args], { encoding: 'utf8' });
}

interface Generation {
    entry: number;
    /** stream dir name → presentation starts of its assembled segments */
    starts: Record<string, number[]>;
    root: string;
}

async function runGeneration(entry: number): Promise<Generation> {
    const root = join(dir, `gen-entry-${entry}`);
    const audioTracks = [
        {
            index: asAbsoluteStreamIndex(1),
            displayTitle: 'English',
            language: 'eng',
            channels: 6,
            codec: 'eac3',
            isDefault: true,
        },
    ];
    for (const d of ['stream_0', 'stream_1', gopAudioPartsDirName(0), gopVideoPartsDirName(1)]) {
        mkdirSync(join(root, d), { recursive: true });
    }
    const config: FullStrategyConfig = {
        localFilePath: source,
        outputDir: root,
        segmentDuration: 10,
        startTimeSeconds: entry === 0 ? undefined : gopStartSeekSeconds(grid, entry),
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
        videoInfo: { codec: 'hevc', width: 320, height: 240 },
        hlsOutput: { hlsAudioMode: 'demux' },
        // Prod's case: copied HEVC with EAC3 transcoded to AAC (-af aresample).
        forceAudioTranscode: true,
        decision: {
            mode: 'full',
            reasons: 0,
            videoAction: 'copy',
            audioAction: 'transcode',
            useGpu: false,
            needsTonemapping: false,
            preserveHdr10: false,
        },
        gopSegments: { videoStartKeyframe: grid.firstKeyframe[entry] },
    };
    const { args } = new FullTranscodeStrategy().buildArgs(config);
    execFileSync(
        'ffmpeg',
        ['-hide_banner', '-loglevel', 'error', ...args.filter((a) => a !== '-stats')],
        {
            cwd: root,
            stdio: 'pipe',
            timeout: 120_000,
        },
    );

    const assembler = new GopSegmentAssembler({
        grid,
        gridOffset: entry,
        log,
        streams: [
            {
                kind: 'audio',
                streamDir: join(root, 'stream_0'),
                partsDir: join(root, gopAudioPartsDirName(0)),
                partPrefix: GOP_AUDIO_PART_PREFIX,
                initName: 'init_0.mp4',
            },
            {
                kind: 'video',
                streamDir: join(root, 'stream_1'),
                partsDir: join(root, gopVideoPartsDirName(1)),
                partPrefix: GOP_VIDEO_PART_PREFIX,
                initName: 'init_1.mp4',
            },
        ],
    });
    await assembler.tick({ final: true });
    if (!assembler.complete || assembler.broken) {
        const tree = (d: string): string => {
            try {
                return readdirSync(join(root, d)).slice(0, 12).join(' ');
            } catch {
                return '-';
            }
        };
        console.log('DEBUG', entry, assembler.broken, assembler.readyEntries, {
            root: tree('.'),
            s0: tree('stream_0'),
            s1: tree('stream_1'),
            p0: tree(gopAudioPartsDirName(0)),
            g1: tree(gopVideoPartsDirName(1)),
        });
    }
    expect(assembler.broken).toBeNull();
    expect(assembler.complete).toBe(true);
    await assembler.stop();

    const starts: Record<string, number[]> = {};
    for (const s of ['stream_0', 'stream_1']) {
        const sd = join(root, s);
        const init = readFileSync(join(sd, `init_${s.slice(-1)}.mp4`));
        const ts = readTrackTimescale(init)!;
        const segs = readdirSync(sd)
            .filter((n) => /^segment_\d+\.m4s$/.test(n))
            .sort();
        starts[s] = segs.map((n) => {
            const t = readFragmentStart(readFileSync(join(sd, n)), ts)!;
            return s === 'stream_1' ? t.presentationSeconds : t.decodeSeconds;
        });
    }
    return { entry, starts, root };
}

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('GOP-mode demux copy, real ffmpeg', () => {
    const gens = new Map<number, Generation>();

    beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), 'gop-smoke-'));
        source = join(dir, 'src.mkv');
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
                ...['-c:v', 'libx265', '-preset', 'ultrafast'],
                ...[
                    '-x265-params',
                    'keyint=100000:min-keyint=1:scenecut=0:bframes=4:log-level=error',
                ],
                ...['-force_key_frames', FORCED_KEYFRAMES.join(',')],
                ...['-c:a', 'eac3', '-b:a', '192k', source],
            ],
            { stdio: 'pipe', timeout: 180_000 },
        );
        // Keyframes the way the scanner stores them: packet flags.
        keyframes = probe([
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
        total = parseFloat(probe(['-show_entries', 'format=duration', '-of', 'csv=p=0', source]));
        grid = buildGopGrid(keyframes, total, 10)!;
        writeFileSync(join(dir, 'grid.json'), JSON.stringify(grid));
        for (const entry of [0, 3, 5, grid.count - 2]) {
            gens.set(entry, await runGeneration(entry));
        }
    }, 600_000);

    afterAll(() => {
        if (dir) rmSync(dir, { recursive: true, force: true });
    });

    it('has the irregular grid the test needs', () => {
        expect(keyframes.length).toBe(FORCED_KEYFRAMES.length);
        expect(Math.max(...grid.durations)).toBeGreaterThan(20);
        expect(Math.min(...grid.durations)).toBeLessThan(1);
    });

    it('assembles every grid entry from the generation start to the end', () => {
        for (const g of gens.values()) {
            expect(g.starts.stream_1).toHaveLength(grid.count - g.entry);
            expect(g.starts.stream_0).toHaveLength(grid.count - g.entry);
        }
    });

    it('starts each video entry at its declared keyframe, in every generation', () => {
        for (const g of gens.values()) {
            g.starts.stream_1.forEach((t, i) => {
                expect(
                    Math.abs(t - grid.starts[g.entry + i]),
                    `gen ${g.entry} entry ${g.entry + i}`,
                ).toBeLessThan(0.15);
            });
        }
    });

    it('starts each audio entry within one part of its declared start', () => {
        for (const g of gens.values()) {
            g.starts.stream_0.forEach((t, i) => {
                const declared = grid.starts[g.entry + i];
                // An entry shorter than one part reuses the previous part.
                const tolerance = grid.durations[g.entry + i] < 0.6 ? 1.2 : 0.6;
                expect(
                    Math.abs(t - declared),
                    `gen ${g.entry} audio entry ${g.entry + i}`,
                ).toBeLessThan(tolerance);
            });
        }
    });

    // Measured: every run's FIRST fragment reads ~+0.09 s (FFmpeg's decode-delay
    // handling of a run's first packet); every later entry is identical across
    // generations. So the first entry may differ by a few frames, the rest not at all.
    it('agrees on the same entry across generations', () => {
        const gen0 = gens.get(0)!;
        for (const g of gens.values()) {
            g.starts.stream_1.forEach((t, i) => {
                const diff = Math.abs(t - gen0.starts.stream_1[g.entry + i]);
                expect(diff, `gen ${g.entry} entry ${g.entry + i}`).toBeLessThan(
                    i === 0 ? 0.2 : 0.001,
                );
            });
        }
    });

    it('produces decodable entries and leaves no part directories behind', () => {
        for (const g of gens.values()) {
            expect(readdirSync(g.root).filter((n) => /^(gop|parts)_/.test(n))).toEqual([]);
            const sd = join(g.root, 'stream_1');
            const cat = join(g.root, 'probe.mp4');
            writeFileSync(
                cat,
                Buffer.concat([
                    readFileSync(join(sd, 'init_1.mp4')),
                    readFileSync(join(sd, 'segment_00000.m4s')),
                ]),
            );
            const frames = probe([
                '-count_packets',
                '-show_entries',
                'stream=nb_read_packets',
                '-of',
                'csv=p=0',
                cat,
            ]);
            expect(parseInt(frames, 10)).toBeGreaterThan(0);
            const manifest = readFileSync(join(sd, 'index.m3u8'), 'utf8');
            expect(manifest.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
        }
    });
});
