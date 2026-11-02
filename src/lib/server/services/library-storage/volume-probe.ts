// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Free space of the filesystems the libraries live on, measured by the worker
 * (the process that has the media mounts).
 *
 * The cluster heartbeat reports the cache and transcode disks only. Library
 * roots are usually one network share holding several libraries, so paths are
 * grouped by device id and each filesystem is measured once.
 *
 * Every call goes through `safe-fs`, and a path that cannot be read is
 * reported as unmeasured, never as full (the fail-open rule of
 * `artwork-volume-headroom.ts`). Two more ways a reading lies are handled:
 * - A hung NFS mount: a timed-out call still holds a libuv thread and an
 *   fs-guard permit until the kernel gives up, so the probe runs one path at a
 *   time and stops at the first timeout. A dead share costs one permit a day,
 *   not one per library, and the scanner keeps its share of the pool.
 * - An unmounted share: the mountpoint is then an empty local directory, and
 *   stat/statfs succeed on the ROOT disk, a small filesystem that would look
 *   about to fill. A library root with no entries is treated as unmounted.
 */

import { FsTimeoutError, safeReaddir, safeStat, safeStatfs } from '$lib/server/utils/safe-fs.js';
import type { VolumeSnapshotInsert } from '$lib/server/database/queries/library-storage-history.queries.js';

export interface LibraryPathRef {
    id: string;
    path: string;
}

export interface LibraryVolumeMeasurement {
    rows: VolumeSnapshotInsert[];
    /** Paths that could not be measured: failed, timed out, empty, or skipped after a timeout. */
    unreadable: string[];
    /** Distinct filesystems measured. */
    filesystems: number;
}

export async function measureLibraryVolumes(
    paths: LibraryPathRef[],
    timeoutMs?: number,
): Promise<LibraryVolumeMeasurement> {
    const unreadable: string[] = [];
    const byDevice = new Map<string, LibraryPathRef[]>();
    let hung = false;

    for (const p of paths) {
        if (hung) {
            unreadable.push(p.path);
            continue;
        }
        try {
            const st = await safeStat(p.path, timeoutMs);
            const entries = await safeReaddir(p.path, timeoutMs);
            if (entries.length === 0) {
                unreadable.push(p.path);
                continue;
            }
            const dev = String(st.dev);
            const group = byDevice.get(dev);
            if (group) group.push(p);
            else byDevice.set(dev, [p]);
        } catch (err) {
            if (err instanceof FsTimeoutError) hung = true;
            unreadable.push(p.path);
        }
    }

    const rows: VolumeSnapshotInsert[] = [];
    let filesystems = 0;
    for (const [deviceId, refs] of byDevice) {
        if (hung) {
            unreadable.push(...refs.map((r) => r.path));
            continue;
        }
        // Any path on the device answers for the filesystem; try the next one
        // when a path errors (permissions, a stale handle), not after a timeout.
        let fs: Awaited<ReturnType<typeof safeStatfs>> | null = null;
        for (const r of refs) {
            try {
                fs = await safeStatfs(r.path, timeoutMs);
                break;
            } catch (err) {
                if (err instanceof FsTimeoutError) {
                    hung = true;
                    break;
                }
            }
        }
        if (!fs) {
            unreadable.push(...refs.map((r) => r.path));
            continue;
        }
        {
            const blockSize = Number(fs.bsize);
            // bavail, not bfree: the blocks reserved for root are not space the
            // library can fill.
            const freeBytes = Number(fs.bavail) * blockSize;
            const totalBytes = Number(fs.blocks) * blockSize;
            // A zero-sized filesystem (some FUSE/overlay mounts report it)
            // says nothing about headroom; treat it as unmeasured.
            if (!Number.isFinite(freeBytes) || !(totalBytes > 0)) {
                unreadable.push(...refs.map((r) => r.path));
                continue;
            }
            filesystems++;
            for (const r of refs) {
                rows.push({ libraryPathId: r.id, deviceId, freeBytes, totalBytes });
            }
        }
    }

    return { rows, unreadable, filesystems };
}
