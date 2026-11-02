// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import {
    createNoFollowReadStream,
    resolveContainedMediaFile,
    writeFileNoFollow,
} from '$lib/server/utils/contained-fs.js';
import {
    safeMkdir,
    safeStat,
    safeLstat,
    safeRename,
    safeUnlink,
    withFsGuard,
} from '$lib/server/utils/safe-fs.js';
import {
    getSpriteSheetPath,
    getTrickplayManifest,
    type TrickplayManifest,
} from './trickplay-storage.service.js';
import { upsertTrickplayParams } from '../database/queries/trickplay-params.queries.js';
import {
    clearTrickplayReclaimSnapshot,
    expireTrickplayReclaimSnapshot,
    getTrickplayReclaimSources,
    lockTrickplayReclaimItem,
} from '../database/queries/file-rematch.queries.js';
import { upsertCompletedRow } from '../database/queries/stage-state.queries.js';
import { providerIdToSource } from './trickplay-provider-source.js';
import { withTx } from '../database/with-tx.js';

interface FileLocator {
    fileId: string;
    filePath: string;
}
export interface TrickplayFingerprint {
    sampledHash: string;
    size: number;
    mtimeMs: number;
}

/** Bounded proof: at most 3 MiB, including size, with no full-file hash/cache.
 * Inode/ctime deliberately do not participate: rename changes ctime, and a move
 * across devices can change the inode while preserving bytes and mtime. */
export async function fingerprintTrickplaySource(filePath: string): Promise<TrickplayFingerprint> {
    const resolved = await resolveContainedMediaFile(filePath, [], { parents: true });
    if (!resolved) throw new Error('Trickplay source is unavailable');
    const before = await safeStat(resolved);
    if (!before.isFile() || before.size <= 0) throw new Error('Empty trickplay source');
    const sampleSize = Math.min(1024 * 1024, before.size);
    const hash = createHash('sha256');
    for (const start of [
        0,
        Math.max(0, Math.floor((before.size - sampleSize) / 2)),
        before.size - sampleSize,
    ]) {
        const stream = await createNoFollowReadStream(resolved, {
            start,
            end: start + sampleSize - 1,
        });
        for await (const chunk of stream) hash.update(chunk as Buffer);
    }
    hash.update(String(before.size));
    const after = await safeStat(resolved);
    if (
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ino !== after.ino ||
        before.dev !== after.dev
    ) {
        throw new Error('Trickplay source changed while sampling');
    }
    return { sampledHash: hash.digest('hex'), size: after.size, mtimeMs: after.mtimeMs };
}

/** Ordinary generator skipping is legacy tolerant. Unknown quality keeps old
 * output; known changed quality regenerates. Reclaim separately requires proof. */
export function matchesTrickplaySettings(
    manifest: TrickplayManifest,
    options: {
        width?: number;
        intervalMs?: number;
        tileWidth?: number;
        tileHeight?: number;
        quality?: number;
    } = {},
): boolean {
    return (
        manifest.version === '1.0' &&
        manifest.format === 'webp' &&
        manifest.width === (options.width ?? config.TRICKPLAY_WIDTH) &&
        manifest.interval === (options.intervalMs ?? config.TRICKPLAY_INTERVAL_MS) &&
        manifest.tileWidth === (options.tileWidth ?? config.TRICKPLAY_TILE_WIDTH) &&
        manifest.tileHeight === (options.tileHeight ?? config.TRICKPLAY_TILE_HEIGHT) &&
        (!manifest.reuse ||
            (manifest.reuse.quality === (options.quality ?? config.TRICKPLAY_QUALITY) &&
                manifest.reuse.spriteQuality === config.TRICKPLAY_QUALITY)) &&
        manifest.thumbnailCount > 0 &&
        manifest.height > 0 &&
        Array.isArray(manifest.sheets) &&
        manifest.sheets.length > 0 &&
        manifest.sheets.every(
            (sheet, i) =>
                sheet.index === i && sheet.filename === `${i}.webp` && sheet.thumbnailCount > 0,
        ) &&
        manifest.sheets.reduce((sum, sheet) => sum + sheet.thumbnailCount, 0) ===
            manifest.thumbnailCount
    );
}

/** Inspect sheet metadata, never load sprite bytes just to check completeness. */
export async function hasCompleteTrickplayFiles(
    locator: FileLocator,
    manifest: TrickplayManifest,
): Promise<boolean> {
    try {
        for (const sheet of manifest.sheets) {
            const info = await safeStat(
                await getSpriteSheetPath(
                    locator.fileId,
                    manifest.width,
                    sheet.index,
                    locator.filePath,
                ),
            );
            if (!info.isFile() || info.size <= 0) return false;
        }
        return true;
    } catch {
        return false;
    }
}

