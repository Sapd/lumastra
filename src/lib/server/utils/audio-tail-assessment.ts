// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { ffprobeLibraryInputArgs } from './library-input-guard.js';
import { spawnFFmpegSafely } from './ffmpeg-spawn.js';
import { isRecord } from '$lib/utils/data-extraction';
import type { AudioTailAssessment } from '$lib/schemas/audio-tail-assessment.js';

const exec = promisify(execFile);
export interface TailInventory {
    streams: Record<string, unknown>[];
    signature: string;
}
interface PacketTail {
    start: number;
    end: number;
    count: number;
}

/** A successful traversal to demux EOF is evidence; an empty or failed probe is not. */
async function readPacketTail(
    path: string,
    interval: string,
    stream: string,
    signal: AbortSignal,
): Promise<PacketTail> {
    const { stdout, stderr } = await exec(
        config.FFPROBE_PATH,
        [
            '-v',
            'error',
            '-select_streams',
            stream,
            '-read_intervals',
            interval,
            '-show_entries',
            'packet=pts_time,duration_time',
            '-of',
            'csv=p=0',
            ...(await ffprobeLibraryInputArgs(undefined, signal)),
            path,
        ],
        { timeout: 30_000, killSignal: 'SIGKILL', signal, maxBuffer: 8 * 1024 * 1024 },
    );
    if (stderr.trim()) throw new Error('packet_probe_error');
    let start = Infinity;
    let end = -Infinity;
    let count = 0;
    for (const raw of stdout.split('\n')) {
        if (!raw.trim()) continue;
        const [ptsText, durationText, ...extra] = raw.trim().split(',');
        const pts = Number(ptsText);
        const duration = Number(durationText);
        if (
            extra.length > 0 ||
            !ptsText ||
            !durationText ||
            !Number.isFinite(pts) ||
            !Number.isFinite(duration) ||
            duration <= 0
        )
            throw new Error('invalid_packet_timing');
        start = Math.min(start, pts);
        end = Math.max(end, pts + duration);
        count++;
    }
    if (count === 0) throw new Error('missing_packet_eof');
    return { start, end, count };
}

/** One timestamp tick plus two samples covers container rounding and the sample grid. */
function timingTolerance(stream: Record<string, unknown>, rate: number): number {
    const [numerator, denominator] = String(stream.time_base).split('/').map(Number);
    return Math.min(0.005, numerator / denominator + 2 / rate);
}
/** Raw inventory, with absent fields left absent. Normalized playback defaults are not evidence. */
export async function readTailInventory(
    path: string,
    signal?: AbortSignal,
): Promise<TailInventory> {
    const { stdout, stderr } = await exec(
        config.FFPROBE_PATH,
        [
            '-v',
            'error',
            '-show_streams',
            '-of',
            'json',
            ...(await ffprobeLibraryInputArgs(undefined, signal)),
            path,
        ],
        { timeout: 10000, killSignal: 'SIGKILL', signal, maxBuffer: 2 * 1024 * 1024 },
    );
    if (stderr.trim()) throw new Error('inventory_probe_error');
    const parsed: unknown = JSON.parse(stdout);
    if (!isRecord(parsed) || !Array.isArray(parsed.streams) || !parsed.streams.every(isRecord))
        throw new Error('inventory_unavailable');
    const streams = parsed.streams;
    return {
        streams,
        signature: createHash('sha256').update(JSON.stringify(streams)).digest('hex'),
    };
}

