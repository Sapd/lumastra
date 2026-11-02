// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * ffprobe results for the read-only playability probe, keyed on path + size +
 * mtime so a changed file is probed again and an unchanged one is not spawned
 * for on every call. In-process, bounded, and shared by concurrent callers:
 * N parallel probes of one file run ffprobe once.
 *
 * Failures are not cached; the next call retries.
 */

import { stat } from 'node:fs/promises';
import { probeMediaFile } from '$lib/server/utils/ffprobe.js';

type ProbeResult = Awaited<ReturnType<typeof probeMediaFile>>;

const MAX_ENTRIES = 500;
const cache = new Map<string, Promise<ProbeResult>>();

export function clearProbeCache(): void {
    cache.clear();
}

export async function probeMediaFileCached(
    containerPath: string,
    timeoutMs: number,
): Promise<ProbeResult> {
    let key: string;
    try {
        const info = await stat(containerPath);
        key = `${containerPath}\0${info.size}\0${info.mtimeMs}`;
    } catch {
        // Unreadable or not a local file: let the probe report it.
        return probeMediaFile(containerPath, timeoutMs);
    }

    const hit = cache.get(key);
    if (hit) {
        // Refresh recency.
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }

    const pending = probeMediaFile(containerPath, timeoutMs).then(
        (result) => {
            if (!result.success) cache.delete(key);
            return result;
        },
        (error: unknown) => {
            cache.delete(key);
            throw error;
        },
    );
    cache.set(key, pending);
    if (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    return pending;
}
