// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// A +server.ts may only export reserved route names, so the upload's limits live
// here where the route and its tests can both read them.

/** Hard ceiling on a single upload. Anything past this is truncated, not refused. */
export const MAX_LOG_BYTES = 256 * 1024;

/** How much of the document reaches the server log. Enough to read a stack trace. */
export const EXCERPT_CHARS = 800;

export interface CappedBody {
    /** UTF-8 decode of at most {@link MAX_LOG_BYTES} bytes. */
    text: string;
    /** True when the client sent more than the cap. */
    truncated: boolean;
    /** Bytes actually retained — real bytes, not UTF-16 code units. */
    bytes: number;
}

/**
 * Read a request body up to a BYTE ceiling, discarding the rest.
 *
 * Two things went wrong with the obvious `await request.text()` version:
 *
 * 1. It buffers the whole upload before anything truncates it, so the ceiling
 *    bounded what got LOGGED, not what got allocated. A client is trusted to
 *    have authenticated, not to have a working log rotator.
 *
 * 2. `MAX_LOG_BYTES` was then compared against `String.length`, which counts
 *    UTF-16 code units. A log full of CJK or emoji is up to three bytes per
 *    unit, so the "256 KB" ceiling let through several times that, and the
 *    reported byte count was wrong in the same direction.
 *
 * The remainder is drained rather than the stream cancelled: this route exists
 * to stop a client's retry storm, and a reset mid-upload is exactly what starts
 * one.
 */
export async function readCappedBody(
    request: Request,
    maxBytes = MAX_LOG_BYTES,
): Promise<CappedBody> {
    const body = request.body;
    if (!body) return { text: '', truncated: false, bytes: 0 };

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let kept = 0;
    let truncated = false;

    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value || value.byteLength === 0) continue;

            const room = maxBytes - kept;
            if (room <= 0) {
                // Past the ceiling: keep reading so the client's request
                // completes, but hold on to nothing.
                truncated = true;
                continue;
            }
            if (value.byteLength > room) {
                chunks.push(value.subarray(0, room));
                kept = maxBytes;
                truncated = true;
                continue;
            }
            chunks.push(value);
            kept += value.byteLength;
        }
    } catch {
        // A torn upload is still an upload. Failing here just buys a retry
        // burst, and the client has nothing useful to do with the error — so
        // keep whatever arrived.
    }

    return {
        // A cut at the ceiling can land mid-codepoint; TextDecoder replaces the
        // partial tail rather than throwing, which is the right trade for a log.
        text: new TextDecoder('utf-8').decode(Buffer.concat(chunks)),
        truncated,
        bytes: kept,
    };
}
