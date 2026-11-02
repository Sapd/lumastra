// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/host-pressure — disk and CONTAINER memory, the two pressure signals
 * `/api/admin/system-metrics` does not carry.
 *
 * GET /api/admin/fix/host-pressure → HostPressure.
 * Auth: admin. Errors: problem+json.
 *
 * ## Why this is a separate endpoint
 *
 * `system-metrics` derives memory from `os.totalmem()`/`os.freemem()`. Inside a
 * container those are the HOST's numbers, so an instance hard-capped at 2 GB
 * and being OOM-throttled reports plenty of free memory on a 64 GB box — the
 * single number that explains "my server is slow" is precisely the one that is
 * missing. Disk is absent from that payload altogether. Rather than widen the
 * shared `SystemMetrics` shape (and move a contract that every existing metrics
 * consumer depends on), the two missing signals are read here.
 *
 * The cgroup reading mirrors `cpu-budget.ts`, which already does this for CPU;
 * memory was simply never done. `null` means "no cap, or unreadable" and is
 * never quietly replaced by the host total — substituting the host number is
 * the exact bug this endpoint exists to correct.
 */

import { memoryWorkingSet, parseMemoryStat } from '$lib/server/services/cluster-node-runtime.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger.js';
import { readFile } from 'node:fs/promises';
import { totalmem } from 'node:os';
import { getAdminDb } from '$lib/server/database/connection.js';
import { safeStatfs, FsTimeoutError } from '$lib/server/utils/safe-fs.js';
import { config } from '$lib/server/config.js';
import { getCpuBudget } from '$lib/server/utils/cpu-budget.js';
import { getRuntimeEnvironment } from '$lib/server/utils/runtime-environment.js';
import {
    getEnabledLibraryPaths,
    type LibraryPathRow,
} from '$lib/server/database/queries/library-paths.queries.js';
import { getConfigFilePath } from '$lib/server/config/config.service.js';
import { dirname } from 'node:path';
import type {
    HostPressure,
    UnmeasuredVolume,
    VolumeUsage,
} from '$lib/components/admin/fix/host-pressure.schema.js';

const logger = Logger.for('AdminFixHostPressure');

/** A dead mount must not wedge the page that reports dead mounts. */
const STATFS_TIMEOUT_MS = 4000;

