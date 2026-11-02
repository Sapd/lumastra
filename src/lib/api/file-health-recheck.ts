// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
import { apiGet, apiPost } from './client.js';
import { RunSchema } from '$lib/schemas/run.schema.js';
import {
    FileHealthRecheckAcceptedSchema,
    FileHealthRecheckResultSchema,
    type FileHealthRecheckResult,
} from '$lib/schemas/file-health-recheck.js';
import type { ApiResult } from './types.js';
import * as m from '$lib/paraglide/messages.js';

/** Each HTTP request is short; slow probes run in the cancellable task queue. */
export async function awaitFileHealthRecheck(
    fileId: string,
    runId: string,
    signal: AbortSignal,
): Promise<ApiResult<FileHealthRecheckResult>> {
    let failures = 0;
    while (!signal.aborted) {
        const response = await apiGet(`/api/runs/${encodeURIComponent(runId)}`, RunSchema, {
            signal,
        });
        if (signal.aborted) break;
        if (response.error || !response.data) {
            if ([0, 408, 429, 502, 503, 504].includes(response.status)) {
                if (++failures <= 3) {
                    await pollDelay(1000 * 2 ** (failures - 1), signal);
                    continue;
                }
                break;
            }
            if (response.status === 404) break;
            return { ...response, data: null };
        }
        failures = 0;
        const run = response.data;
        // Fence result/cancel UI against ever attaching to an unrelated run.
        const input = z.object({ fileId: z.literal(fileId) }).safeParse(run.input);
        if (run.id !== runId || run.taskId !== 'media-probe' || !input.success) {
            return { data: null, error: m.admin_health_recheck_error(), status: 409 };
        }
        if (run.state === 'completed') {
            const parsed = z
                .object({ recheck: FileHealthRecheckResultSchema })
                .safeParse(run.result);
            if (!parsed.success || parsed.data.recheck.fileId !== fileId) {
                return { data: null, error: m.admin_health_recheck_error(), status: 500 };
            }
            return { data: parsed.data.recheck, error: null, status: 200 };
        }
        if (run.state === 'failed' || run.state === 'cancelled') {
            return {
                data: {
                    fileId,
                    outcome: run.state === 'cancelled' ? 'cancelled' : 'error',
                    issues: [],
                },
                error: null,
                status: 200,
            };
        }
        await pollDelay(1000, signal);
    }
    return { data: null, error: m.admin_health_recheck_tracking_stopped(), status: 0 };
}

export async function recheckFileHealth(
    fileId: string,
    signal: AbortSignal,
    onAccepted?: (runId: string) => void,
): Promise<ApiResult<FileHealthRecheckResult>> {
    const accepted = await apiPost(
        '/api/admin/media/file-health',
        FileHealthRecheckAcceptedSchema,
        { fileId },
        { signal },
    );
    if (accepted.error || !accepted.data) return { ...accepted, data: null };
    onAccepted?.(accepted.data.runId);
    return awaitFileHealthRecheck(fileId, accepted.data.runId, signal);
}

function pollDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.resolve();
    return new Promise((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}
