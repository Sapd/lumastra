// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../config.js';
import {
    measureAudioTail,
    readTailInventory,
    summarizeTailFrames,
} from './audio-tail-assessment.js';
import { probeStreamTails } from './ffprobe.js';
import { AudioTailAssessmentSchema } from '$lib/schemas/audio-tail-assessment.js';
import { haveFfmpeg } from '../../../../tests/helpers/have-ffmpeg';
const source = { generation: 'test', physical: 'test', streams: 'test' };

const ffmpegSmoke = describe.skipIf(!process.env.LUMASTRA_FFMPEG_SMOKE || !haveFfmpeg());

ffmpegSmoke('audio tail observations (real pinned FFmpeg)', () => {
    let dir: string;
    function clip(
        name: string,
        audio: string[],
        videoSeconds = 2,
        offset = 0,
        codec = 'pcm_s16le',
    ): string {
        const path = join(dir, name + '.mkv');
        const args = [
            '-hide_banner',
            '-loglevel',
            'error',
            '-y',
            '-f',
            'lavfi',
            '-i',
            `color=size=64x64:rate=10:duration=${videoSeconds}`,
        ];
        for (const filter of audio)
            args.push(
                ...(offset ? ['-itsoffset', String(offset)] : []),
                '-f',
                'lavfi',
                '-i',
                filter,
            );
        args.push('-map', '0:v');
        audio.forEach((_, i) => args.push('-map', `${i + 1}:a`));
        args.push('-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', codec, path);
        execFileSync(config.FFMPEG_PATH, args, { timeout: 30000, stdio: 'pipe' });
        return path;
    }
    beforeAll(() => {
        dir = mkdtempSync(join(tmpdir(), 'audio-tail-'));
    });
    afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
    });
    it('proves that a stream ending with video has no post-video tail', async () => {
        const path = clip('two', [
            'anullsrc=r=48000:cl=stereo:d=2',
            'sine=frequency=440:sample_rate=48000:duration=5',
        ]);
        const tails = await probeStreamTails(path);
        expect(tails.audioEnd).toBeGreaterThan(4.9);
        const result = await measureAudioTail(path, 2, 5, source);
        expect(result.inventory.filter((s) => s.codec_type === 'audio')).toHaveLength(2);
        expect(result.streams).toHaveLength(2);
        expect(result.observation).toBe('audible');
        expect(result.completeness).toBe('unverified');
        expect(result.scope).toBe('measured');
        expect(result.streams[0].channels).toHaveLength(0);
        expect(result.streams[0].continuous).toBe(true);
        expect(result.streams[0].packetEof).toBe(true);
        expect(result.streams[0].packetInterval?.end).toBeLessThanOrEqual(2);
    });
    it.each([4.968, 4.68])(
        'measures two silent tracks with the first ending at %ss',
        async (shortEnd) => {
            const path = clip(`two-silent-ends-${shortEnd}`, [
                `anullsrc=r=48000:cl=stereo:d=${shortEnd}`,
                'anullsrc=r=48000:cl=stereo:d=5',
            ]);
            const result = await measureAudioTail(path, 2, 5, source);
            expect(result.scope).toBe('measured');
            expect(result.observation).toBe('near_silent');
            expect(result.streams).toHaveLength(2);
            expect(result.streams.every((stream) => stream.channels.length === 2)).toBe(true);
            expect(
                result.streams.every(
                    (stream) => stream.packetEof && stream.packetCount && stream.packetCount > 0,
                ),
            ).toBe(true);
            expect(result.streams[0].decoded?.end).toBeCloseTo(shortEnd, 2);
            expect(result.streams[1].decoded?.end).toBeCloseTo(5, 2);
        },
    );
    it('retains decoded AAC evidence but keeps conflicting declared endpoints unknown', async () => {
        const path = clip('aac-offset', ['anullsrc=r=48000:cl=stereo:d=5'], 2, 0.002, 'aac');
        const tails = await probeStreamTails(path);
        const result = await measureAudioTail(path, tails.videoEnd, tails.audioEnd, source);
        expect(result.reasons).toContain('declared_endpoint_inconsistent');
        expect(result.scope).toBe('partial');
        expect(result.observation).toBe('unknown');
        expect(result.streams[0].continuous).toBe(true);
        expect(result.streams[0].timingToleranceSeconds).toBeLessThan(0.002);
        expect(result.streams[0].channels).toHaveLength(2);
    });
    it('accepts a small offset when packet and declared endpoints agree', async () => {
        const path = clip('pcm-offset', ['anullsrc=r=48000:cl=stereo:d=5'], 2, 0.002);
        const tails = await probeStreamTails(path);
        const result = await measureAudioTail(path, tails.videoEnd, tails.audioEnd, source);
        expect(result.scope).toBe('measured');
        expect(result.observation).toBe('near_silent');
        expect(result.streams[0].packetEof).toBe(true);
    });
    it('accepts a Matroska DURATION relative to stream start only when packets agree', async () => {
        const path = clip('relative-duration-tag', ['anullsrc=r=48000:cl=stereo:d=5'], 2, 0.002);
        const bytes = readFileSync(path);
        const offset = bytes.indexOf(Buffer.from('00:00:05.002'));
        expect(offset).toBeGreaterThan(0);
        bytes.write('000', offset + 9, 'ascii');
        writeFileSync(path, bytes);
        const inventory = await readTailInventory(path);
        const audio = inventory.streams.find((stream) => stream.codec_type === 'audio');
        expect(audio?.start_time).toBe('0.002000');
        expect((audio?.tags as { DURATION?: string }).DURATION).toMatch(/^00:00:05\.000/);
        const result = await measureAudioTail(path, 2, 5.002, source);
        expect(result.streams[0].packetEnd).toBeCloseTo(5.002, 3);
        expect(result.reasons).not.toContain('declared_endpoint_inconsistent');
        expect(result.scope).toBe('measured');
        expect(result.observation).toBe('near_silent');
        expect(result.completeness).toBe('unverified');
    });
    it('applies AAC frame clock allowance through measurement with real packet EOF', async () => {
        const path = clip('aac-quantized-frames', ['anullsrc=r=48000:cl=stereo:d=5'], 2, 0, 'aac');
        const baseline = await measureAudioTail(path, 2, 5, source);
        const packetEnd = baseline.streams[0].packetEnd;
        expect(packetEnd).toBeDefined();
        const end = packetEnd!;
        const inventory = await readTailInventory(path);
        const audio = inventory.streams.find((stream) => stream.codec_type === 'audio');
        const tag = (audio?.tags as { DURATION?: string }).DURATION;
        expect(tag).toMatch(/^00:00:\d\d\.\d{9}$/);
        const bytes = readFileSync(path);
        const tagOffset = bytes.indexOf(Buffer.from(tag!));
        expect(tagOffset).toBeGreaterThan(0);
        bytes.write(`00:00:${end.toFixed(9).padStart(12, '0')}`, tagOffset, 'ascii');
        writeFileSync(path, bytes);

        // Three successive 1024-sample frames use the +1.166667 ms jump
        // captured from the reported AAC tracks. FFprobe still traverses this
        // real AAC file to EOF; only the decoder metadata is substituted.
        const start = Number((end - 0.064).toFixed(6));
        const metadata = join(dir, 'aac-quantized-frames.txt');
        writeFileSync(metadata, silentFrames([start, start + 0.021, start + 0.0435], 1024, 2));
        const wrapper = join(dir, 'quantized-ffmpeg');
        const actual = config.FFMPEG_PATH;
        writeFileSync(
            wrapper,
            `#!/bin/sh\ncase " $* " in *ametadata=print:file=-*) cat "${metadata}"; exit 0;; esac\nexec "${actual}" "$@"\n`,
            { mode: 0o755 },
        );
        const override = vi.spyOn(config, 'FFMPEG_PATH', 'get').mockReturnValue(wrapper);
        try {
            const result = await measureAudioTail(path, start, end, source);
            expect(result.streams[0].packetEof).toBe(true);
            expect(result.streams[0].continuous).toBe(true);
            expect(result.scope).toBe('measured');
            expect(result.observation).toBe('near_silent');
            expect(result.completeness).toBe('unverified');
        } finally {
            override.mockRestore();
        }
    });
    it('observes packets beyond a supplied endpoint rather than clipping the evidence', async () => {
        const path = clip('underreported', ['sine=frequency=440:sample_rate=48000:duration=5']);
        const result = await measureAudioTail(path, 2, 3, source);
        expect(result.requested?.end).toBeGreaterThan(4.9);
        expect(result.streams[0].decoded?.end).toBeGreaterThan(4.9);
        expect(result.reasons).toContain('packet_tail_disagrees_with_probe');
        expect(result.observation).toBe('audible');
        expect(result.completeness).toBe('unverified');
    });
    it('reads real packets beyond an underreported Matroska DURATION tag', async () => {
        const path = clip('wrong-duration-tag', [
            'sine=frequency=440:sample_rate=48000:duration=5',
        ]);
        const bytes = readFileSync(path);
        const offset = bytes.indexOf(Buffer.from('00:00:05.'));
        expect(offset).toBeGreaterThan(0);
        bytes.write('03', offset + 6, 'ascii');
        writeFileSync(path, bytes);
        const inventory = await readTailInventory(path);
        const audio = inventory.streams.find((stream) => stream.codec_type === 'audio');
        expect((audio?.tags as { DURATION?: string }).DURATION).toMatch(/^00:00:03\./);
        const result = await measureAudioTail(path, 2, 5, source);
        expect(result.streams[0].packetEnd).toBeGreaterThan(4.9);
        expect(result.streams[0].decoded?.end).toBeGreaterThan(4.9);
        expect(result.reasons).toContain('declared_endpoint_inconsistent');
        expect(result.observation).toBe('audible');
    });
    it.each([1, 4])(
        'keeps early packet EOF unknown when a %ss stream declares a later end',
        async (shortEnd) => {
            const path = clip(`overreported-${shortEnd}`, [
                `anullsrc=r=48000:cl=stereo:d=${shortEnd}`,
                'anullsrc=r=48000:cl=stereo:d=5',
            ]);
            const bytes = readFileSync(path);
            const tag = `00:00:0${shortEnd}.`;
            const offset = bytes.indexOf(Buffer.from(tag));
            expect(offset).toBeGreaterThan(0);
            bytes.write('09', offset + 6, 'ascii');
            writeFileSync(path, bytes);
            const result = await measureAudioTail(path, 2, 5, source);
            expect(result.reasons).toContain('declared_endpoint_inconsistent');
            expect(result.scope).toBe('partial');
            expect(result.observation).toBe('unknown');
            expect(result.completeness).toBe('unverified');
            expect(result.streams[0].packetEnd).toBeCloseTo(shortEnd, 2);
            if (shortEnd < 2) expect(result.streams[0].noPostVideoPackets).toBe(true);
        },
    );
    it('reports complete silent coverage with finite per-channel digital-zero observations', async () => {
        const path = clip('silent', ['anullsrc=r=48000:cl=stereo:d=5']);
        const result = await measureAudioTail(path, 2, 5, source);
        expect(result.scope).toBe('measured');
        expect(result.observation).toBe('near_silent');
        expect(result.streams[0].samples).toBe(144000);
        expect(result.streams[0].channels).toHaveLength(2);
        expect(
            result.streams[0].channels.every(
                (c) => c.digitalZero && Number.isFinite(c.peakDbfs) && Number.isFinite(c.rmsDbfs),
            ),
        ).toBe(true);
    });
    it.each([
        ['one-channel', 'aevalsrc=0|0.1*sin(2*PI*440*t):s=48000:d=5'],
        ['burst', 'aevalsrc=if(between(t\\,3.1\\,3.11)\\,0.5\\,0):s=48000:d=5'],
    ])('never calls %s audio all-silent', async (name, filter) => {
        expect((await measureAudioTail(clip(name, [filter]), 2, 5, source)).observation).toBe(
            'audible',
        );
    });
    it('records finite nonzero near-silence per channel', async () => {
        const path = clip('quiet', ['aevalsrc=0.0001*sin(2*PI*440*t):s=48000:d=5']);
        const result = await measureAudioTail(path, 2, 5, source);
        expect(result.observation).toBe('near_silent');
        expect(result.streams[0].channels[0].digitalZero).toBe(false);
        expect(result.streams[0].channels[0].peakDbfs).toBeLessThan(-60);
        expect(Number.isFinite(result.streams[0].channels[0].rmsDbfs)).toBe(true);
    });
    it('marks a late stream offset as partial', async () => {
        const result = await measureAudioTail(
            clip('offset', ['anullsrc=r=48000:cl=stereo:d=2'], 2, 3),
            2,
            5,
            source,
        );
        expect(result.scope).toBe('partial');
        expect(result.observation).toBe('unknown');
    });
    it('never makes a whole-tail claim beyond the duration cap', async () => {
        const result = await measureAudioTail(
            clip('long', ['anullsrc=r=8000:cl=mono:d=184']),
            2,
            184,
            source,
        );
        expect(result.reasons).toContain('tail_duration_cap');
        expect(result.scope).toBe('partial');
        expect(result.observation).toBe('unknown');
    });
    it('caps inventory at eight measured streams', async () => {
        const result = await measureAudioTail(
            clip('many', Array<string>(9).fill('anullsrc=r=8000:cl=mono:d=3')),
            2,
            3,
            source,
        );
        expect(result.reasons).toContain('audio_stream_cap');
        expect(result.streams).toHaveLength(8);
        expect(result.scope).toBe('partial');
    });
    it('reports real timestamp gaps as partial', async () => {
        const path = clip('gaps', ["anullsrc=r=48000:cl=mono:d=5,aselect='not(between(t,3,3.5))'"]);
        const result = await measureAudioTail(path, 2, 5, source);
        expect(result.scope).toBe('partial');
        expect(result.streams[0].continuous).toBe(false);
    });
    it('bounds shared input preparation with the total added measurement budget', async () => {
        const path = clip('timeout-source', ['anullsrc=r=48000:cl=mono:d=5']);
        const sleeper = join(dir, 'slow-ffmpeg');
        writeFileSync(sleeper, '#!/bin/sh\nexec sleep 5\n', { mode: 0o755 });
        const override = vi.spyOn(config, 'FFMPEG_PATH', 'get').mockReturnValue(sleeper);
        try {
            const started = performance.now();
            const result = await measureAudioTail(path, 2, 5, source, undefined, 150);
            expect(performance.now() - started).toBeLessThan(1000);
            expect(result.reasons).toContain('measurement_budget');
            expect(result.observation).toBe('unknown');
            expect(result.scope).not.toBe('measured');
        } finally {
            override.mockRestore();
        }
    });
    it('retains inconclusive evidence on decode failure and rejects cancellation', async () => {
        const path = clip('cut-source', ['anullsrc=r=48000:cl=stereo:d=5']);
        const cut = join(dir, 'cut.mkv');
        const bytes = readFileSync(path);
        writeFileSync(cut, bytes.subarray(0, Math.floor(bytes.length / 2)));
        expect((await measureAudioTail(cut, 2, 5, source)).observation).not.toBe('near_silent');
        const controller = new AbortController();
        controller.abort();
        await expect(measureAudioTail(path, 2, 5, source, controller.signal)).rejects.toThrow();
    });
    it('does not turn successful empty decoder output into silence', async () => {
        const path = clip('empty-decode', ['anullsrc=r=48000:cl=stereo:d=5']);
        const empty = join(dir, 'empty-ffmpeg');
        writeFileSync(empty, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        const override = vi.spyOn(config, 'FFMPEG_PATH', 'get').mockReturnValue(empty);
        try {
            const result = await measureAudioTail(path, 2, 5, source);
            expect(result.streams[0].packetEof).toBe(true);
            expect(result.streams[0].continuous).toBe(false);
            expect(result.observation).toBe('unknown');
            expect(result.scope).not.toBe('measured');
        } finally {
            override.mockRestore();
        }
    });
    it('keeps a stream unknown when its packet traversal returns no evidence', async () => {
        const path = clip('missing-packets', ['anullsrc=r=48000:cl=stereo:d=5']);
        const probe = join(dir, 'empty-audio-packets');
        const actual = config.FFPROBE_PATH;
        writeFileSync(
            probe,
            `#!/bin/sh\ncase " $* " in *' a:0 '*) exit 0;; esac\nexec "${actual}" "$@"\n`,
            { mode: 0o755 },
        );
        const override = vi.spyOn(config, 'FFPROBE_PATH', 'get').mockReturnValue(probe);
        try {
            const result = await measureAudioTail(path, 2, 5, source);
            expect(result.scope).toBe('partial');
            expect(result.observation).toBe('unknown');
            expect(result.streams[0].continuous).toBe(false);
            expect(result.streams[0].reasons).toContain('packet_or_decode_failed');
        } finally {
            override.mockRestore();
        }
    });
    it('keeps v1 stored observations readable with optional new packet proof', async () => {
        const path = clip('schema', ['anullsrc=r=48000:cl=stereo:d=5']);
        const result = await measureAudioTail(path, 2, 5, source);
        expect(result.method).toBe('ffmpeg-astats-frames-v2');
        expect(AudioTailAssessmentSchema.parse(result).streams[0].packetEof).toBe(true);
        const historical = structuredClone(result);
        historical.method = 'ffmpeg-astats-frames-v1';
        delete historical.streams[0].packetEof;
        delete historical.streams[0].packetInterval;
        delete historical.streams[0].packetCount;
        delete historical.streams[0].packetEnd;
        delete historical.streams[0].timingToleranceSeconds;
        expect(AudioTailAssessmentSchema.safeParse(historical).success).toBe(true);
    });
});