async function readOrNull(path: string): Promise<string | null> {
    try {
        return await readFile(path, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * Parse a cgroup memory limit file. cgroup v2 writes the literal `max` when
 * uncapped; cgroup v1 writes a sentinel near 2^63 (`PAGE_COUNTER_MAX * PAGE_SIZE`)
 * rather than anything recognisable, so any value at or above the host's RAM is
 * treated as "no meaningful cap" — reporting a 9.2-exabyte limit as a fact would
 * be worse than reporting none.
 */
export function parseCgroupMemoryLimit(contents: string, hostTotalBytes: number): number | null {
    const raw = contents.trim();
    if (raw === '' || raw === 'max') return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) return null;
    if (value >= hostTotalBytes) return null;
    return value;
}

interface MemoryBudget {
    limitBytes: number | null;
    usageBytes: number | null;
    hostTotalBytes: number;
    source: 'cgroup-v2' | 'cgroup-v1' | 'host';
}

async function readMemoryBudget(): Promise<MemoryBudget> {
    const hostTotalBytes = totalmem();

    const v2Max = await readOrNull('/sys/fs/cgroup/memory.max');
    if (v2Max !== null) {
        const limitBytes = parseCgroupMemoryLimit(v2Max, hostTotalBytes);
        const current = await readOrNull('/sys/fs/cgroup/memory.current');
        const usage = current === null ? NaN : Number(current.trim());
        return {
            limitBytes,
            usageBytes: Number.isFinite(usage)
                ? memoryWorkingSet(
                      usage,
                      parseMemoryStat((await readOrNull('/sys/fs/cgroup/memory.stat')) ?? undefined)
                          .memoryInactiveFileBytes,
                  )
                : null,
            hostTotalBytes,
            source: 'cgroup-v2',
        };
    }

    const v1Max = await readOrNull('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    if (v1Max !== null) {
        const limitBytes = parseCgroupMemoryLimit(v1Max, hostTotalBytes);
        const current = await readOrNull('/sys/fs/cgroup/memory/memory.usage_in_bytes');
        const usage = current === null ? NaN : Number(current.trim());
        return {
            limitBytes,
            usageBytes: Number.isFinite(usage)
                ? memoryWorkingSet(
                      usage,
                      parseMemoryStat(
                          (await readOrNull('/sys/fs/cgroup/memory/memory.stat')) ?? undefined,
                          true,
                      ).memoryInactiveFileBytes,
                  )
                : null,
            hostTotalBytes,
            source: 'cgroup-v1',
        };
    }

    return { limitBytes: null, usageBytes: null, hostTotalBytes, source: 'host' };
}

/**
 * Measure the volumes that actually matter when the box slows down: the config
 * volume (where the cache and transcode scratch live) and each library root.
 *
 * Deduplicated by `f_fsid`-equivalent totals is NOT attempted — two bind mounts
 * of the same device would both be listed. That is deliberate: an operator
 * recognises their own paths, and silently collapsing rows would hide a path
 * they were looking for.
 */
async function measureVolumes(
    rows: readonly LibraryPathRow[],
): Promise<{ volumes: VolumeUsage[]; unmeasured: UnmeasuredVolume[] }> {
    const targets: Array<{ path: string; label: string }> = [];

    // The volume settings.json lives on, with the image cache. A full config
    // volume is a top cause of "everything got slow and then stopped".
    targets.push({ path: dirname(getConfigFilePath()), label: 'Config & cache' });
    // Transcode scratch has its own setting and defaults to /tmp, often a small
    // tmpfs or overlay: when it fills, every transcode fails while the config
    // volume reads healthy.
    targets.push({ path: config.FFMPEG_TRANSCODE_DIR, label: 'Transcode scratch' });
    for (const row of rows) {
        targets.push({ path: row.path, label: row.path });
    }

    const seen = new Set<string>();
    const unique = targets.filter((t) => (seen.has(t.path) ? false : (seen.add(t.path), true)));

    const settled = await Promise.allSettled(
        unique.map(async (t): Promise<VolumeUsage> => {
            const st = await safeStatfs(t.path, STATFS_TIMEOUT_MS);
            const totalBytes = Number(st.blocks) * Number(st.bsize);
            // `bavail` (available to unprivileged users), not `bfree` — the
            // reserved blocks root can still use are not space the app has.
            const freeBytes = Number(st.bavail) * Number(st.bsize);
            const usedPercent =
                totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 100) : 0;
            return { path: t.path, label: t.label, totalBytes, freeBytes, usedPercent };
        }),
    );

    // A volume that would not answer is reported, not dropped: a hung or
    // vanished mount is the classic cause of "everything is slow", and leaving
    // it out lists only the healthy volumes as if they were the whole picture.
    const volumes: VolumeUsage[] = [];
    const unmeasured: UnmeasuredVolume[] = [];
    settled.forEach((r, i) => {
        const t = unique[i]!;
        if (r.status === 'fulfilled') volumes.push(r.value);
        else {
            const err = r.reason as { code?: string } | undefined;
            unmeasured.push({
                path: t.path,
                label: t.label,
                reason: err instanceof FsTimeoutError ? 'timeout' : (err?.code ?? 'error'),
            });
        }
    });
    return { volumes, unmeasured };
}

/**
 * Measure this host's disk + memory pressure.
 *
 * Exported for the attention adapter in `disk-pressure-attention.ts`, which is
 * meant to make this speak unprompted. That adapter is NOT registered yet, so
 * today only the `/admin/fix/slow` diagnostic reads it.
 */
export async function readHostPressure(): Promise<HostPressure> {
    const sql = getAdminDb();

    let paths: LibraryPathRow[] = [];
    let pathsLookupFailed = !sql;
    if (sql) {
        try {
            paths = await getEnabledLibraryPaths(sql);
        } catch (err) {
            pathsLookupFailed = true;
            logger.warn('Library paths lookup failed — measuring config volume only', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    const [memory, { volumes, unmeasured }] = await Promise.all([
        readMemoryBudget(),
        measureVolumes(paths),
    ]);
    const cpu = getCpuBudget();

    return {
        generatedAt: new Date().toISOString(),
        memory,
        volumes,
        unmeasured,
        pathsLookupFailed,
        cpu: {
            effectiveCores: Math.round(cpu.effectiveCores * 100) / 100,
            hostCores: cpu.hostCores,
            source: cpu.source,
        },
        containerized: getRuntimeEnvironment().containerized,
    };
}

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    handlers: {
        GET: async (_event, _ctx) => {
            return json(await readHostPressure());
        },
    },
});
