// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { SegmentGenerationRoute } from '../ffmpeg-transcode.service.js';
import type { SegmentLogger } from './segment-diagnostics.js';
import type { TranscodeJob } from '../transcoding/types.js';

export type HlsSegmentClassifier =
    | 'tail_probe'
    | 'stale_ghost_audio'
    | 'retained_miss'
    | 'current_catchup_wait'
    | 'generation_route_fallback'
    | 'repeated_404_pressure'
    | 'missing_404';

export interface HlsSeekTraceStreamFirstServed {
    stream: string;
    requestedSegment: number;
    actualSegment: number;
    waitMs?: number;
    generationIndex: number;
}

export interface HlsSeekTraceState {
    key: string;
    playSessionId: string;
    generationIndex: number;
    seekCount: number;
    generationRole: string;
    trigger: string;
    triggerStream?: string;
    triggerSegment?: number;
    requestedStartTimeSeconds?: number;
    segmentOffset: number;
    startedAt: number;
    lastUpdatedAt: number;
    routeReason?: string;
    routeCandidates?: Array<Record<string, unknown>>;
    firstAudioServed?: HlsSeekTraceStreamFirstServed;
    firstVideoServed?: HlsSeekTraceStreamFirstServed;
    firstMuxedServed?: HlsSeekTraceStreamFirstServed;
    maxWaitMs: number;
    requestCount: number;
    classifierCounts: Partial<Record<HlsSegmentClassifier, number>>;
    emitted: boolean;
    warningKeys: Set<string>;
}

export interface ClassifyHlsSegmentRequestOptions {
    isTailProbe: boolean;
    isStaleGhostAudio: boolean;
    hasRetainedMiss: boolean;
    routeReason?: string;
    willWaitForCurrent: boolean;
    isRepeatedSegmentPressure: boolean;
    isMissing404?: boolean;
}

const traces = new Map<string, HlsSeekTraceState>();

function parseTrigger(trigger: string): {
    triggerStream?: string;
    triggerSegment?: number;
} {
    const match = trigger.match(/^(?:forward|backward):([^:]+):seg(\d+)$/);
    if (!match) return {};
    return {
        triggerStream: match[1],
        triggerSegment: parseInt(match[2], 10),
    };
}

function getTraceKey(job: TranscodeJob, playSessionId: string): string {
    return `${playSessionId}:${job.generationIndex}:${job.seekCount}:${job.lastSeekTrigger}`;
}

function getStreamRole(job: TranscodeJob, streamDir: string): 'audio' | 'video' | 'muxed' {
    if (!streamDir) return 'muxed';
    const videoStreamDir = `stream_${job.config.audioTracks.length}`;
    return streamDir === videoStreamDir ? 'video' : 'audio';
}

function shouldTraceJob(job: TranscodeJob): boolean {
    return (
        job.seekCount > 0 ||
        (job.requestedStartTimeSeconds ?? job.config.startTimeSeconds ?? 0) > 0 ||
        job.generationIndex > 1
    );
}

function getOrCreateTrace(
    job: TranscodeJob,
    playSessionId: string,
    segmentOffset: number,
    now: number,
): HlsSeekTraceState | undefined {
    if (!shouldTraceJob(job)) return undefined;

    const key = getTraceKey(job, playSessionId);
    const existing = traces.get(key);
    if (existing) {
        existing.lastUpdatedAt = now;
        return existing;
    }

    const triggerInfo = parseTrigger(job.lastSeekTrigger);
    const trace: HlsSeekTraceState = {
        key,
        playSessionId,
        generationIndex: job.generationIndex,
        seekCount: job.seekCount,
        generationRole: job.generationRole,
        trigger: job.lastSeekTrigger,
        triggerStream: triggerInfo.triggerStream,
        triggerSegment: triggerInfo.triggerSegment,
        requestedStartTimeSeconds: job.requestedStartTimeSeconds ?? job.config.startTimeSeconds,
        segmentOffset,
        startedAt: now,
        lastUpdatedAt: now,
        maxWaitMs: 0,
        requestCount: 0,
        classifierCounts: {},
        emitted: false,
        warningKeys: new Set(),
    };
    traces.set(key, trace);

    if (traces.size > 200) {
        for (const [entryKey, entry] of traces) {
            if (now - entry.lastUpdatedAt > 15 * 60_000) {
                traces.delete(entryKey);
            }
        }
        // If the stale sweep didn't bring us back under the cap — a steady trickle
        // of fresh entries under sustained multi-session seeking, where at least one
        // stale entry exists on each insert but new keys outpace it — evict the
        // oldest (Map preserves insertion order) so the map is genuinely bounded.
        // Runs per insert, so steady-state size stays ~200.
        if (traces.size > 200) {
            const oldestKey = traces.keys().next().value;
            if (oldestKey !== undefined) {
                traces.delete(oldestKey);
            }
        }
    }

    return trace;
}