function centralStorage(): boolean {
    const strategy =
        config.TRICKPLAY_STORAGE_LOCATION === 'inherit'
            ? config.METADATA_STORAGE_LOCATION
            : config.TRICKPLAY_STORAGE_LOCATION;
    return strategy === 'central';
}

/** Central only. Never inspect, move or clean up sidecars/imported trickplay.
 * Exclusive destination creation prevents stealing another item's files. The
 * source remains intact, including for duplicate content linked elsewhere. */
export async function reuseTrickplayFiles(
    old: FileLocator,
    current: FileLocator,
): Promise<TrickplayManifest | null> {
    if (
        !centralStorage() ||
        ![old.fileId, current.fileId].every((id) => /^[0-9a-f-]{36}$/i.test(id))
    )
        return null;
    const created: string[] = [];
    try {
        const width = config.TRICKPLAY_WIDTH;
        const manifest = await getTrickplayManifest(old.fileId, width);
        if (
            manifest?.reuse?.providerId !== 'local-trickplay' ||
            !matchesTrickplaySettings(manifest)
        )
            return null;
        const proof = manifest.reuse;
        const info = await safeStat(current.filePath);
        if (info.size !== proof.size || info.mtimeMs !== proof.mtimeMs) return null;
        const fingerprint = await fingerprintTrickplaySource(current.filePath);
        if (
            fingerprint.sampledHash !== proof.sampledHash ||
            fingerprint.size !== proof.size ||
            fingerprint.mtimeMs !== proof.mtimeMs
        )
            return null;
        const sourcePaths: string[] = [];
        for (const sheet of manifest.sheets) {
            const path = await getSpriteSheetPath(old.fileId, width, sheet.index);
            const resolved = await resolveContainedMediaFile(path, [], { parents: true });
            if (!resolved || !(await safeStat(resolved)).size) return null;
            sourcePaths.push(resolved);
        }
        if (old.fileId === current.fileId) return manifest;
        const dest = join(config.TRICKPLAY_STORAGE_PATH, current.fileId, String(width));
        await safeMkdir(dest, { recursive: true });
        // Refuse symlinks in existing destination ancestry too.
        for (const path of [
            config.TRICKPLAY_STORAGE_PATH,
            join(config.TRICKPLAY_STORAGE_PATH, current.fileId),
            dest,
        ]) {
            if (!(await safeLstat(path)).isDirectory()) return null;
        }
        for (const [index, source] of sourcePaths.entries()) {
            const target = join(dest, `${index}.webp`);
            try {
                await withFsGuard(() => link(source, target), 'linkTrickplay', target);
            } catch (error) {
                if ((error as { code?: string }).code === 'EEXIST') throw error;
                await withFsGuard(
                    () => copyFile(source, target, constants.COPYFILE_EXCL),
                    'copyTrickplay',
                    target,
                );
            }
            created.push(target);
            const sheet = await safeLstat(target);
            if (!sheet.isFile() || sheet.size <= 0) throw new Error('Incomplete trickplay copy');
        }
        const after = await safeStat(current.filePath);
        if (after.size !== proof.size || after.mtimeMs !== proof.mtimeMs)
            throw new Error('Source changed during reuse');
        // Reserve only our own tmp file; never overwrite another publication.
        const tmp = join(dest, `manifest.json.${process.pid}.${randomUUID()}.tmp`);
        await withFsGuard(
            () => writeFile(tmp, '', { flag: 'wx' }),
            'reserveTrickplayManifest',
            tmp,
        );
        created.push(tmp);
        // A manifest can be in a different legacy directory than a sheet. Write
        // the validated object rather than trusting its raw source pathname.
        const reused = {
            ...manifest,
            storageGeneration: undefined,
            previousStorageGeneration: undefined,
        };
        await writeFileNoFollow(tmp, JSON.stringify(reused));
        try {
            await safeLstat(join(dest, 'manifest.json'));
            throw new Error('Destination already published');
        } catch (error) {
            if ((error as { code?: string }).code !== 'ENOENT') throw error;
        }
        await safeRename(tmp, join(dest, 'manifest.json'));
        created.splice(created.indexOf(tmp), 1);
        return reused;
    } catch {
        for (const path of created.reverse()) await safeUnlink(path).catch(() => undefined);
        return null;
    }
}

/** Called ONLY by the bounded trickplay worker, before decoding. All filesystem
 * work precedes the short publication transaction. Revalidate DB identity under
 * the item lock so a concurrent detach/invalidation cannot publish stale params. */