interface Frame {
    pts: number;
    samples?: number;
    peak: Map<number, number>;
    rms: Map<number, number>;
    zero: Set<number>;
}
/** -inf is digital zero, represented by a finite floor plus an explicit flag. */
function db(value: string): number | undefined {
    if (value === '-inf') return -300;
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
}
export function summarizeTailFrames(
    text: string,
    index: number,
    channels: number,
    rate: number,
    start: number,
    end: number,
    tolerance = 2 / rate,
    frameTolerance = tolerance,
): AudioTailAssessment['streams'][number] {
    const frames: Frame[] = [];
    let frame: Frame | undefined;
    for (const line of text.split('\n')) {
        const header = /^frame:\d+\s+pts:\S+\s+pts_time:(\S+)/.exec(line);
        if (header) {
            frame = { pts: Number(header[1]), peak: new Map(), rms: new Map(), zero: new Set() };
            frames.push(frame);
        } else if (frame) {
            const stat = /^lavfi\.astats\.(\d+)\.(Peak_level|RMS_level)=(.+)$/.exec(line);
            if (stat) {
                if (stat[2] === 'Peak_level' && stat[3] === '-inf') frame.zero.add(Number(stat[1]));
                const value = db(stat[3]);
                if (value !== undefined)
                    (stat[2] === 'Peak_level' ? frame.peak : frame.rms).set(Number(stat[1]), value);
            }
            const samples = /^lavfi\.astats\.Overall\.Number_of_samples=(\S+)/.exec(line);
            if (samples) frame.samples = Number(samples[1]);
        }
    }
    const peaks = Array<number>(channels).fill(-300);
    const energies = Array<number>(channels).fill(0);
    const zero = Array<boolean>(channels).fill(true);
    let samples = 0;
    let first: number | undefined;
    let previousEnd: number | undefined;
    let continuous = true;
    for (const f of frames) {
        if (
            !Number.isFinite(f.pts) ||
            !Number.isInteger(f.samples) ||
            !f.samples ||
            f.samples < 0 ||
            f.peak.size !== channels ||
            f.rms.size !== channels
        ) {
            continuous = false;
            continue;
        }
        const frameEnd = f.pts + f.samples / rate;
        if (first === undefined) first = f.pts;
        // A widened per-frame clock allowance must not hide a gap followed by
        // an overlap. Decoded sample count fixes each frame's expected position.
        if (Math.abs(f.pts - (first + samples / rate)) > tolerance) continuous = false;
        if (previousEnd !== undefined && Math.abs(f.pts - previousEnd) > frameTolerance)
            continuous = false;
        previousEnd = frameEnd;
        for (let c = 1; c <= channels; c++) {
            const peak = f.peak.get(c);
            const rms = f.rms.get(c);
            if (peak === undefined || rms === undefined) {
                continuous = false;
                continue;
            }
            peaks[c - 1] = Math.max(peaks[c - 1], peak);
            energies[c - 1] += Math.pow(10, rms / 10) * f.samples;
            zero[c - 1] &&= f.zero.has(c);
        }
        samples += f.samples;
    }
    if (
        first === undefined ||
        previousEnd === undefined ||
        Math.abs(first - start) > tolerance ||
        Math.abs(previousEnd - end) > tolerance ||
        Math.abs(samples / rate - (end - start)) > 2 * tolerance
    )
        continuous = false;
    return {
        index,
        requested: { start, end },
        ...(first !== undefined && previousEnd !== undefined
            ? { decoded: { start: first, end: previousEnd } }
            : {}),
        samples,
        coverageSeconds: samples / rate,
        continuous,
        channels:
            samples > 0
                ? peaks.map((peakDbfs, i) => ({
                      channel: i + 1,
                      peakDbfs,
                      rmsDbfs: zero[i]
                          ? -300
                          : Math.max(-300, 10 * Math.log10(energies[i] / samples)),
                      digitalZero: zero[i],
                  }))
                : [],
        reasons: continuous ? [] : ['incomplete_or_discontinuous_timestamps'],
    };
}

