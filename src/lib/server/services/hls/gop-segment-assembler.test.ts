// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildFragment, buildInit } from './__fixtures__/fmp4-boxes.js';
import { readFragmentStart } from './fmp4-timing.js';
import { buildGopGrid, type GopGrid } from './gop-grid.js';
import { GopSegmentAssembler, type AssemblerStream } from './gop-segment-assembler.js';

// Grid (10 s cut rule): entries start at 0, 13.25, 27.875, 31, 44.5, 52, 63.75.
const KF = [0, 3.5, 13.25, 14, 27.875, 31, 44.5, 52, 63.75];
const TOTAL = 70;
const TS = 1000;
const CTO = 0.083; // video: decode time sits one reorder delay before presentation

let root: string;
let grid: GopGrid;
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

function streams(): { video: AssemblerStream; audio: AssemblerStream } {
    return {
        audio: {
            kind: 'audio',
            streamDir: path.join(root, 'stream_0'),
            partsDir: path.join(root, 'stream_0', 'parts'),
            partPrefix: 'part_',
            initName: 'init_0.mp4',
        },
        video: {
            kind: 'video',
            streamDir: path.join(root, 'stream_1'),
            partsDir: path.join(root, 'stream_1', 'gop'),
            partPrefix: 'gop_',
            initName: 'init_1.mp4',
        },
    };
}

let partCounter = 0;
async function videoPart(start: number, name?: string): Promise<string> {
    const { video } = streams();
    const file = name ?? `gop_${String(partCounter++).padStart(6, '0')}.m4s`;
    // Like FFmpeg's gen0: the very first fragment starts at decode time 0.
    const decode = Math.max(0, Math.round((start - CTO) * TS));
    const frag = buildFragment({
        decodeTime: decode,
        firstCto: Math.round(start * TS) - decode,
        payload: Buffer.from(`v${start}`),
    });
    await fs.writeFile(path.join(video.partsDir, file), frag);
    return file;
}

async function audioPart(start: number): Promise<string> {
    const { audio } = streams();
    const file = `part_${String(partCounter++).padStart(6, '0')}.m4s`;
    const frag = buildFragment({
        decodeTime: Math.round(start * TS),
        payload: Buffer.from(`a${start}`),
    });
    await fs.writeFile(path.join(audio.partsDir, file), frag);
    return file;
}

async function audioParts(from: number, to: number): Promise<void> {
    for (let t = from; t < to; t += 0.5) await audioPart(Math.round(t * 1000) / 1000);
}

function assembler(gridOffset = 0, extra: Partial<{ onBroken: (r: string) => void }> = {}) {
    const s = streams();
    const progress: number[] = [];
    const a = new GopSegmentAssembler({
        grid,
        gridOffset,
        streams: [s.audio, s.video],
        log,
        onProgress: (n) => progress.push(n),
        ...extra,
    });
    return { a, progress };
}

async function segmentStarts(dir: string): Promise<number[]> {
    const names = (await fs.readdir(dir)).filter((n) => /^segment_\d+\.m4s$/.test(n)).sort();
    const out: number[] = [];
    for (const n of names) {
        const t = readFragmentStart(await fs.readFile(path.join(dir, n)), TS)!;
        out.push(Math.round(t.presentationSeconds * 1000) / 1000);
    }
    return out;
}

beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'gop-asm-'));
    grid = buildGopGrid(KF, TOTAL, 10)!;
    partCounter = 0;
    const s = streams();
    for (const st of [s.audio, s.video]) {
        await fs.mkdir(st.partsDir, { recursive: true });
        await fs.writeFile(path.join(st.partsDir, st.initName), buildInit(TS));
    }
    vi.clearAllMocks();
});

afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
});