export async function restoreReclaimedTrickplay(
    sql: postgres.Sql,
    mediaItemId: string,
    processingVersion: number,
): Promise<boolean> {
    if (!config.TRICKPLAY_ENABLED) {
        await clearTrickplayReclaimSnapshot(sql, mediaItemId);
        return false;
    }
    await expireTrickplayReclaimSnapshot(sql, mediaItemId);
    const rows = await getTrickplayReclaimSources(sql, mediaItemId, processingVersion);
    if (!rows.length) return false;
    const snapshot = rows[0].snapshot;
    if (!snapshot) return false;
    let restored = false;
    try {
        const outputs: { fileId: string; manifest: TrickplayManifest; bandwidth: number }[] = [];
        for (const row of rows) {
            if (
                !row.snapshot ||
                row.snapshot.mediaType !== row.media_type ||
                row.snapshot.headHash !== row.file_hash_head ||
                row.snapshot.processingVersion !== processingVersion
            )
                return false;
            const manifest = await reuseTrickplayFiles(row.snapshot, {
                fileId: row.file_id,
                filePath: row.file_path,
            });
            if (!manifest) return false;
            // Same calculation for every output, based on actual bytes and covered duration.
            let bytes = 0;
            for (const sheet of manifest.sheets)
                bytes += (
                    await safeStat(
                        await getSpriteSheetPath(row.file_id, manifest.width, sheet.index),
                    )
                ).size;
            outputs.push({
                fileId: row.file_id,
                manifest,
                bandwidth: Math.ceil(
                    (bytes * 8) / ((manifest.thumbnailCount * manifest.interval) / 1000),
                ),
            });
        }
        if (
            !config.TRICKPLAY_ENABLED ||
            outputs.some(({ manifest }) => !matchesTrickplaySettings(manifest))
        )
            return false;
        restored = await withTrickplayPublication(sql, mediaItemId, async (tx) => {
            const current = await getTrickplayReclaimSources(tx, mediaItemId, processingVersion);
            if (JSON.stringify(current) !== JSON.stringify(rows)) return false;
            for (const { fileId, manifest, bandwidth } of outputs) {
                await upsertTrickplayParams(tx, mediaItemId, fileId, [
                    {
                        width: manifest.width,
                        height: manifest.height,
                        heightMeasured: true,
                        intervalMs: manifest.interval,
                        tileWidth: manifest.tileWidth,
                        tileHeight: manifest.tileHeight,
                        thumbnailCount: manifest.thumbnailCount,
                        bandwidth,
                        source: providerIdToSource(manifest.reuse!.providerId),
                    },
                ]);
            }
            await upsertCompletedRow(tx, {
                mediaItemId,
                stageId: 'trickplay-generation',
                processingVersion,
            });
            await clearTrickplayReclaimSnapshot(tx, mediaItemId, snapshot);
            return true;
        });
        return restored;
    } finally {
        // A rejected/failed attempt must not retry an obsolete locator forever.
        // The success path has already removed it in the completion transaction.
        if (!restored) await clearTrickplayReclaimSnapshot(sql, mediaItemId, snapshot);
    }
}

/** Retry only the idempotent DB publication, never hashing/linking/copying.
 * A deadlock rolls back the whole transaction before reacquiring locks. */
async function withTrickplayPublication<T>(
    sql: postgres.Sql,
    mediaItemId: string,
    publish: (tx: postgres.Sql) => Promise<T>,
): Promise<T> {
    for (let attempt = 1; ; attempt++) {
        try {
            return await withTx(sql, async (tx) => {
                await lockTrickplayReclaimItem(tx, mediaItemId);
                return publish(tx);
            });
        } catch (error) {
            if ((error as { code?: string } | null)?.code !== '40P01' || attempt >= 3) throw error;
            await delay(attempt * 10 + Math.floor(Math.random() * 20));
        }
    }
}

/** Completion and snapshot retirement are one durable database change. */
export async function completeTrickplayGeneration(
    sql: postgres.Sql,
    mediaItemId: string,
    processingVersion: number,
): Promise<void> {
    await withTrickplayPublication(sql, mediaItemId, async (tx) => {
        await upsertCompletedRow(tx, {
            mediaItemId,
            stageId: 'trickplay-generation',
            processingVersion,
        });
        await clearTrickplayReclaimSnapshot(tx, mediaItemId);
    }).catch(async (error: unknown) => {
        await clearTrickplayReclaimSnapshot(sql, mediaItemId);
        throw error;
    });
}
