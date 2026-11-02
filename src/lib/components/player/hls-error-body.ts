// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Live TV failure a 410 response carried, read synchronously from an hls.js
 * `ErrorData` (`response.data` of the loader, else the XHR in `networkDetails`).
 * `null` when the body is not there yet or is not a typed problem; the caller then asks
 * the session state instead. Never throws.
 */
import { parseLiveTvFailureProblem } from '$lib/api/livetv-failure-problem.js';
import type { LiveTvFailureInfo } from '$lib/api/livetv-failure-problem.js';

function toText(value: unknown): string | null {
    if (typeof value === 'string') return value;
    if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
    return null;
}

function bodyFromErrorData(data: unknown): unknown {
    if (typeof data !== 'object' || data === null) return null;
    const { response, networkDetails } = data as {
        response?: { data?: unknown; text?: unknown };
        networkDetails?: unknown;
    };
    let candidate: unknown = response?.data;
    if (candidate === undefined || candidate === null) {
        if (typeof XMLHttpRequest !== 'undefined' && networkDetails instanceof XMLHttpRequest) {
            try {
                candidate =
                    networkDetails.responseType === '' || networkDetails.responseType === 'text'
                        ? networkDetails.responseText
                        : networkDetails.response;
            } catch {
                candidate = null;
            }
        }
    }
    const text = toText(candidate);
    if (text === null) return typeof candidate === 'object' ? candidate : null;
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

export function liveTvFailureFromHlsError(data: unknown): LiveTvFailureInfo | null {
    try {
        return parseLiveTvFailureProblem(bodyFromErrorData(data));
    } catch {
        return null;
    }
}

/** Spread into a PlaybackError: `{ liveTvFailure }` when the 410 body names one, else `{}`. */
export function liveTvFailureField(data: unknown): { liveTvFailure?: LiveTvFailureInfo } {
    const liveTvFailure = liveTvFailureFromHlsError(data);
    return liveTvFailure ? { liveTvFailure } : {};
}
