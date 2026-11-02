// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { TrickplayManifestResponse } from '$lib/schemas/playback-trickplay.js';
import { apiUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import { config } from '$lib/server/config.js';
import {
    getTrickplayParamsByWidth,
    upsertTrickplayParams,
    deleteNonLocalTrickplayParams,
} from '$lib/server/database/queries/trickplay-params.queries.js';
import {
    getTrickplayManifest,
    getTrickplayRevision,
    getAvailableTrickplayWidths,
    type TrickplayManifest,
} from './trickplay-storage.service.js';
import { resolvePlaybackSelection } from '$lib/server/database/queries/media-file-resolution.queries.js';
import {
    hasCompleteTrickplayFiles,
    fingerprintTrickplaySource,
    type TrickplayFingerprint,
} from './trickplay-reclaim.service.js';
import { buildTimelineHref } from './playback-timeline-hrefs.js';

export async function buildTrickplayManifest(
    sql: postgres.Sql,
    mediaId: string,
    fileId: string,
    width: number,
    mediaFilePath: string | null,
    surface: ApiSurface = 'v1',
): Promise<{
    source: 'local' | 'jellyfin-disk';
    revision: string;
    manifest: TrickplayManifestResponse;
} | null> {
    const local = config.TRICKPLAY_SERVE_LOCAL
        ? await getTrickplayManifest(fileId, width, mediaFilePath)
        : null;
    if (local && local.width === width && local.sheets.length > 0) {
        const revision = await getTrickplayRevision(fileId, width, mediaFilePath);
        if (!revision) return null;
        return {
            source: 'local' as const,
            revision,
            manifest: {
                fileId,
                width,
                height: local.height,
                tileColumns: local.tileWidth,
                tileRows: local.tileHeight,
                intervalMs: local.interval,
                thumbnailCount: local.thumbnailCount,
                sheets: local.sheets.map((sheet) => ({
                    index: sheet.index,
                    startMs: sheet.index * local.tileWidth * local.tileHeight * local.interval,
                    endMs:
                        Math.min(
                            (sheet.index + 1) * local.tileWidth * local.tileHeight,
                            local.thumbnailCount,
                        ) * local.interval,
                    href: buildTimelineHref(
                        apiUrl(surface, `/playback/${mediaId}/trickplay/${width}`),
                        { fileId, index: sheet.index, rev: revision },
                    ),
                })),
            },
        };
    }
    const row = await getTrickplayParamsByWidth(sql, mediaId, width, fileId);
    if (!row || row.source !== 'jellyfin-disk' || row.thumbnail_count <= 0) return null;
    const revision = row.updated_at.toISOString();
    const capacity = row.tile_width * row.tile_height;
    if (capacity <= 0) return null;
    return {
        source: 'jellyfin-disk' as const,
        // Params updated_at is the persisted discovery revision for imported sheets.
        // Sheet ETags additionally include bytes, covering replacements between syncs.
        revision,
        manifest: {
            fileId,
            width,
            height: row.height,
            tileColumns: row.tile_width,
            tileRows: row.tile_height,
            intervalMs: row.interval_ms,
            thumbnailCount: row.thumbnail_count,
            sheets: Array.from(
                { length: Math.ceil(row.thumbnail_count / capacity) },
                (_, index) => ({
                    index,
                    startMs: index * capacity * row.interval_ms,
                    endMs: Math.min((index + 1) * capacity, row.thumbnail_count) * row.interval_ms,
                    href: buildTimelineHref(
                        apiUrl(surface, `/playback/${mediaId}/trickplay/${width}`),
                        { fileId, index, rev: revision },
                    ),
                }),
            ),
        },
    };
}

export function manifestTileParams(manifest: TrickplayManifestResponse): {
    width: number;
    height: number;
    interval_ms: number;
    tile_width: number;
    tile_height: number;
    thumbnail_count: number;
} {
    return {
        width: manifest.width,
        height: manifest.height,
        interval_ms: manifest.intervalMs,
        tile_width: manifest.tileColumns,
        tile_height: manifest.tileRows,
        thumbnail_count: manifest.thumbnailCount,
    };
}

// A small process-local negative cache prevents repeat DB/remote-FS probes for
// completed rows whose artifacts are gone. Successful publication evicts it.
const missingArtifacts = new Map<string, number>();
const NEGATIVE_TTL_MS = 15_000;
const MAX_NEGATIVE_FILES = 1024;

/** Persist only after manifest publication, so discovery cannot precede sprites. */
export async function persistLocalTrickplayParams(
    sql: postgres.Sql,
    mediaId: string,
    fileId: string,
    manifest: TrickplayManifest,
): Promise<void> {
    await upsertTrickplayParams(sql, mediaId, fileId, [
        {
            width: manifest.width,
            height: manifest.height,
            heightMeasured: true,
            intervalMs: manifest.interval,
            tileWidth: manifest.tileWidth,
            tileHeight: manifest.tileHeight,
            thumbnailCount: manifest.thumbnailCount,
            // Same local-provider estimate as getTrickplayInfos().
            bandwidth: 50000,
            source: 'local',
        },
    ]);
    await deleteNonLocalTrickplayParams(sql, mediaId, fileId);
    missingArtifacts.delete(fileId);
}

/** Recover the derived cache for installs whose generator published only files.
 * Probe actual artifact widths (including custom widths), never another cut's
 * provider defaults. The caller still enforces stage freshness after repair. */
export async function repairLocalTrickplayParams(
    sql: postgres.Sql,
    mediaId: string,
    fileId?: string,
): Promise<number[]> {
    if (!config.TRICKPLAY_SERVE_LOCAL) return [];
    if (fileId && (missingArtifacts.get(fileId) ?? 0) > Date.now()) return [];
    const selection = await resolvePlaybackSelection(sql, mediaId, { fileId });
    const file = selection.files.find((f) => f.id === selection.fileId);
    if (!file?.file_path) return [];
    // Reserve the negative TTL before probing artifact directories.
    if (missingArtifacts.size >= MAX_NEGATIVE_FILES)
        missingArtifacts.delete(missingArtifacts.keys().next().value!);
    missingArtifacts.set(file.id, Date.now() + NEGATIVE_TTL_MS);
    const widths = await getAvailableTrickplayWidths(file.id, file.file_path);
    let fingerprint: TrickplayFingerprint | null | undefined;
    const restored: number[] = [];
    for (const width of widths) {
        const manifest = await getTrickplayManifest(file.id, width, file.file_path);
        if (
            !manifest ||
            manifest.width !== width ||
            manifest.thumbnailCount <= 0 ||
            manifest.interval <= 0 ||
            manifest.width <= 0 ||
            manifest.height <= 0 ||
            manifest.tileWidth <= 0 ||
            manifest.tileHeight <= 0 ||
            !manifest.sheets.length ||
            !(await hasCompleteTrickplayFiles(
                { fileId: file.id, filePath: file.file_path },
                manifest,
            ))
        )
            continue;
        if (manifest.reuse) {
            if (fingerprint === undefined) {
                fingerprint = await fingerprintTrickplaySource(file.file_path).catch(() => null);
            }
            if (
                !fingerprint ||
                fingerprint.sampledHash !== manifest.reuse.sampledHash ||
                fingerprint.size !== manifest.reuse.size ||
                fingerprint.mtimeMs !== manifest.reuse.mtimeMs
            )
                continue;
        }
        await persistLocalTrickplayParams(sql, mediaId, file.id, manifest);
        restored.push(width);
    }
    return restored;
}
