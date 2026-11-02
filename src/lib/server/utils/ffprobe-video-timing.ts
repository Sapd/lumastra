// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** A bounded demux-only preflight, never a decoder-health verdict. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { safeStatBigInt } from './safe-fs.js';
import { config } from '$lib/server/config.js';
import { assertTranscodeInputIsMedia } from '$lib/server/services/transcoding/input-guard.js';
import { ffprobeLibraryInputArgs } from './library-input-guard.js';
import { isRecord } from '$lib/utils/data-extraction';

const execFileAsync = promisify(execFile);
const PACKET_CAP = 4096;
const OUTPUT_CAP = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const TOTAL_BUDGET_MS = 30_000;
const STAT_BUDGET_MS = 5_000;

export class NonadvancingVideoTimingError extends Error {
    constructor() {
        super(
            'Video packet timestamps do not advance despite sustained positive packet durations; repair the source file before retrying analysis',
        );
        this.name = 'NonadvancingVideoTimingError';
    }
}

/**
 * Require hundreds of consecutive positive-duration packets at precisely the
 * same presentation AND decode timestamp, representing >=10 seconds of video.
 * A few duplicate/reordered packets, VFR, missing PTS, and still pictures do not
 * meet that evidence. Non-discard payload must also exceed 1 MiB, rather
 * than counting header/empty/hidden temporal packets as displayed pictures.
 * AV1 is deliberately included: a few hidden/reordered temporal units are
 * legitimate, but hundreds of non-discard packets with positive durations and
 * both clocks frozen are not a usable video timeline.
 * The packet cap alone is never evidence. This says nothing about healthy decode.
 */
export function hasNonadvancingVideoTiming(value: unknown): boolean {
    if (!isRecord(value) || !Array.isArray(value.streams) || !Array.isArray(value.packets))
        return false;
    const stream: unknown = value.streams[0];
    if (!isRecord(stream) || typeof stream.codec_name !== 'string') return false;
    let previousPts: number | undefined;
    let previousDts: number | undefined;
    let count = 0;
    let duration = 0;
    let payloadBytes = 0;
    for (const packet of value.packets.slice(0, PACKET_CAP)) {
        if (!isRecord(packet)) {
            count = 0;
            duration = 0;
            payloadBytes = 0;
            continue;
        }
        const pts =
            typeof packet.pts_time === 'string' && packet.pts_time.trim() !== ''
                ? Number(packet.pts_time)
                : NaN;
        const dts =
            typeof packet.dts_time === 'string' && packet.dts_time.trim() !== ''
                ? Number(packet.dts_time)
                : NaN;
        const seconds =
            typeof packet.duration_time === 'string' && packet.duration_time.trim() !== ''
                ? Number(packet.duration_time)
                : NaN;
        const size = typeof packet.size === 'string' ? Number(packet.size) : NaN;
        const flags = typeof packet.flags === 'string' ? packet.flags : undefined;
        if (
            flags === undefined ||
            flags.includes('D') ||
            !Number.isSafeInteger(size) ||
            size <= 0 ||
            !Number.isFinite(pts) ||
            !Number.isFinite(dts) ||
            !Number.isFinite(seconds) ||
            seconds <= 0 ||
            seconds > 1
        ) {
            previousPts = undefined;
            previousDts = undefined;
            count = 0;
            duration = 0;
            payloadBytes = 0;
            continue;
        }
        if (pts === previousPts && dts === previousDts) {
            count += 1;
            duration += seconds;
            payloadBytes += size;
        } else {
            count = 1;
            duration = seconds;
            payloadBytes = size;
        }
        previousPts = pts;
        previousDts = dts;
        if (count >= 512 && duration >= 10 && payloadBytes >= 1024 * 1024) return true;
    }
    return false;
}

export type VideoTimingPreflight = 'nonadvancing' | 'inconclusive' | 'input-changed';

/** Stop waiting on an operation whose own guarded work may still be finishing. */
async function beforeDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    let interrupt!: () => void;
    const aborted = new Promise<never>((_, reject) => {
        interrupt = () => reject(signal.reason);
    });
    signal.addEventListener('abort', interrupt, { once: true });
    if (signal.aborted) interrupt();
    try {
        return await Promise.race([work, aborted]);
    } finally {
        signal.removeEventListener('abort', interrupt);
    }
}

/**
 * Selected file tail: <=4096 packets, <=2 MiB per output stream, <=15s subprocess.
 * The ENTIRE preflight (sniff, whitelist, both guarded precise stats, queue waits
 * and process) has a 30s deadline and caller abort. Each stat has a 5s sub-budget.
 * An aborted/stalled fs syscall retains its global safe-fs permit until it truly
 * settles; it cannot starve DNS/DB or launch abandoned queued work.
 * Negative/capped/uncertain evidence never establishes healthy decode.
 */
export async function probeVideoTiming(
    filePath: string,
    fileDurationSeconds: number,
    signal?: AbortSignal,
    threads = config.ANALYSIS_FFMPEG_THREADS,
): Promise<VideoTimingPreflight> {
    signal?.throwIfAborted();
    if (!Number.isFinite(fileDurationSeconds) || fileDurationSeconds <= 0) return 'inconclusive';
    const deadlineController = new AbortController();
    const timer = setTimeout(
        () =>
            deadlineController.abort(
                new DOMException('Video timing preflight deadline exceeded', 'TimeoutError'),
            ),
        TOTAL_BUDGET_MS,
    );
    const deadline = deadlineController.signal;
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    // FILE duration, not the 600/900-second decoder search window. A seek beyond
    // EOF missed the real AV1 defect by returning only the final 194-packet cue.
    const tailStartSeconds = Math.max(0, fileDurationSeconds - 10);
    try {
        const before = await safeStatBigInt(filePath, STAT_BUDGET_MS, bounded);
        await beforeDeadline(assertTranscodeInputIsMedia({ localFilePath: filePath }), bounded);
        const inputArgs = await beforeDeadline(ffprobeLibraryInputArgs(), bounded);
        let stdout: string | undefined;
        try {
            ({ stdout } = await execFileAsync(
                config.FFPROBE_PATH,
                [
                    '-v',
                    'error',
                    '-threads',
                    String(threads),
                    '-select_streams',
                    'v:0',
                    '-read_intervals',
                    `${tailStartSeconds}%+#${PACKET_CAP}`,
                    '-show_entries',
                    'stream=codec_name:packet=pts_time,dts_time,duration_time,size,flags',
                    '-of',
                    'json',
                    ...inputArgs,
                    filePath,
                ],
                {
                    timeout: TIMEOUT_MS,
                    maxBuffer: OUTPUT_CAP,
                    signal: bounded,
                    killSignal: 'SIGKILL',
                },
            ));
        } catch {
            bounded.throwIfAborted();
        }
        const after = await safeStatBigInt(filePath, STAT_BUDGET_MS, bounded);
        if (
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs
        )
            return 'input-changed';
        if (stdout === undefined) return 'inconclusive';
        const data: unknown = JSON.parse(stdout);
        return hasNonadvancingVideoTiming(data) ? 'nonadvancing' : 'inconclusive';
    } catch (err) {
        signal?.throwIfAborted();
        if (isRecord(err) && (err.code === 'ENOENT' || err.code === 'ENOTDIR'))
            return 'input-changed';
        return 'inconclusive';
    } finally {
        clearTimeout(timer);
    }
}
