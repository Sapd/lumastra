// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import type { StreamDiagnosticCode } from '$lib/utils/playback-diagnostics.js';

/** A deliberately small client-visible contract. Never put an exception, path,
 * source URL, FFmpeg stderr, or free-form upstream message in this header. */
export function getStreamDiagnosticCode(input: {
    branch?: string;
    sessionTerminal?: boolean;
}): StreamDiagnosticCode | null {
    if (input.sessionTerminal || input.branch === 'deleted') return 'session-expired';
    if (input.branch === 'backward_seek_timeout') return 'upstream-timeout';
    return null;
}

/**
 * Maps only structured, server-authored startup failures to public diagnostic
 * codes. A job's current status is intentionally not an input: it can become
 * `error` after playback has started (for example after an OOM), which does
 * not prove that FFmpeg failed to start.
 */
export function getPublicHlsDiagnosticCode(input: {
    statusCode: number;
    errorCode?: string;
}): StreamDiagnosticCode | null {
    if (input.statusCode === 429) return 'concurrency-limit';
    // Temporary admission refusal: the server-wide cap or system-load breaker.
    if (
        input.statusCode === 503 &&
        (input.errorCode === 'transcode_capacity' || input.errorCode === 'transcode_load_shed')
    ) {
        return 'concurrency-limit';
    }
    // A 403 alone means "not authorized"; only the structured policy body
    // makes it the play-method refusal.
    if (input.statusCode === 403 && input.errorCode === 'transcode_not_allowed') {
        return 'playback-method-not-allowed';
    }
    if (input.statusCode === 503 && input.errorCode === 'transcode_start_failed') {
        return 'transcoder-start-failed';
    }
    return null;
}

/** Opaque per-response correlation identifier. The ID is useful only if the
 * server logs it alongside the associated fixed diagnostic code. */
export function createStreamDiagnosticId(): string {
    return `pd_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function buildStreamDiagnosticHeaders(input: {
    branch?: string;
    sessionTerminal?: boolean;
}): Record<string, string> {
    const code = getStreamDiagnosticCode(input);
    if (!code) return {};
    return {
        'X-Lumastra-Diagnostic-Code': code,
        'X-Lumastra-Diagnostic-Id': createStreamDiagnosticId(),
    };
}

/** Use only after server-side code has selected one of the allowlisted codes.
 * This keeps public headers free of exception text and upstream details. */
export function buildExplicitStreamDiagnosticHeaders(
    code: StreamDiagnosticCode | null,
): Record<string, string> {
    if (!code) return {};
    return {
        'X-Lumastra-Diagnostic-Code': code,
        'X-Lumastra-Diagnostic-Id': createStreamDiagnosticId(),
    };
}
