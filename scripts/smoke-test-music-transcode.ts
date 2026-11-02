// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Phase-0 gate: verify ffmpeg argv builders produce decodable output
 * against the real local ffmpeg binary.
 *
 * Exits 0 on full pass; nonzero on any failure.
 *
 * Usage: npm run test:music-transcode-smoke
 *
 * NOTE: Keep this regex in sync with src/lib/server/services/music-transcode/fdk-aac-detection.ts
 * (hasLibFdkAac). The $lib alias chain (spawnFFmpegSafely → config.ts) does not resolve
 * in tsx script context, so the detection is duplicated inline.
 */
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildMp3EncodeArgs,
    buildOpusEncodeArgs,
    buildAacEncodeArgs,
    buildStreamCopySeekArgs,
    containerFor,
    mimeFor,
} from '../src/lib/server/services/music-transcode/ffmpeg-args.js';
import type { MusicCodec } from '../src/lib/server/services/music-transcode/types.js';

const FIXTURE = 'tests/fixtures/music/sample.flac';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

interface ProbeResult {
    codec_name: string;
    sample_rate: string;
    channels: number;
    duration: string;
    bit_rate?: string;
    format_name: string;
}

/** Inline fdk detection — avoids $lib import chain from fdk-aac-detection.ts */
async function hasLibFdkAac(): Promise<boolean> {
    return new Promise((resolve) => {
        const ff = spawn(FFMPEG, ['-hide_banner', '-encoders'], {
            stdio: ['ignore', 'pipe', 'ignore'],
        });
        let stdout = '';
        ff.stdout.on('data', (b: Buffer) => {
            stdout += b.toString();
        });
        ff.on('error', () => resolve(false));
        ff.on('close', () => {
            resolve(/(\s|^)libfdk_aac(\s|$)/m.test(stdout));
        });
    });
}

async function runFfmpegToFile(args: string[], _outPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ff = spawn(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
            stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        ff.stderr.on('data', (b: Buffer) => {
            stderr += b.toString();
        });
        ff.on('error', reject);
        ff.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ffmpeg exit ${code}: ${stderr}`));
        });
    });
}

async function probe(path: string): Promise<ProbeResult> {
    return new Promise((resolve, reject) => {
        const fp = spawn(
            FFPROBE,
            [
                '-v',
                'error',
                '-select_streams',
                'a:0',
                '-show_entries',
                'stream=codec_name,sample_rate,channels,duration,bit_rate:format=format_name,duration',
                '-of',
                'json',
                path,
            ],
            { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let out = '',
            err = '';
        fp.stdout.on('data', (b: Buffer) => {
            out += b.toString();
        });
        fp.stderr.on('data', (b: Buffer) => {
            err += b.toString();
        });
        fp.on('error', reject);
        fp.on('close', (code) => {
            if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err}`));
            try {
                const parsed = JSON.parse(out) as {
                    streams?: Array<Record<string, unknown>>;
                    format?: Record<string, unknown>;
                };
                const s = (parsed.streams?.[0] ?? {}) as Record<string, unknown>;
                const f = (parsed.format ?? {}) as Record<string, unknown>;
                resolve({
                    codec_name: s.codec_name as string,
                    sample_rate: s.sample_rate as string,
                    channels: s.channels as number,
                    duration: (s.duration ?? f.duration ?? '0') as string,
                    bit_rate: s.bit_rate as string | undefined,
                    format_name: f.format_name as string,
                });
            } catch (e) {
                reject(e);
            }
        });
    });
}

interface Scenario {
    name: string;
    codec: MusicCodec;
    bitrateKbps: number;
    timeOffset: number;
    mode: 'encode' | 'stream_copy_seek';
}

