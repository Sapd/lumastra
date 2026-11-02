// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Per-volume disk-headroom preflight for the provider-artwork backfill drain.
 *
 * The drain writes ~150KB per artwork across ~3 applicable types per item —
 * roughly 4-5 GB per 10k files, with a transient ~2x peak because
 * `fetchFromUrl` also persists each buffer into the 7-day `customUrlCache`
 * (`image-proxy/service.ts:72`). The target volumes DIFFER: with
 * `METADATA_STORAGE_LOCATION` = 'central' everything lands under
 * `BASE_PATH/.metadata` (typically the small /config volume), while
 * 'alongside' / 'alongside-prefer' land on the media mounts. So the check has
 * to be per volume, not a single global number.
 *
 * Fail-OPEN policy: a volume whose `statfs` throws reports `freeBytes: null`
 * and `belowMargin: false`. Treating an unreadable/unmounted path as "full"
 * would stall the entire drain on a transient NFS flap — the same reasoning
 * `assessFilePresence` (`file-presence.ts:159-161`) applies to file deletion.
 */

import type postgres from 'postgres';
import { safeStatfs } from './safe-fs.js';
import { getEnabledLibraryPaths } from '../database/queries/library-paths.queries.js';
import { metadataCentralBaseDir } from '../services/metadata-storage.service.js';
import { Logger } from './logger.js';

const logger = Logger.for('ArtworkVolumeHeadroom');

/** One statfs per volume per minute across the whole drain. */
const HEADROOM_CACHE_MS = 60_000;

export interface ArtworkVolume {
    /** 'central' for the BASE_PATH volume, 'library' for a media mount. */
    label: string;
    path: string;
}

export interface VolumeHeadroom {
    label: string;
    path: string;
    /** null when statfs failed (unmounted / permission) — treated as unknown. */
    freeBytes: number | null;
    totalBytes: number | null;
    belowMargin: boolean;
}

interface CacheEntry {
    atMs: number;
    minFreeBytes: number;
    volumes: VolumeHeadroom[];
}

let cache: CacheEntry | null = null;

/** Test seam — drops the memo so each test measures fresh. */
export function __resetArtworkHeadroomCacheForTests(): void {
    cache = null;
}

/**
 * Every volume this feature can write to: the central config volume plus each
 * enabled library path. De-duplicated by path, central first.
 *
 * Measures `BASE_PATH` itself rather than `BASE_PATH/.metadata`: the artwork
 * subdirectory (`artworkCentralDir`, `media-image-storage.service.ts:66-69`)
 * does not exist until the first write, and `statfs` on a missing path throws —
 * which the fail-open policy would turn into "headroom unknown" forever.
 * `BASE_PATH` is on the same filesystem and always exists.
 */
export async function collectArtworkTargetVolumes(sql: postgres.Sql): Promise<ArtworkVolume[]> {
    const centralRoot = metadataCentralBaseDir();
    const out: ArtworkVolume[] = [{ label: 'central', path: centralRoot }];
    const seen = new Set<string>([centralRoot]);

    try {
        for (const row of await getEnabledLibraryPaths(sql)) {
            if (!row.path || seen.has(row.path)) continue;
            seen.add(row.path);
            out.push({ label: 'library', path: row.path });
        }
    } catch (err) {
        // A DB blip must not make the guard itself fail the run — the central
        // volume alone is still a meaningful check.
        logger.warn('Failed to enumerate library paths for headroom check', {
            error: err instanceof Error ? err.message : String(err),
        });
    }

    return out;
}

/** `statfs` each volume and classify it against `minFreeBytes`. */
export async function measureVolumeHeadroom(
    volumes: ArtworkVolume[],
    minFreeBytes: number,
): Promise<VolumeHeadroom[]> {
    const out: VolumeHeadroom[] = [];
    for (const vol of volumes) {
        try {
            const stats = await safeStatfs(vol.path);
            const blockSize = Number(stats.bsize);
            const freeBytes = Number(stats.bavail) * blockSize;
            const totalBytes = Number(stats.blocks) * blockSize;
            out.push({
                label: vol.label,
                path: vol.path,
                freeBytes,
                totalBytes,
                belowMargin: freeBytes < minFreeBytes,
            });
        } catch (err) {
            logger.debug('statfs failed; treating volume headroom as unknown (fail-open)', {
                path: vol.path,
                error: err instanceof Error ? err.message : String(err),
            });
            out.push({
                label: vol.label,
                path: vol.path,
                freeBytes: null,
                totalBytes: null,
                belowMargin: false,
            });
        }
    }
    return out;
}

/**
 * Memoized headroom verdict. `ok === false` means at least one target volume
 * has less than `minFreeBytes` available; the caller must NOT start writing.
 *
 * `nowMs` is injectable purely for tests.
 */
export async function checkArtworkDiskHeadroom(
    sql: postgres.Sql,
    minFreeBytes: number,
    nowMs: number = Date.now(),
): Promise<{ ok: boolean; volumes: VolumeHeadroom[] }> {
    if (
        cache &&
        cache.minFreeBytes === minFreeBytes &&
        nowMs - cache.atMs < HEADROOM_CACHE_MS &&
        nowMs >= cache.atMs
    ) {
        return { ok: !cache.volumes.some((v) => v.belowMargin), volumes: cache.volumes };
    }

    const volumes = await measureVolumeHeadroom(
        await collectArtworkTargetVolumes(sql),
        minFreeBytes,
    );
    cache = { atMs: nowMs, minFreeBytes, volumes };
    return { ok: !volumes.some((v) => v.belowMargin), volumes };
}