function silentFrames(points: number[], samples = 1024, channels = 1): string {
    return points
        .map(
            (pts, i) =>
                `frame:${i} pts:${i} pts_time:${pts}\n${Array.from(
                    { length: channels },
                    (_, channel) =>
                        `lavfi.astats.${channel + 1}.Peak_level=-inf\nlavfi.astats.${channel + 1}.RMS_level=-inf`,
                ).join('\n')}\nlavfi.astats.Overall.Number_of_samples=${samples}`,
        )
        .join('\n');
}

it('accepts bounded AAC clock quantization only between adjacent frames', () => {
    const rate = 48000;
    const tick = 0.001;
    const endpointTolerance = tick + 2 / rate;
    const frameTolerance = 2 * tick + 2 / rate;
    const quantized = silentFrames([0, 0.021, 0.0435]);
    expect(summarizeTailFrames(quantized, 1, 1, rate, 0, 0.064, endpointTolerance).continuous).toBe(
        false,
    );
    expect(
        summarizeTailFrames(
            quantized,
            1,
            1,
            rate,
            0,
            0.064,
            endpointTolerance,
            frameTolerance,
        ).continuous,
    ).toBe(true);
    expect(
        summarizeTailFrames(
            quantized,
            1,
            1,
            rate,
            0,
            0.068,
            endpointTolerance,
            frameTolerance,
        ).continuous,
    ).toBe(false);
    const compensatedGap = silentFrames([0, 0.021333, 0.045666, 0.064]);
    expect(
        summarizeTailFrames(
            compensatedGap,
            1,
            1,
            rate,
            0,
            0.085333,
            endpointTolerance,
            frameTolerance,
        ).continuous,
    ).toBe(false);
    const hiddenByAdjacencyAlone = silentFrames([0, 0.023, 0.042666, 0.064]);
    expect(
        summarizeTailFrames(
            hiddenByAdjacencyAlone,
            1,
            1,
            rate,
            0,
            0.085333,
            endpointTolerance,
            frameTolerance,
        ).continuous,
    ).toBe(false);
    const accumulatedOverlap = silentFrames([0, 0.020333, 0.040666, 0.061]);
    expect(
        summarizeTailFrames(
            accumulatedOverlap,
            1,
            1,
            rate,
            0,
            0.082333,
            endpointTolerance,
            frameTolerance,
        ).continuous,
    ).toBe(false);
});

it.each([
    ['gap', [0, 2]],
    ['frozen', [0, 0]],
    ['bad', [NaN, 1]],
])('does not establish coverage from %s timestamps', (_, timestamps) => {
    const output = timestamps
        .map(
            (pts, i) =>
                `frame:${i} pts:${i} pts_time:${pts}\nlavfi.astats.1.Peak_level=-inf\nlavfi.astats.1.RMS_level=-inf\nlavfi.astats.Overall.Number_of_samples=48000`,
        )
        .join('\n');
    expect(summarizeTailFrames(output, 1, 1, 48000, 0, 2).continuous).toBe(false);
});