describe('GopSegmentAssembler', () => {
    it('grid sanity', () => {
        expect(grid.starts).toEqual([0, 13.25, 27.875, 31, 44.5, 52, 63.75]);
    });

    it('assembles entries in order once the next entry has begun', async () => {
        const s = streams();
        for (const k of KF.slice(0, 5)) await videoPart(k); // 0 3.5 13.25 14 27.875
        await audioParts(0, 28.5); // the part at 28 opens entry 2
        const { a, progress } = assembler();
        await a.tick();
        // Entries 0 (0..13.25) and 1 (13.25..27.875) are complete; entry 2 is not
        // (no part at 31 yet).
        expect(await segmentStarts(s.video.streamDir)).toEqual([0, 13.25]);
        const audioStarts = await segmentStarts(s.audio.streamDir);
        expect(audioStarts).toEqual([0, 13.5]);
        expect(a.readyEntries).toBe(2);
        expect(progress).toEqual([2]);
        // Consumed parts are gone; the init is copied up.
        const left = await fs.readdir(s.video.partsDir);
        expect(left.filter((n) => n.endsWith('.m4s'))).toHaveLength(1);
        await expect(fs.stat(path.join(s.video.streamDir, 'init_1.mp4'))).resolves.toBeTruthy();
    });

    it('keeps an audio part with a wrapped negative decode time in entry 0', async () => {
        // FFmpeg writes an encoder's priming samples (AAC: 1024) as tfdt 2^64 − 1024
        // next to copied tracks (prod 2026-11-02). Read as the far future, it made
        // every entry "complete" at once and entry 0 missed its own parts.
        const s = streams();
        for (const k of KF.slice(0, 5)) await videoPart(k);
        await audioPart(-1024 / 48000);
        await audioParts(0.5, 28.5);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(a.readyEntries).toBe(2);
        const audioStarts = await segmentStarts(s.audio.streamDir);
        expect(audioStarts[0]).toBeCloseTo(-1024 / 48000, 3);
        expect(audioStarts[1]).toBe(13.5);
        // Entry 0 holds the wrapped part plus every part up to its boundary.
        const first = (await fs.readdir(s.audio.streamDir))
            .filter((n) => /^segment_\d+\.m4s$/.test(n))
            .sort()[0];
        const seg0 = await fs.readFile(path.join(s.audio.streamDir, first));
        expect(seg0.toString('latin1')).toContain('a0.5');
        expect(seg0.toString('latin1')).toContain('a13');
    });

    it('concatenates every part of an entry in order', async () => {
        const s = streams();
        for (const k of [0, 3.5, 13.25]) await videoPart(k);
        await audioParts(0, 14);
        const { a } = assembler();
        await a.tick();
        const seg = await fs.readFile(path.join(s.video.streamDir, 'segment_00000.m4s'));
        expect(seg.includes(Buffer.from('v0'))).toBe(true);
        expect(seg.includes(Buffer.from('v3.5'))).toBe(true);
        expect(seg.indexOf(Buffer.from('v0'))).toBeLessThan(seg.indexOf(Buffer.from('v3.5')));
    });

    it('writes an EVENT manifest with grid durations and ENDLIST at the end', async () => {
        const s = streams();
        for (const k of KF) await videoPart(k);
        await audioParts(0, TOTAL);
        const { a } = assembler();
        await a.tick();
        let m = await fs.readFile(path.join(s.video.streamDir, 'index.m3u8'), 'utf8');
        // A valid playlist: TARGETDURATION covers every EXTINF (RFC 8216).
        const target = Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(m)?.[1]);
        for (const d of [...m.matchAll(/#EXTINF:([\d.]+),/g)].map((x) => Number(x[1]))) {
            expect(Math.round(d)).toBeLessThanOrEqual(target);
        }
        expect(m).not.toContain('#EXT-X-ENDLIST'); // last entry needs the final flush
        await a.tick({ final: true });
        m = await fs.readFile(path.join(s.video.streamDir, 'index.m3u8'), 'utf8');
        const extinf = [...m.matchAll(/#EXTINF:([\d.]+),/g)].map((x) => Number(x[1]));
        expect(extinf).toHaveLength(grid.count);
        extinf.forEach((d, i) => expect(d).toBeCloseTo(grid.durations[i], 5));
        expect(m.trim().endsWith('#EXT-X-ENDLIST')).toBe(true);
        expect(a.complete).toBe(true);
        expect(await segmentStarts(s.video.streamDir)).toEqual(grid.starts);
    });

    it('accepts a part that merges keyframes inside one entry', async () => {
        const s = streams();
        // 3.5 merged into the part starting at 0: still entry 0 exactly.
        for (const k of [0, 13.25, 27.875]) await videoPart(k);
        await audioParts(0, 28);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(await segmentStarts(s.video.streamDir)).toEqual([0, 13.25]);
    });

    it('fails closed when a grid boundary keyframe was merged away', async () => {
        const broken: string[] = [];
        // Entry 1 starts at 13.25 but no part starts there; 14 does.
        for (const k of [0, 3.5, 14, 27.875]) await videoPart(k);
        await audioParts(0, 28);
        const { a } = assembler(0, { onBroken: (r) => broken.push(r) });
        await a.tick();
        expect(a.broken).toMatch(/entry 1/);
        expect(broken).toHaveLength(1);
        await a.tick();
        expect(await segmentStarts(streams().video.streamDir)).toEqual([]);
    });

    it('fails closed on a part that matches no keyframe', async () => {
        for (const k of [0, 5]) await videoPart(k);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toMatch(/no keyframe within/);
    });

    it('numbers segments relative to gridOffset and drops video before it', async () => {
        const s = streams();
        // Seek generation at entry 3 (31 s); FFmpeg also emitted the keyframe before.
        for (const k of [27.875, 31, 44.5, 52]) await videoPart(k);
        await audioPart(30.8); // audio starting just before the entry joins it
        await audioParts(31.3, 53);
        const { a } = assembler(3);
        await a.tick();
        expect(await segmentStarts(s.video.streamDir)).toEqual([31, 44.5]);
        expect(await fs.readdir(s.video.streamDir)).toContain('segment_00000.m4s');
        const audio = await segmentStarts(s.audio.streamDir);
        expect(audio[0]).toBe(30.8);
        expect(a.readyEntries).toBe(2);
        const leftVideo = await fs.readdir(s.video.partsDir);
        expect(leftVideo.filter((n) => n.endsWith('.m4s'))).toHaveLength(1); // only 52
    });

    it('reuses the previous audio part for an entry shorter than one part', async () => {
        // Keyframes 30 and 30.2 make a 0.2 s catch-up entry after a long GOP.
        grid = buildGopGrid([0, 12, 30, 30.2, 41], 50, 10)!;
        expect(grid.durations.some((d) => d < 0.5)).toBe(true);
        const s = streams();
        for (const k of [0, 12, 30, 30.2, 41]) await videoPart(k);
        for (const t of [0, 5, 10, 12.1, 20, 29.8, 30.3, 35, 41.2, 45]) await audioPart(t);
        const { a } = assembler();
        await a.tick({ final: true });
        expect(a.broken).toBeNull();
        const audio = await fs.readdir(s.audio.streamDir);
        expect(audio.filter((n) => n.startsWith('segment_'))).toHaveLength(grid.count);
    });

    it('waits while the next entry has not begun', async () => {
        for (const k of [0, 3.5]) await videoPart(k);
        await audioParts(0, 5);
        const { a, progress } = assembler();
        await a.tick();
        expect(a.readyEntries).toBe(0);
        expect(progress).toEqual([0]);
        expect(a.broken).toBeNull();
    });

    it('readyEntries is the slowest stream', async () => {
        for (const k of KF.slice(0, 5)) await videoPart(k);
        await audioParts(0, 14); // audio only reaches entry 1
        const { a } = assembler();
        await a.tick();
        expect(a.readyEntries).toBe(1);
    });

    it('never exposes a partial segment and cleans up on stop', async () => {
        const s = streams();
        for (const k of KF.slice(0, 3)) await videoPart(k);
        await audioParts(0, 14);
        await fs.writeFile(path.join(s.video.streamDir, 'segment_00009.m4s.tmp'), 'x');
        const { a } = assembler();
        await a.tick();
        await a.stop();
        const names = await fs.readdir(s.video.streamDir);
        expect(names.some((n) => n.endsWith('.tmp'))).toBe(false);
        expect(names).not.toContain('gop');
        await expect(fs.stat(s.audio.partsDir)).rejects.toThrow();
        expect(names).toContain('segment_00000.m4s');
    });

    it('ignores FFmpeg temp files and its own playlist in the parts dir', async () => {
        const s = streams();
        for (const k of KF.slice(0, 3)) await videoPart(k);
        await fs.writeFile(path.join(s.video.partsDir, 'gop_000099.m4s.tmp'), 'partial');
        await fs.writeFile(path.join(s.video.partsDir, 'index.m3u8'), '#EXTM3U');
        await audioParts(0, 14);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(await segmentStarts(s.video.streamDir)).toEqual([0]);
    });

    it('fails closed when the input ends before the grid does', async () => {
        for (const k of KF.slice(0, 5)) await videoPart(k); // stops inside entry 2
        await audioParts(0, 28.5);
        const { a } = assembler();
        await a.tick({ final: true });
        expect(a.broken).toMatch(/input ended before grid entry/);
        const m = await fs.readFile(path.join(streams().video.streamDir, 'index.m3u8'), 'utf8');
        expect(m).not.toContain('#EXT-X-ENDLIST');
    });

    it('fails closed when a stream produced nothing by a clean exit', async () => {
        await audioParts(0, 5);
        const { a } = assembler();
        await a.tick({ final: true });
        expect(a.broken).toMatch(/no output at a clean exit/);
    });

    it('re-reads a part whose moof is larger than the first read', async () => {
        const s = streams();
        const big = buildFragment({
            decodeTime: 0,
            firstCto: 83,
            trafPadding: 200 * 1024,
            payload: Buffer.from('v0-big'),
        });
        await fs.writeFile(path.join(s.video.partsDir, 'gop_000000.m4s'), big);
        partCounter = 1;
        for (const k of [3.5, 13.25]) await videoPart(k);
        await audioParts(0, 14);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(await segmentStarts(s.video.streamDir)).toEqual([0.083]);
    });

    it('matches a first fragment by decode time when its reorder delay is large', async () => {
        const s = streams();
        // presentation 0.45 s (deep B-pyramid), decode 0: keyframe 0.
        await fs.writeFile(
            path.join(s.video.partsDir, 'gop_000000.m4s'),
            buildFragment({ decodeTime: 0, firstCto: 450, payload: Buffer.from('v0') }),
        );
        partCounter = 1;
        for (const k of [3.5, 13.25]) await videoPart(k);
        await audioParts(0, 14);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(a.readyEntries).toBe(1);
    });

    it('keys parts by the run offset when keyframes sit closer than it', async () => {
        // Prod 2026-10-15, South Park S15E13 (25 fps h264, one B-frame): keyframes
        // two frames apart at the start, and FFmpeg's parts start 0.08 s after
        // their keyframe (decode 0.04 s after). Nearest-keyframe matching put
        // every part on the NEXT keyframe and tripped "no part starts on the
        // keyframe of entry 0".
        const kfs = [
            0, 0.08, 0.16, 1.68, 1.84, 2.08, 4.8, 4.92, 7.84, 10.72, 13.56, 14.12, 14.68, 15.2,
            15.84, 16.6, 20.16, 20.72, 21.24,
        ];
        grid = buildGopGrid(kfs, 22, 10)!;
        expect(grid.starts.slice(0, 2)).toEqual([0, 10.72]);
        const s = streams();
        for (const [i, k] of kfs.slice(0, 18).entries()) {
            await fs.writeFile(
                path.join(s.video.partsDir, `gop_${String(i).padStart(6, '0')}.m4s`),
                buildFragment({
                    decodeTime: Math.round((k + 0.04) * TS),
                    firstCto: 40,
                    payload: Buffer.from(`v${k}`),
                }),
            );
        }
        partCounter = 100;
        await audioParts(0, 21);
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(a.readyEntries).toBe(2);
        expect(await segmentStarts(s.video.streamDir)).toEqual([0.08, 10.8]);
        // Entry 0 holds all nine of its GOPs, entry 1 the next seven.
        const seg0 = await fs.readFile(path.join(s.video.streamDir, 'segment_00000.m4s'));
        expect(seg0.toString('latin1').match(/v\d/g)).toHaveLength(9);
    });

    it('does not condemn entry 0 on a first poll whose parts fit two offsets equally', async () => {
        // Parts at 0.08 and 0.16 are keyframes 0/0.08 under offset 0.08, and
        // keyframes 0.08/0.16 under offset 0: both score 2 on the first poll.
        // The tie used to resolve to 0, which left entry 0 without a part and
        // marked the stream broken for good before the third part could decide.
        const kfs = [0, 0.08, 0.16, 1.68, 1.84, 2.08, 4.8, 4.92, 7.84, 10.72, 13.56, 20.16];
        grid = buildGopGrid(kfs, 22, 10)!;
        const s = streams();
        const write = async (i: number, k: number): Promise<void> => {
            await fs.writeFile(
                path.join(s.video.partsDir, `gop_${String(i).padStart(6, '0')}.m4s`),
                buildFragment({
                    decodeTime: Math.round((k + 0.04) * TS),
                    firstCto: 40,
                    payload: Buffer.from(`v${k}`),
                }),
            );
        };
        await write(0, kfs[0]);
        await write(1, kfs[1]);
        partCounter = 100;
        await audioParts(0, 21);
        const onBroken = vi.fn();
        const { a } = assembler(0, { onBroken });
        await a.tick();
        expect(a.broken).toBeNull();
        expect(onBroken).not.toHaveBeenCalled();

        // The rest of the run arrives and settles the offset.
        for (const [i, k] of kfs.entries()) if (i >= 2) await write(i, k);
        await a.tick();
        expect(a.broken).toBeNull();
        expect(a.readyEntries).toBe(2);
        expect(await segmentStarts(s.video.streamDir)).toEqual([0.08, 10.8]);
    });

    it('keeps an entry assembled when the manifest write fails, and rewrites it later', async () => {
        const s = streams();
        for (const k of KF.slice(0, 3)) await videoPart(k);
        await audioParts(0, 14);
        // Block the manifest's temp name on the video stream.
        await fs.mkdir(path.join(s.video.streamDir, 'index.m3u8.tmp'));
        const { a } = assembler();
        await a.tick();
        expect(a.broken).toBeNull();
        expect(a.readyEntries).toBe(1);
        await fs.rm(path.join(s.video.streamDir, 'index.m3u8.tmp'), { recursive: true });
        await a.tick();
        const m = await fs.readFile(path.join(s.video.streamDir, 'index.m3u8'), 'utf8');
        expect([...m.matchAll(/segment_\d+\.m4s/g)]).toHaveLength(1);
        expect(a.broken).toBeNull();
    });

    it('runs concurrent final passes one after the other', async () => {
        const s = streams();
        for (const k of KF) await videoPart(k);
        await audioParts(0, TOTAL);
        const { a } = assembler();
        await Promise.all([a.tick({ final: true }), a.tick({ final: true }), a.tick()]);
        expect(a.broken).toBeNull();
        expect(a.complete).toBe(true);
        const seg0 = await fs.readFile(path.join(s.video.streamDir, 'segment_00000.m4s'));
        // Entry 0 = parts at 0 and 3.5, each written exactly once.
        expect(seg0.indexOf(Buffer.from('v0'))).toBe(seg0.lastIndexOf(Buffer.from('v0')));
    });

    it('prunes parts a respawned run re-emits behind its position', async () => {
        const s = streams();
        for (const k of KF.slice(0, 5)) await videoPart(k);
        await audioParts(0, 28.5);
        const { a } = assembler();
        await a.tick();
        expect(a.readyEntries).toBe(2);
        // The new run starts again at the generation start.
        for (const k of KF.slice(0, 4)) await videoPart(k);
        await a.tick();
        expect(a.broken).toBeNull();
        const left = (await fs.readdir(s.video.partsDir)).filter((n) => n.endsWith('.m4s'));
        expect(left).toHaveLength(1); // only 27.875, the next entry's start
    });

    it('does nothing once stopped, even for a final pass', async () => {
        const s = streams();
        for (const k of KF) await videoPart(k);
        await audioParts(0, TOTAL);
        const { a } = assembler();
        await a.stop();
        await a.tick({ final: true });
        const names = await fs.readdir(s.video.streamDir).catch(() => [] as string[]);
        expect(names.filter((n) => n.startsWith('segment_'))).toEqual([]);
        expect(a.broken).toBeNull();
    });
});