const SCENARIOS: Scenario[] = [
    {
        name: 'mp3 192 enc off=0',
        codec: 'mp3',
        bitrateKbps: 192,
        timeOffset: 0,
        mode: 'encode',
    },
    {
        name: 'mp3 192 enc off=3',
        codec: 'mp3',
        bitrateKbps: 192,
        timeOffset: 3,
        mode: 'encode',
    },
    {
        name: 'mp3 320 enc off=0',
        codec: 'mp3',
        bitrateKbps: 320,
        timeOffset: 0,
        mode: 'encode',
    },
    {
        name: 'mp3 192 seek off=3',
        codec: 'mp3',
        bitrateKbps: 192,
        timeOffset: 3,
        mode: 'stream_copy_seek',
    },
    {
        name: 'opus 128 enc off=0',
        codec: 'opus',
        bitrateKbps: 128,
        timeOffset: 0,
        mode: 'encode',
    },
    {
        name: 'opus 128 enc off=3',
        codec: 'opus',
        bitrateKbps: 128,
        timeOffset: 3,
        mode: 'encode',
    },
    {
        name: 'opus 128 seek off=3',
        codec: 'opus',
        bitrateKbps: 128,
        timeOffset: 3,
        mode: 'stream_copy_seek',
    },
    {
        name: 'aac 192 enc off=0',
        codec: 'aac',
        bitrateKbps: 192,
        timeOffset: 0,
        mode: 'encode',
    },
    {
        name: 'aac 192 enc off=3',
        codec: 'aac',
        bitrateKbps: 192,
        timeOffset: 3,
        mode: 'encode',
    },
    {
        name: 'aac 192 seek off=3',
        codec: 'aac',
        bitrateKbps: 192,
        timeOffset: 3,
        mode: 'stream_copy_seek',
    },
];

function extFor(codec: MusicCodec): string {
    const container = containerFor(codec);
    if (container === 'ogg') return 'opus';
    if (container === 'adts') return 'aac';
    return 'mp3';
}

async function run(): Promise<void> {
    const fdk = await hasLibFdkAac();
    console.log(`libfdk_aac available: ${fdk}`);

    // Verify mimeFor is exported and callable (guard against missing export)
    const _mime = mimeFor('mp3');
    void _mime;

    const prevEncodedPath: Record<MusicCodec, string | null> = {
        mp3: null,
        opus: null,
        aac: null,
    };
    let fails = 0;

    for (const s of SCENARIOS) {
        const outPath = join(
            tmpdir(),
            `smoke-${Date.now()}-${s.name.replace(/\W+/g, '_')}.${extFor(s.codec)}`,
        );

        let args: string[];
        if (s.mode === 'encode') {
            const enc = {
                srcPath: FIXTURE,
                bitrateKbps: s.bitrateKbps,
                timeOffset: s.timeOffset,
            };
            if (s.codec === 'mp3') args = buildMp3EncodeArgs(enc);
            else if (s.codec === 'opus') args = buildOpusEncodeArgs(enc);
            else args = buildAacEncodeArgs(enc, { hasFdkAac: fdk });
        } else {
            const src = prevEncodedPath[s.codec];
            if (!src) {
                console.log(`  SKIP ${s.name}: no prior encoded file for codec`);
                continue;
            }
            args = buildStreamCopySeekArgs({
                cachedPath: src,
                codec: s.codec,
                timeOffset: s.timeOffset,
            });
        }

        // Replace 'pipe:1' with the actual output file path
        const fileArgs = args.map((a) => (a === 'pipe:1' ? outPath : a));

        try {
            await runFfmpegToFile(fileArgs, outPath);
            const p = await probe(outPath);
            const expectedDuration = 10 - s.timeOffset;
            const observedDur = parseFloat(p.duration);
            const durationOk = Math.abs(observedDur - expectedDuration) < 0.5;
            const expectedCodec = s.codec === 'aac' ? 'aac' : s.codec;
            const codecOk = p.codec_name === expectedCodec;

            const status = durationOk && codecOk ? '✓' : '✗';
            console.log(
                `${status} ${s.name}: codec=${p.codec_name} dur=${observedDur.toFixed(2)}s (expect ${expectedDuration}s) bitrate=${p.bit_rate ?? '?'} format=${p.format_name}`,
            );

            if (!durationOk || !codecOk) fails++;

            // Keep the off=0 encode file for the stream-copy-seek scenario
            if (s.mode === 'encode' && s.timeOffset === 0) {
                prevEncodedPath[s.codec] = outPath;
            } else {
                await fs.unlink(outPath).catch(() => {});
            }
        } catch (err) {
            console.error(`✗ ${s.name}: ${(err as Error).message}`);
            fails++;
        }
    }

    // Cleanup leftover prevEncodedPath files
    for (const p of Object.values(prevEncodedPath)) {
        if (p) await fs.unlink(p).catch(() => {});
    }

    if (fails > 0) {
        console.error(`\nFAILED: ${fails} scenario(s)`);
        process.exit(1);
    }
    console.log('\nAll smoke scenarios passed.');
}

run().catch((err) => {
    console.error('smoke-test fatal:', err);
    process.exit(1);
});