/** Bounded observation only: even complete near-silence never establishes file completeness. */
export async function measureAudioTail(
    path: string,
    videoEnd: number | null,
    audioEnd: number | null,
    source: AudioTailAssessment['source'],
    signal?: AbortSignal,
    budgetMs = 90000,
): Promise<AudioTailAssessment> {
    const deadline = AbortSignal.timeout(budgetMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const result: AudioTailAssessment = {
        version: 1,
        measuredAt: new Date().toISOString(),
        method: 'ffmpeg-astats-frames-v2',
        thresholdDbfs: -60,
        completeness: 'unverified',
        scope: 'inconclusive',
        observation: 'unknown',
        inventory: [],
        inventorySignature: '',
        source,
        limits: { seconds: 180, streams: 8, concurrency: 2, budgetMs: 90000 },
        reasons: [],
        streams: [],
    };
    try {
        const inventory = await readTailInventory(path, bounded);
        result.inventory = inventory.streams;
        result.inventorySignature = inventory.signature;
        const audios = inventory.streams.filter((s) => s.codec_type === 'audio');
        const video = inventory.streams.find((s) => s.codec_type === 'video');
        const validBasis = (stream: Record<string, unknown>): boolean =>
            Number.isInteger(stream.index) &&
            Number(stream.index) >= 0 &&
            typeof stream.start_time === 'string' &&
            /^-?\d+(?:\.\d+)?$/.test(stream.start_time) &&
            Number.isFinite(Number(stream.start_time)) &&
            typeof stream.time_base === 'string' &&
            /^\d+\/[1-9]\d*$/.test(stream.time_base) &&
            Number(stream.time_base.split('/')[0]) > 0;
        if (
            !video ||
            !validBasis(video) ||
            new Set(inventory.streams.map((s) => s.index)).size !== inventory.streams.length
        )
            result.reasons.push('invalid_timing_inventory');
        // Header endpoints describe expected scope, but do not prove packet or decoded EOF.
        const ends = audios.map((s) => {
            const duration = Number(s.duration);
            const offset = Number(s.start_time);
            const tags = isRecord(s.tags) ? s.tags : {};
            const tagged =
                typeof tags.DURATION === 'string'
                    ? /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(tags.DURATION)
                    : null;
            const declared: number[][] = [];
            if (Number.isFinite(duration) && Number.isFinite(offset))
                declared.push([offset + duration]);
            if (tagged) {
                const tagSeconds =
                    Number(tagged[1]) * 3600 + Number(tagged[2]) * 60 + Number(tagged[3]);
                // Matroska DURATION is a free-form tag: writers use both an
                // absolute endpoint and a length relative to stream start_time.
                // Accept either interpretation only when it agrees with packet EOF.
                declared.push([tagSeconds, offset + tagSeconds]);
            }
            return declared;
        });
        if (videoEnd === null || !Number.isFinite(videoEnd) || audios.length === 0) {
            result.reasons.push('no_measurable_post_video_interval');
            return result;
        }
        let physicalEnd: number;
        try {
            // Seek to the end and read through real demux EOF. This is only a bound for
            // the subsequent per-stream traversals; it never substitutes for them.
            physicalEnd = (await readPacketTail(path, '999999%', 'a', bounded)).end;
        } catch {
            signal?.throwIfAborted();
            result.reasons.push(deadline.aborted ? 'measurement_budget' : 'packet_eof_unavailable');
            return result;
        }
        const tailEnd = Math.max(videoEnd, physicalEnd);
        if (tailEnd <= videoEnd) {
            result.reasons.push('no_measurable_post_video_interval');
            return result;
        }
        result.requested = { start: videoEnd, end: tailEnd };
        if (tailEnd - videoEnd > 180) result.reasons.push('tail_duration_cap');
        if (audios.length > 8) result.reasons.push('audio_stream_cap');
        const end = Math.min(tailEnd, videoEnd + 180);
        const start = videoEnd;
        const candidates = audios.slice(0, 8);
        let cursor = 0;
        const worker = async (): Promise<void> => {
            while (cursor < candidates.length) {
                const ordinal = cursor++;
                const stream = candidates[ordinal];
                const index = Number(stream.index),
                    channels = Number(stream.channels),
                    rate = Number(stream.sample_rate);
                if (
                    !Number.isInteger(index) ||
                    index < 0 ||
                    !Number.isInteger(channels) ||
                    channels < 1 ||
                    channels > 64 ||
                    !Number.isFinite(rate) ||
                    rate <= 0 ||
                    !validBasis(stream)
                ) {
                    result.reasons.push('invalid_audio_inventory');
                    continue;
                }
                const tolerance = timingTolerance(stream, rate);
                const timeBaseTick =
                    Number(String(stream.time_base).split('/')[0]) /
                    Number(String(stream.time_base).split('/')[1]);
                if (timeBaseTick + 2 / rate > 0.005) result.reasons.push('coarse_stream_clock');
                const seek = Math.max(0, start - 2);
                try {
                    const packets = await readPacketTail(
                        path,
                        tailEnd - start > 180 ? `${seek}%+${end - seek}` : `${seek}%`,
                        `a:${ordinal}`,
                        bounded,
                    );
                    const packetEof = tailEnd - start <= 180;
                    const packetEnd = packets.end;
                    if (packetEof && packetEnd > tailEnd + tolerance)
                        result.reasons.push('packet_tail_beyond_global_eof');
                    const declaredEnds = ends[ordinal];
                    const endpointReason = declaredEnds.some(
                        (alternatives) =>
                            !alternatives.some(
                                (declaredEnd) => Math.abs(packetEnd - declaredEnd) <= tolerance,
                            ),
                    )
                        ? 'declared_endpoint_inconsistent'
                        : undefined;
                    if (Number.isFinite(audioEnd) && packetEnd > Number(audioEnd) + tolerance)
                        result.reasons.push('packet_tail_disagrees_with_probe');
                    if (packetEnd <= start) {
                        result.streams.push({
                            index,
                            requested: { start, end: start },
                            packetEof,
                            packetInterval: { start: packets.start, end: packetEnd },
                            packetCount: packets.count,
                            packetEnd,
                            noPostVideoPackets: true,
                            timingToleranceSeconds: tolerance,
                            samples: 0,
                            coverageSeconds: 0,
                            continuous: packetEof,
                            channels: [],
                            reasons: packetEof ? [] : ['packet_eof_unproven'],
                        });
                        if (endpointReason) result.reasons.push(endpointReason);
                        continue;
                    }
                    const streamEnd = Math.min(packetEnd, end);
                    const output = await spawnFFmpegSafely({
                        args: [
                            '-hide_banner',
                            '-nostdin',
                            '-v',
                            'error',
                            '-xerror',
                            '-copyts',
                            '-ss',
                            String(seek),
                            '-t',
                            String(streamEnd - seek + 2),
                            '-i',
                            path,
                            '-map',
                            `0:${index}`,
                            '-vn',
                            '-sn',
                            '-dn',
                            '-af',
                            `${packetEof ? `atrim=start=${start}` : `atrim=start=${start}:end=${end}`},astats=metadata=1:reset=1:measure_perchannel=Peak_level+RMS_level:measure_overall=Number_of_samples,ametadata=print:file=-`,
                            '-f',
                            'null',
                            '-',
                        ],
                        libraryInput: path,
                        abortSignal: bounded,
                        timeout: 90000,
                        maxStdoutSize: 24 * 1024 * 1024,
                        expectFailure: true,
                    });
                    const measured = summarizeTailFrames(
                        output.stdout,
                        index,
                        channels,
                        rate,
                        start,
                        streamEnd,
                        tolerance,
                        // AAC frames inherit a coarse container clock. FFmpeg can
                        // place adjacent decoded frames just over one tick apart
                        // even when the total samples and both endpoints agree.
                        // Keep endpoint and coverage checks at the tighter tolerance.
                        stream.codec_name === 'aac'
                            ? Math.min(0.005, 2 * timeBaseTick + 2 / rate)
                            : tolerance,
                    );
                    measured.packetEof = packetEof;
                    measured.packetInterval = { start: packets.start, end: packetEnd };
                    measured.packetCount = packets.count;
                    measured.packetEnd = packetEnd;
                    measured.timingToleranceSeconds = tolerance;
                    if (!packetEof) {
                        measured.continuous = false;
                        measured.reasons.push('packet_eof_unproven');
                    }
                    if (endpointReason) result.reasons.push(endpointReason);
                    if (output.stderr.trim()) {
                        measured.continuous = false;
                        measured.reasons.push('decoder_reported_errors');
                    }
                    result.streams.push(measured);
                } catch {
                    signal?.throwIfAborted();
                    const reason = deadline.aborted
                        ? 'measurement_budget'
                        : 'packet_or_decode_failed';
                    result.reasons.push(reason);
                    result.streams.push({
                        index,
                        requested: { start, end },
                        samples: 0,
                        coverageSeconds: 0,
                        continuous: false,
                        channels: [],
                        reasons: [reason],
                    });
                }
            }
        };
        await Promise.all([worker(), worker()]);
        signal?.throwIfAborted();
        result.streams.sort((a, b) => a.index - b.index);
        const complete =
            result.reasons.length === 0 &&
            result.streams.length === audios.length &&
            result.streams.every((s) => s.continuous);
        result.scope = complete ? 'measured' : result.streams.length ? 'partial' : 'inconclusive';
        const audible = result.streams.some((s) => s.channels.some((c) => c.peakDbfs > -60));
        result.observation = audible ? 'audible' : complete ? 'near_silent' : 'unknown';
        return result;
    } catch {
        signal?.throwIfAborted();
        result.reasons.push(deadline.aborted ? 'measurement_budget' : 'inventory_unavailable');
        return result;
    }
}