export function classifyHlsSegmentRequest(
    options: ClassifyHlsSegmentRequestOptions,
): HlsSegmentClassifier[] {
    const classifiers: HlsSegmentClassifier[] = [];
    if (options.isTailProbe) classifiers.push('tail_probe');
    if (options.isStaleGhostAudio) classifiers.push('stale_ghost_audio');
    if (options.hasRetainedMiss) classifiers.push('retained_miss');
    if (
        options.routeReason === 'current-retained-file-miss' ||
        options.routeReason === 'retained-fallback-no-current'
    ) {
        classifiers.push('generation_route_fallback');
    }
    if (options.willWaitForCurrent) classifiers.push('current_catchup_wait');
    if (options.isRepeatedSegmentPressure) {
        classifiers.push('repeated_404_pressure');
    }
    if (options.isMissing404) classifiers.push('missing_404');
    return classifiers;
}

export function recordHlsSeekTraceRequest(options: {
    logger: SegmentLogger;
    job: TranscodeJob;
    playSessionId: string;
    streamDirName: string;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    route?: SegmentGenerationRoute;
    classifiers: HlsSegmentClassifier[];
    countRequest?: boolean;
    now?: number;
}): void {
    const now = options.now ?? Date.now();
    const trace = getOrCreateTrace(options.job, options.playSessionId, options.segmentOffset, now);
    if (!trace) return;

    if (options.countRequest !== false) {
        trace.requestCount += 1;
    }
    trace.routeReason ??= options.route?.reason;
    trace.routeCandidates ??= options.route?.candidates.map((candidate) => ({
        generation: candidate.generationIndex,
        role: candidate.generationRole,
        offset: candidate.offset,
        actual: candidate.actualIndex,
        progress: candidate.progress,
        covers: candidate.covers,
        current: candidate.isCurrent,
    }));

    for (const classifier of options.classifiers) {
        trace.classifierCounts[classifier] = (trace.classifierCounts[classifier] ?? 0) + 1;
        const warningKey = `${classifier}:${options.streamDirName}:${options.requestedSegmentNum}`;
        if (!trace.warningKeys.has(warningKey)) {
            trace.warningKeys.add(warningKey);
            // Every request near EOF is a tail probe, including normal playback.
            // Missing segments and the other anomaly classifiers remain warnings.
            const level = classifier === 'tail_probe' ? 'debug' : 'warn';
            options.logger[level]('hls-segment-classifier', {
                classifier,
                playSessionId: options.playSessionId,
                generationIndex: options.job.generationIndex,
                seekCount: options.job.seekCount,
                trigger: options.job.lastSeekTrigger,
                stream: options.streamDirName,
                requestedSegment: options.requestedSegmentNum,
                actualSegment: options.actualSegmentIndex,
                segmentOffset: options.segmentOffset,
                routeReason: options.route?.reason,
            });
        }
    }
}

export function recordHlsSeekTraceServed(options: {
    logger: SegmentLogger;
    job: TranscodeJob;
    playSessionId: string;
    streamDirName: string;
    requestedSegmentNum: number;
    actualSegmentIndex: number;
    segmentOffset: number;
    waitMs?: number;
    now?: number;
}): void {
    const now = options.now ?? Date.now();
    const trace = getOrCreateTrace(options.job, options.playSessionId, options.segmentOffset, now);
    if (!trace) return;

    const served: HlsSeekTraceStreamFirstServed = {
        stream: options.streamDirName,
        requestedSegment: options.requestedSegmentNum,
        actualSegment: options.actualSegmentIndex,
        waitMs: options.waitMs,
        generationIndex: options.job.generationIndex,
    };
    const role = getStreamRole(options.job, options.streamDirName);
    if (role === 'muxed') trace.firstMuxedServed ??= served;
    if (role === 'audio') trace.firstAudioServed ??= served;
    if (role === 'video') trace.firstVideoServed ??= served;
    trace.maxWaitMs = Math.max(trace.maxWaitMs, options.waitMs ?? 0);

    maybeEmitHlsSeekTraceSummary(options.logger, trace);
}

export function maybeEmitHlsSeekTraceSummary(
    logger: SegmentLogger,
    trace: HlsSeekTraceState,
): boolean {
    if (trace.emitted) return false;
    const hasEnoughServingInfo =
        !!trace.firstMuxedServed || (!!trace.firstAudioServed && !!trace.firstVideoServed);
    if (!hasEnoughServingInfo) return false;

    trace.emitted = true;
    logger.info('hls-seek-trace', {
        playSessionId: trace.playSessionId,
        generationIndex: trace.generationIndex,
        generationRole: trace.generationRole,
        seekCount: trace.seekCount,
        trigger: trace.trigger,
        triggerStream: trace.triggerStream,
        triggerSegment: trace.triggerSegment,
        requestedStartTimeSeconds: trace.requestedStartTimeSeconds,
        segmentOffset: trace.segmentOffset,
        routeReason: trace.routeReason,
        routeCandidates: trace.routeCandidates,
        firstAudioServed: trace.firstAudioServed,
        firstVideoServed: trace.firstVideoServed,
        firstMuxedServed: trace.firstMuxedServed,
        maxWaitMs: trace.maxWaitMs,
        requestCount: trace.requestCount,
        classifierCounts: trace.classifierCounts,
    });
    return true;
}

export function clearSessionSeekTrace(playSessionId: string): void {
    const prefix = `${playSessionId}:`;
    for (const key of traces.keys()) {
        if (key.startsWith(prefix)) traces.delete(key);
    }
}

export function clearHlsSeekTraceCollectorForTests(): void {
    traces.clear();
}
