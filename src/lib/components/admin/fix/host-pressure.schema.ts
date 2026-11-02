// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for the two pressure signals `/api/admin/system-metrics` does
 * not carry: DISK, and the CONTAINER's memory limit.
 *
 * `system-metrics` reports `os.totalmem()`/`os.freemem()`, which inside Docker
 * are the HOST's numbers — so a container hard-capped at 2 GB and thrashing
 * against that cap reports comfortable free memory on a 64 GB box, and the one
 * number that explains the slowness is the one that is missing. Disk is absent
 * from that payload entirely. Both are read here rather than by widening the
 * shared `SystemMetrics` shape, so no existing consumer's contract moves.
 *
 * Shared by the endpoint def and the page for the same reason as
 * `library-scan-check.schema.ts` — one definition, no drift.
 */

import { z } from 'zod';

export const VolumeUsageSchema = z.object({
    /** The directory that was measured (a library root, or the config volume). */
    path: z.string(),
    label: z.string(),
    totalBytes: z.number(),
    freeBytes: z.number(),
    usedPercent: z.number(),
});

/** A volume whose statfs failed or timed out — reported, never silently dropped. */
export const UnmeasuredVolumeSchema = z.object({
    path: z.string(),
    label: z.string(),
    /** `timeout`, an errno code such as `ENOENT` / `EACCES`, or `error`. */
    reason: z.string(),
});

export const MemoryBudgetSchema = z.object({
    /**
     * Bytes this process is actually allowed, from the cgroup. Null when
     * uncapped or unreadable — never silently substituted with the host total,
     * which is the mistake this whole module exists to correct.
     */
    limitBytes: z.number().nullable(),
    /** Current cgroup usage, when readable. */
    usageBytes: z.number().nullable(),
    /** Host RAM, for contrast — this is what `system-metrics` reports. */
    hostTotalBytes: z.number(),
    source: z.enum(['cgroup-v2', 'cgroup-v1', 'host']),
});

export const HostPressureSchema = z.object({
    generatedAt: z.string(),
    memory: MemoryBudgetSchema,
    /** Empty when no volume could be measured; never a fabricated entry. */
    volumes: z.array(VolumeUsageSchema),
    /** Volumes that would not answer. A hung mount belongs here, not off the list. */
    unmeasured: z.array(UnmeasuredVolumeSchema),
    /** The library-path lookup failed, so only the config and scratch volumes were tried. */
    pathsLookupFailed: z.boolean(),
    /** Effective CPU cores after any cgroup quota, vs what the host advertises. */
    cpu: z.object({
        effectiveCores: z.number(),
        hostCores: z.number(),
        source: z.enum(['cgroup-v2', 'cgroup-v1', 'host']),
    }),
    containerized: z.boolean(),
});

export type HostPressure = z.infer<typeof HostPressureSchema>;
export type VolumeUsage = z.infer<typeof VolumeUsageSchema>;
export type UnmeasuredVolume = z.infer<typeof UnmeasuredVolumeSchema>;
