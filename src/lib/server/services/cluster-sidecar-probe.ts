// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Sidecar entries for Admin → System health → Cluster.
 *
 * The sonic embedder (workers/sonic-embedder) has no Valkey connection, so it
 * cannot write a `cluster:node:` heartbeat. The cluster endpoint instead reads its
 * GET /health, which carries a `node` block in the same shape as the heartbeat's
 * host/process fields (workers/sonic-embedder/host_metrics.py). The result rides in
 * the cluster endpoint's shared 15 s cache, so admin tabs cost one probe per TTL.
 *
 * States: `notConfigured` (SONIC_EMBEDDER_URL empty), `healthy` (200, model
 * loaded), `degraded` (503 while the model loads, or any other non-2xx), `down`
 * (no answer within the timeout). The URL is never returned.
 */

import type { ClusterSidecar } from '$lib/schemas/api-admin-responses.js';
import { config } from '$lib/server/config.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import {
    parseHostInfo,
    parseImplementation,
    parseProcessInfo,
} from '../../../shared/host-metrics.js';

const PROBE_TIMEOUT_MS = 2_000;
/** /health is a few hundred bytes; anything far larger is not our sidecar. */
const MAX_BODY_CHARS = 64 * 1024;

function record(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value !== '' && value.length <= 256 ? value : undefined;
}

/** Turns a /health body (200: the object; 503: FastAPI's `{detail: {...}}`) into sidecar fields. */
export function sidecarFromHealthBody(
    httpStatus: number,
    body: unknown,
    now: number = Date.now(),
): ClusterSidecar {
    const top = record(body);
    const inner = record(top?.detail) ?? top;
    const node = record(inner?.node);
    const memory = record(inner?.memory);
    const startedAt = str(node?.startedAt);
    const startedAtMs = startedAt ? Date.parse(startedAt) : NaN;
    const limitMb = memory?.limit_mb;
    const ready = httpStatus >= 200 && httpStatus < 300 && inner?.status === 'ready';
    const sidecar: ClusterSidecar = {
        kind: 'sonic',
        state: ready ? 'healthy' : 'degraded',
        checkedAt: new Date(now).toISOString(),
        status: inner?.status === 'loading' ? 'loading' : ready ? 'ready' : undefined,
        httpStatus,
        implementation: parseImplementation(node?.implementation) ?? 'python',
        version: str(node?.version),
        hostname: str(node?.hostname),
        startedAt,
        uptimeSeconds: Number.isFinite(startedAtMs)
            ? Math.max(0, Math.floor((now - startedAtMs) / 1000))
            : undefined,
        host: parseHostInfo(node?.host),
        process: parseProcessInfo(node?.process),
        memoryLimitBytes:
            typeof limitMb === 'number' && Number.isFinite(limitMb) && limitMb > 0
                ? limitMb * 1024 * 1024
                : undefined,
    };
    for (const key of Object.keys(sidecar) as (keyof ClusterSidecar)[]) {
        if (sidecar[key] === undefined) delete sidecar[key];
    }
    return sidecar;
}

export async function probeSonicSidecar(
    url: string = config.SONIC_EMBEDDER_URL,
    fetchImpl: typeof fetchWithTimeout = fetchWithTimeout,
): Promise<ClusterSidecar> {
    const checkedAt = new Date().toISOString();
    if (!url) return { kind: 'sonic', state: 'notConfigured', checkedAt };
    try {
        // Admin-configured host (same class as SONIC_EMBEDDER_URL's other callers),
        // so no SSRF guard. One deadline covers headers AND body: fetchWithTimeout's
        // own timer stops at the headers, and a sidecar that stalls mid-body must not
        // hold up the cluster board's single-flight recompute.
        const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
        const response = await fetchImpl(
            `${url.replace(/\/+$/, '')}/health`,
            { method: 'GET', signal },
            PROBE_TIMEOUT_MS,
        );
        const text = await readCapped(response, MAX_BODY_CHARS);
        let body: unknown;
        try {
            body = JSON.parse(text);
        } catch {
            body = undefined;
        }
        return sidecarFromHealthBody(response.status, body);
    } catch {
        return { kind: 'sonic', state: 'down', checkedAt };
    }
}

/** Reads at most `max` bytes of the body, then cancels the stream (a wrong URL may serve megabytes). */
async function readCapped(response: Response, max: number): Promise<string> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (size < max) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        size += value.byteLength;
    }
    if (size >= max) await reader.cancel().catch(() => undefined);
    return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, max));
}

/** All sidecars the cluster view lists (only sonic today). Never throws. */
export async function probeClusterSidecars(): Promise<ClusterSidecar[]> {
    return [await probeSonicSidecar()];
}
