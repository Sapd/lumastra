// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Joins GOP-mode FFmpeg parts into keyframe-grid HLS entries.
 *
 * In GOP mode (gop-grid.ts) FFmpeg writes video as one file per keyframe into
 * `stream_<N>/gop/` and audio as ~0.5 s parts into `stream_<i>/parts/`, all with
 * source-absolute tfdt. This module turns them into exactly what every other
 * part of the HLS stack already expects in `stream_<i>/`:
 *
 *   segment_<n - gridOffset>.m4s   grid entry n (written via .tmp + rename)
 *   init_<i>.mp4                   copied up from the parts dir
 *   index.m3u8                     EVENT playlist of the assembled entries,
 *                                  EXTINF = grid duration, ENDLIST at the end
 *
 * Parts are identified by their presentation time, never by file name: a cut
 * FFmpeg merged or skipped must not silently shift every later entry. A video
 * entry boundary that no part starts on, while later content exists, marks the
 * stream broken (the caller fails closed). Merged parts INSIDE an entry are
 * harmless — the entry just has fewer parts.
 *
 * A video part's presentation time is its keyframe's plus one offset for the
 * whole run (B-frame reorder delay plus FFmpeg's start shift; 0.08 s on a
 * 25 fps h264 WEB-DL). Nearest-keyframe matching alone breaks when keyframes
 * sit closer than that offset (South Park S15E13 opens with keyframes at 0,
 * 0.08 and 0.16): every part matched the NEXT keyframe and entry 0 had none.
 * So the offset is learned from the run's parts first (see videoOffset).
 */

