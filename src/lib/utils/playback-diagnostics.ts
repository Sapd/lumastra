// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Facts about the request that failed. These describe the observed failure
 * point, not its root cause. */
export type PlaybackFailureStage = 'manifest' | 'init-segment' | 'media-segment' | 'unknown';

export type HttpPlaybackDiagnostic =
    | 'authorization-rejected'
    | 'media-not-found'
    | 'stream-limit'
    | 'request-timeout'
    | 'gateway-timeout'
    | 'gateway-unavailable'
    | 'server-error'
    | 'http-error';

/** Map only observable HTTP response codes. Never infer FFmpeg from a 5xx. */
export function classifyHttpPlaybackDiagnostic(status: number): HttpPlaybackDiagnostic {
    switch (status) {
        case 401:
        case 403:
            return 'authorization-rejected';
        case 404:
            return 'media-not-found';
        case 408:
            return 'request-timeout';
        case 429:
            return 'stream-limit';
        case 502:
        case 503:
            return 'gateway-unavailable';
        case 504:
            return 'gateway-timeout';
        default:
            return status >= 500 ? 'server-error' : 'http-error';
    }
}

/**
 * Translate hls.js details into the stage the browser was requesting. The
 * result intentionally says nothing about why that request failed.
 */
export function classifyHlsFailureStage(
    details: string | undefined,
    fragmentType?: string,
    fragmentSequence?: string | number,
): PlaybackFailureStage {
    if (
        fragmentType === 'initSegment' ||
        fragmentSequence === 'initSegment' ||
        details?.toLowerCase().includes('initsegment')
    ) {
        return 'init-segment';
    }
    const normalized = details?.toLowerCase() ?? '';
    if (normalized.includes('manifest') || normalized.includes('levelload')) return 'manifest';
    if (
        normalized.includes('frag') ||
        normalized.includes('segment') ||
        normalized.includes('bufferstalled')
    ) {
        return 'media-segment';
    }
    return 'unknown';
}

/** Only allow-listed stream-server codes may be presented to a viewer. */
export type StreamDiagnosticCode =
    | 'transcoder-start-failed'
    | 'source-unavailable'
    | 'storage-read-failed'
    | 'session-expired'
    | 'concurrency-limit'
    | 'playback-method-not-allowed'
    | 'upstream-timeout';

const STREAM_DIAGNOSTIC_CODES = new Set<StreamDiagnosticCode>([
    'transcoder-start-failed',
    'source-unavailable',
    'storage-read-failed',
    'session-expired',
    'concurrency-limit',
    'playback-method-not-allowed',
    'upstream-timeout',
]);

/** Reject free-form response text, paths, URLs, and unknown future codes. */
export function parseStreamDiagnosticCode(
    value: string | null | undefined,
): StreamDiagnosticCode | null {
    return value && STREAM_DIAGNOSTIC_CODES.has(value as StreamDiagnosticCode)
        ? (value as StreamDiagnosticCode)
        : null;
}