import { createReadStream, createWriteStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import { pipeline } from 'stream/promises';

import { readFragmentStart, readTrackTimescale } from './fmp4-timing.js';
import type { GopGrid } from './gop-grid.js';

/** Max distance (s) between a video part's presentation time and its keyframe. */
const KEYFRAME_MATCH_TOLERANCE_SECONDS = 0.3;
/**
 * A part on its keyframe once the run's offset is removed. Both times come from
 * the source's own timestamps, so they agree far closer than one frame.
 */
const KEYFRAME_EXACT_SECONDS = 0.002;
/** Most recent video part times the run's offset is learned from. */
const OFFSET_SAMPLES = 64;
/**
 * While two offsets explain the parts seen so far equally well, a missing
 * boundary part is not yet a verdict: the next parts decide. After this many
 * parts the tie is real and the smallest offset stands.
 */
const OFFSET_AMBIGUITY_PATIENCE_PARTS = 8;
const DEFAULT_POLL_INTERVAL_MS = 200;
/** First read of a part; a longer moof (a very long GOP) gets a full re-read. */
const HEADER_READ_BYTES = 64 * 1024;
/** Upper bound for that re-read. */
const MAX_HEADER_READ_BYTES = 16 * 1024 * 1024;

/** The slice of a LoggerInstance the assembler uses. */
export interface AssemblerLog {
    info(message: string, ...args: unknown[]): void;
    warn(message: string, ...args: unknown[]): void;
    error(message: string, ...args: unknown[]): void;
    debug(message: string, ...args: unknown[]): void;
}

export interface AssemblerStream {
    kind: 'video' | 'audio';
    /** `stream_<i>` directory that receives the assembled entries. */
    streamDir: string;
    /** Where FFmpeg writes this stream's parts and init. */
    partsDir: string;
    partPrefix: string;
    /** Init file name (same name in partsDir and streamDir). */
    initName: string;
}

export interface AssemblerOptions {
    grid: GopGrid;
    /** Grid entry this generation starts at; entry n lands in segment_<n - gridOffset>. */
    gridOffset: number;
    /** The job's segment duration: the floor for the on-disk TARGETDURATION. */
    segmentSeconds?: number;
    streams: AssemblerStream[];
    log: AssemblerLog;
    /** Contiguous entries assembled on every stream (relative to gridOffset). */
    onProgress?: (readyEntries: number) => void;
    onBroken?: (reason: string) => void;
}

interface PartInfo {
    name: string;
    /** Video: keyframe index (re-derived every pass). Audio: grid entry. */
    key: number;
    /** Video: presentation time. Audio: decode time. */
    start: number;
    /** Video: decode time. */
    decode?: number;
}

interface StreamState {
    cfg: AssemblerStream;
    timescale: number | null;
    /** Next grid entry to assemble. */
    next: number;
    initCopied: boolean;
    entries: { duration: number; uri: string }[];
    ended: boolean;
    /** The on-disk manifest lags `entries` (a write failed); retried every pass. */
    manifestDirty: boolean;
    /**
     * Audio: the last part of the previous entry, kept on disk until the next
     * entry is written. An entry shorter than one part has no audio of its own
     * and reuses it (same samples, same tfdt — a player overwrites the range).
     */
    carry: PartInfo | null;
    timing: Map<string, PartInfo | null>;
    /** Video: presentation times of the run's parts, newest last (OFFSET_SAMPLES). */
    samples: number[];
    /** Video: the run's presentation offset, learned from `samples`; null = stale. */
    offset: number | null;
    /** Video: another offset explains `samples` as well as `offset` does. */
    offsetAmbiguous: boolean;
}

export class GopSegmentAssembler {
    private readonly grid: GopGrid;
    private readonly gridOffset: number;
    private readonly segmentSeconds: number;
    private readonly log: AssemblerOptions['log'];
    private readonly onProgress?: (n: number) => void;
    private readonly onBroken?: (reason: string) => void;
    private readonly streams: StreamState[];
    private timer: ReturnType<typeof setInterval> | null = null;
    private running: Promise<void> | null = null;
    private stopped = false;
    private brokenReason: string | null = null;
    private lastReported = -1;

    constructor(o: AssemblerOptions) {
        this.grid = o.grid;
        this.gridOffset = o.gridOffset;
        this.segmentSeconds = o.segmentSeconds ?? 10;
        this.log = o.log;
        this.onProgress = o.onProgress;
        this.onBroken = o.onBroken;
        this.streams = o.streams.map((cfg) => ({
            cfg,
            timescale: null,
            next: o.gridOffset,
            initCopied: false,
            entries: [],
            ended: false,
            manifestDirty: false,
            timing: new Map(),
            carry: null,
            samples: [],
            offset: null,
            offsetAmbiguous: false,
        }));
    }

    get readyEntries(): number {
        return Math.min(...this.streams.map((s) => s.next - this.gridOffset));
    }

    get broken(): string | null {
        return this.brokenReason;
    }

    get complete(): boolean {
        return this.streams.every((s) => s.ended);
    }

    get isStopped(): boolean {
        return this.stopped;
    }

    start(intervalMs: number = DEFAULT_POLL_INTERVAL_MS): void {
        if (this.timer || this.stopped) return;
        this.timer = setInterval(() => {
            void this.tick();
        }, intervalMs);
        this.timer.unref?.();
    }

    /**
     * One scan + assemble pass. Overlapping calls share the running pass;
     * `final` (FFmpeg exited cleanly) waits for it and then runs its own.
     */
    async tick(opts: { final?: boolean } = {}): Promise<void> {
        const final = opts.final === true;
        if (this.running && !final) {
            await this.running;
            return;
        }
        // A final pass must run on its own: two passes on one stream would
        // write the same .tmp twice and advance past an entry.
        while (this.running) await this.running.catch(() => {});
        // A retired generation's output is being deleted: nothing to finish.
        if (this.stopped) return;
        this.running = this.pass(final).finally(() => {
            this.running = null;
        });
        await this.running;
    }

    /** Stop polling, then remove temporary files and the parts directories. */
    async stop(): Promise<void> {
        this.stopped = true;
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.running) await this.running.catch(() => {});
        for (const s of this.streams) {
            await fs.rm(s.cfg.partsDir, { recursive: true, force: true }).catch(() => {});
            const names = await fs.readdir(s.cfg.streamDir).catch(() => [] as string[]);
            for (const name of names) {
                if (name.endsWith('.tmp')) {
                    await fs.rm(path.join(s.cfg.streamDir, name), { force: true }).catch(() => {});
                }
            }
        }
    }

    private async pass(final: boolean): Promise<void> {
        if (this.brokenReason) return;
        for (const s of this.streams) {
            if (s.manifestDirty) await this.writeManifest(s).catch(() => {});
        }
        for (const s of this.streams) {
            try {
                await this.assembleStream(s, final);
            } catch (err) {
                // Filesystem hiccup (or the generation dir was reaped under us):
                // retry on the next tick rather than declare the stream broken.
                this.log.warn('GOP assembler pass failed; retrying', {
                    stream: path.basename(s.cfg.streamDir),
                    error: err instanceof Error ? err.message : String(err),
                });
            }
            if (this.brokenReason) return;
        }
        const ready = this.readyEntries;
        if (ready !== this.lastReported) {
            this.lastReported = ready;
            this.onProgress?.(ready);
        }
        if ((this.complete || this.brokenReason) && this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private markBroken(s: StreamState, reason: string): void {
        if (this.brokenReason) return;
        this.brokenReason = `${path.basename(s.cfg.streamDir)}: ${reason}`;
        this.log.error('GOP assembler: refusing to build a shifted segment', {
            stream: path.basename(s.cfg.streamDir),
            reason,
            entry: s.next,
            gridOffset: this.gridOffset,
        });
        this.onBroken?.(this.brokenReason);
    }

    private async listParts(s: StreamState): Promise<PartInfo[]> {
        const names = await fs.readdir(s.cfg.partsDir).catch(() => [] as string[]);
        const pattern = new RegExp(`^${s.cfg.partPrefix}\\d+\\.m4s$`);
        if (s.timescale === null) {
            const init = await fs
                .readFile(path.join(s.cfg.partsDir, s.cfg.initName))
                .catch(() => null);
            s.timescale = init ? readTrackTimescale(init) : null;
            if (s.timescale === null) return [];
        }
        const parts: PartInfo[] = [];
        for (const name of names) {
            if (!pattern.test(name)) continue;
            let info = s.timing.get(name);
            if (info === undefined) {
                info = await this.timePart(s, name);
                s.timing.set(name, info);
            }
            if (info) parts.push(info);
        }
        if (s.cfg.kind === 'video' && !this.keyVideoParts(s, parts)) return [];
        return parts.sort((a, b) => a.start - b.start);
    }

    /** Assign every video part its keyframe under the run's offset; false when one has none. */
    private keyVideoParts(s: StreamState, parts: PartInfo[]): boolean {
        if (s.offset === null) {
            const learned = this.videoOffset(s.samples);
            s.offset = learned.offset;
            s.offsetAmbiguous = learned.ambiguous;
        }
        const offset = s.offset;
        for (const p of parts) {
            // A run's very first fragment can carry a reorder delay larger than
            // the tolerance (deep B-pyramid, low frame rate); its decode time is
            // the keyframe's then.
            const kf =
                this.nearestKeyframe(p.start - offset, KEYFRAME_EXACT_SECONDS) ??
                this.nearestKeyframe(p.start - offset) ??
                this.nearestKeyframe(p.decode ?? p.start);
            if (kf === null) {
                this.markBroken(
                    s,
                    `${p.name} starts at ${p.start.toFixed(3)}s, no keyframe within ${KEYFRAME_MATCH_TOLERANCE_SECONDS}s`,
                );
                return false;
            }
            p.key = kf;
        }
        return true;
    }

    /**
     * The run's presentation offset: of the offsets that put some part exactly
     * on a keyframe within the tolerance, the one that does so for the most
     * parts (ties: the smallest, reported as `ambiguous`). 0 when no part sits
     * exactly on a keyframe, which keeps plain nearest-keyframe matching.
     */
    private videoOffset(samples: number[]): { offset: number; ambiguous: boolean } {
        const kfs = this.grid.keyframes;
        const candidates = new Set<number>();
        for (const t of samples) {
            let i = this.keyframeIndexAtOrAfter(t - KEYFRAME_MATCH_TOLERANCE_SECONDS);
            for (; i < kfs.length && kfs[i] <= t + KEYFRAME_MATCH_TOLERANCE_SECONDS; i++) {
                candidates.add(Math.round((t - kfs[i]) * 1e6) / 1e6);
            }
        }
        let best = 0;
        let bestScore = 0;
        let ambiguous = false;
        for (const offset of candidates) {
            const score = samples.filter(
                (t) => this.nearestKeyframe(t - offset, KEYFRAME_EXACT_SECONDS) !== null,
            ).length;
            if (score > bestScore) {
                best = offset;
                bestScore = score;
                ambiguous = false;
            } else if (score === bestScore && score > 0) {
                if (Math.abs(offset - best) > KEYFRAME_EXACT_SECONDS) ambiguous = true;
                if (Math.abs(offset) < Math.abs(best)) best = offset;
            }
        }
        return { offset: best, ambiguous };
    }

    /**
     * The run's offset is still a tie between two readings and few parts have
     * arrived: a boundary keyframe without a part may just be the other reading.
     */
    private offsetStillUndecided(s: StreamState, final: boolean): boolean {
        return (
            !final &&
            s.cfg.kind === 'video' &&
            s.offsetAmbiguous &&
            s.samples.length < OFFSET_AMBIGUITY_PATIENCE_PARTS
        );
    }

    private async timePart(s: StreamState, name: string): Promise<PartInfo | null> {
        // The fragment header sits at the front. 64 KiB covers moof for normal
        // GOPs; a very long one (~16 B of trun per sample) gets a full re-read.
        const handle = await fs.open(path.join(s.cfg.partsDir, name), 'r');
        let t: ReturnType<typeof readFragmentStart>;
        try {
            let size = HEADER_READ_BYTES;
            for (;;) {
                const buf = Buffer.alloc(size);
                const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
                t = readFragmentStart(buf.subarray(0, bytesRead), s.timescale!);
                if (t || bytesRead < size || size >= MAX_HEADER_READ_BYTES) break;
                size = Math.min(MAX_HEADER_READ_BYTES, (await handle.stat()).size);
            }
        } finally {
            await handle.close();
        }
        if (!t) {
            this.markBroken(s, `unreadable fragment timing in ${name}`);
            return null;
        }
        if (s.cfg.kind === 'audio') {
            return { name, start: t.decodeSeconds, key: this.entryForTime(t.decodeSeconds) };
        }
        s.samples.push(t.presentationSeconds);
        if (s.samples.length > OFFSET_SAMPLES) s.samples.shift();
        s.offset = null;
        return { name, start: t.presentationSeconds, decode: t.decodeSeconds, key: -1 };
    }

    /** First keyframe index at or after `t` (keyframes.length when none). */
    private keyframeIndexAtOrAfter(t: number): number {
        const kfs = this.grid.keyframes;
        let lo = 0;
        let hi = kfs.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (kfs[mid] < t) lo = mid + 1;
            else hi = mid;
        }
        return lo;
    }

    private nearestKeyframe(
        t: number,
        tolerance: number = KEYFRAME_MATCH_TOLERANCE_SECONDS,
    ): number | null {
        const kfs = this.grid.keyframes;
        const lo = Math.min(this.keyframeIndexAtOrAfter(t), kfs.length - 1);
        let best = lo;
        if (lo > 0 && Math.abs(kfs[lo - 1] - t) < Math.abs(kfs[lo] - t)) best = lo - 1;
        return Math.abs(kfs[best] - t) <= tolerance ? best : null;
    }

    private entryForTime(t: number): number {
        const starts = this.grid.starts;
        let lo = 0;
        let hi = this.grid.count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= t) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    }

    /** Assemble as many complete entries of one stream as are available. */
    private async assembleStream(s: StreamState, final: boolean): Promise<void> {
        if (s.ended) return;
        const parts = await this.listParts(s);
        if (this.brokenReason) return;
        const lastEntry = this.grid.count - 1;

        // Parts behind this stream's position are never served: FFmpeg landed on
        // an earlier keyframe, or a respawned run re-emitted assembled ground.
        // (Audio before the generation's first entry joins that entry instead.)
        const stale = parts.filter((x) =>
            s.cfg.kind === 'video'
                ? x.key < this.grid.firstKeyframe[s.next] && s.next <= lastEntry
                : x.key < s.next && s.next > this.gridOffset && x !== s.carry,
        );
        for (const p of stale) {
            await fs.rm(path.join(s.cfg.partsDir, p.name), { force: true });
            s.timing.delete(p.name);
        }
        const live = parts.filter((x) => !stale.includes(x));

        while (s.next <= lastEntry) {
            const n = s.next;
            const isLast = n === lastEntry;
            const selected =
                s.cfg.kind === 'video'
                    ? this.selectVideoEntry(s, live, n, isLast, final)
                    : this.selectAudioEntry(s, live, n, isLast, final);
            if (selected === 'broken' || this.brokenReason) return;
            if (selected === null) break;
            await this.writeEntry(s, n, selected);
            s.next++;
        }
        if (s.next > lastEntry) {
            if (!s.ended) {
                s.ended = true;
                await this.writeManifest(s);
            }
        } else if (final) {
            // FFmpeg read its input to the end, yet this stream stops short of
            // the grid: never publish a truncated end under the declared grid.
            this.markBroken(
                s,
                s.entries.length === 0
                    ? 'no output at a clean exit'
                    : `input ended before grid entry ${s.next} of ${lastEntry}`,
            );
        }
    }

    private selectVideoEntry(
        s: StreamState,
        parts: PartInfo[],
        n: number,
        isLast: boolean,
        final: boolean,
    ): PartInfo[] | null | 'broken' {
        const first = this.grid.firstKeyframe[n];
        const end = isLast ? Infinity : this.grid.firstKeyframe[n + 1];
        const startsAtBoundary = parts.some((p) => p.key === first);
        if (!startsAtBoundary) {
            // Content beyond the boundary without a part starting ON it means the
            // boundary keyframe was merged into an earlier part (or FFmpeg started
            // past it): this entry can never be built exactly.
            if (parts.some((p) => p.key > first)) {
                if (this.offsetStillUndecided(s, final)) return null;
                this.markBroken(s, `no part starts on the keyframe of entry ${n}`);
                return 'broken';
            }
            return null;
        }
        // The last entry's later GOPs may still be coming: only a clean exit
        // (final) says it is complete.
        const nextStarts = isLast ? final : parts.some((p) => p.key === end);
        if (!nextStarts) {
            if (parts.some((p) => p.key > end)) {
                if (this.offsetStillUndecided(s, final)) return null;
                this.markBroken(s, `no part starts on the keyframe of entry ${n + 1}`);
                return 'broken';
            }
            if (!final) return null;
            // FFmpeg exited cleanly with nothing past this entry: it is the end
            // of the input even though the keyframe list promised more.
        }
        return parts.filter((p) => p.key >= first && p.key < end);
    }

    private selectAudioEntry(
        s: StreamState,
        parts: PartInfo[],
        n: number,
        isLast: boolean,
        final: boolean,
    ): PartInfo[] | null {
        // Audio that starts before this generation's first entry belongs to it.
        const inEntry = (p: PartInfo): boolean =>
            p.key === n || (n === this.gridOffset && p.key < n);
        const own = parts.filter((p) => inEntry(p) && p !== s.carry);
        const complete = isLast ? final : parts.some((p) => p.key > n) || final;
        if (!complete) return null;
        if (own.length > 0) return own;
        // No part starts inside this (shorter than one part) entry: reuse the
        // previous entry's last part rather than stall or serve nothing.
        if (s.carry) return [s.carry];
        return null;
    }

    private async writeEntry(s: StreamState, n: number, parts: PartInfo[]): Promise<void> {
        if (!s.initCopied) {
            const src = path.join(s.cfg.partsDir, s.cfg.initName);
            const dst = path.join(s.cfg.streamDir, s.cfg.initName);
            await fs.copyFile(src, `${dst}.tmp`);
            await fs.rename(`${dst}.tmp`, dst);
            s.initCopied = true;
        }
        const uri = `segment_${String(n - this.gridOffset).padStart(5, '0')}.m4s`;
        const target = path.join(s.cfg.streamDir, uri);
        const tmp = `${target}.tmp`;
        await fs.rm(tmp, { force: true });
        for (const p of parts) {
            await pipeline(
                createReadStream(path.join(s.cfg.partsDir, p.name)),
                createWriteStream(tmp, { flags: 'a' }),
            );
        }
        await fs.rename(tmp, target);
        // The entry exists from here on: record it BEFORE anything else can
        // fail, so a retry never rebuilds it from parts that are already gone.
        s.entries.push({ duration: this.grid.durations[n], uri });
        const keep = s.cfg.kind === 'audio' ? parts[parts.length - 1] : null;
        const release = [...parts, ...(s.carry && s.carry !== keep ? [s.carry] : [])];
        for (const p of release) {
            if (p === keep) continue;
            await fs.rm(path.join(s.cfg.partsDir, p.name), { force: true }).catch(() => {});
            s.timing.delete(p.name);
        }
        s.carry = keep;
        try {
            await this.writeManifest(s);
        } catch (err) {
            s.manifestDirty = true;
            this.log.warn('GOP assembler: manifest write failed; retrying', {
                stream: path.basename(s.cfg.streamDir),
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    private async writeManifest(s: StreamState): Promise<void> {
        const lines = [
            '#EXTM3U',
            '#EXT-X-VERSION:7',
            // A valid playlist: no EXTINF above it. GOP jobs never rescale progress
            // by a stream's target duration (cacheStreamTargetDuration skips them).
            `#EXT-X-TARGETDURATION:${Math.max(
                this.segmentSeconds,
                ...s.entries.map((e) => Math.round(e.duration)),
            )}`,
            '#EXT-X-MEDIA-SEQUENCE:0',
            '#EXT-X-PLAYLIST-TYPE:EVENT',
            `#EXT-X-MAP:URI="${s.cfg.initName}"`,
        ];
        for (const e of s.entries) {
            lines.push(`#EXTINF:${e.duration.toFixed(6)},`, e.uri);
        }
        if (s.ended) lines.push('#EXT-X-ENDLIST');
        const target = path.join(s.cfg.streamDir, 'index.m3u8');
        await fs.writeFile(`${target}.tmp`, lines.join('\n') + '\n');
        await fs.rename(`${target}.tmp`, target);
        s.manifestDirty = false;
    }
}
