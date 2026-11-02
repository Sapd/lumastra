// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { classifyMediaInfraError } from '$lib/server/tasks/infra-retry.js';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import {
    findEpisodeThumbnailWork,
    loadEpisodeThumbnailExclusions,
    hasArtworkSuppressionForType,
} from '$lib/server/database/queries/media-artwork.queries.js';
import { classifyEpisodeThumbnail } from './episode-thumbnail-state.js';
import {
    captureEpisodeThumbnailInput,
    publishEpisodeThumbnail,
} from './episode-thumbnail-publication.service.js';
import { generateEpisodeThumbnail } from './frame-candidate.service.js';
import { safeReaddir } from '$lib/server/utils/safe-fs.js';
import { metadataCentralBaseDir, resolveWritePath } from './metadata-storage.service.js';

export interface EpisodePictureMaintenanceResult {
    transientError?: string;
    extracted: number;
    remapped: number;
    skipped: number;
    errors: number;
    planned: number;
    capped: boolean;
}

/** Scoped escape hatch using the same ownership classifier and publication fence as scheduled work. */
export async function maintainEpisodePictures(
    sql: postgres.Sql,
    scopeId: string,
    signal: AbortSignal,
    mode: 'execute' | 'plan',
    onProgress?: (processed: number, total: number) => void,
): Promise<EpisodePictureMaintenanceResult> {
    const result: EpisodePictureMaintenanceResult = {
        extracted: 0,
        remapped: 0,
        skipped: 0,
        errors: 0,
        planned: 0,
        capped: false,
    };
    const exclusions = await loadEpisodeThumbnailExclusions(sql);
    let cursor: string | null = null;
    let processed = 0;
    // Bounded pages, cancellation between every file, and a hard per-run ceiling.
    while (!signal.aborted && processed < 1000) {
        const rows = await findEpisodeThumbnailWork(
            sql,
            cursor,
            Math.min(50, 1000 - processed),
            exclusions,
            scopeId,
        );
        if (!rows.length) break;
        for (const row of rows) {
            if (signal.aborted) break;
            cursor = row.episodeId;
            processed++;
            try {
                if (await hasArtworkSuppressionForType(sql, row.episodeId, 'thumb')) {
                    result.skipped++;
                    continue;
                }
                const names = new Set(
                    (await safeReaddir(dirname(row.videoPath))).map((entry) => entry.name),
                );
                const classification = classifyEpisodeThumbnail(row, names);
                if (
                    classification.state === 'shared-file' ||
                    classification.state === 'not-actionable'
                ) {
                    result.skipped++;
                    continue;
                }
                const input = await captureEpisodeThumbnailInput(sql, row, signal);
                if (!input) {
                    result.skipped++;
                    continue;
                }
                if (mode === 'plan') {
                    result.planned++;
                    continue;
                }
                if (classification.state === 'unmapped' && classification.resolvedPath) {
                    if (
                        await publishEpisodeThumbnail(
                            sql,
                            row,
                            input,
                            classification.resolvedPath,
                            signal,
                            'sidecar',
                        )
                    )
                        result.remapped++;
                    else result.skipped++;
                    continue;
                }
                const { filePath } = await resolveWritePath({
                    mediaFilePath: row.videoPath,
                    centralDir: join(metadataCentralBaseDir(), '.metadata', row.episodeId),
                    fileName: `${row.episodeId}-${randomUUID()}-thumb.jpg`,
                });
                const generated = await generateEpisodeThumbnail({
                    episodeId: row.episodeId,
                    videoPath: row.videoPath,
                    outputPath: filePath,
                    durationSeconds: input.extractionSpan.duration,
                    baseOffsetSeconds: input.extractionSpan.base,
                    signal,
                });
                if (!generated.success) {
                    result.errors++;
                    if (generated.transientError)
                        result.transientError ??= generated.transientError;
                    continue;
                }
                if (await publishEpisodeThumbnail(sql, row, input, filePath, signal))
                    result.extracted++;
                else result.skipped++;
            } catch (err) {
                result.errors++;
                if (classifyMediaInfraError(err))
                    result.transientError ??= err instanceof Error ? err.message : String(err);
            } finally {
                onProgress?.(processed, processed + rows.length);
            }
        }
        if (rows.length < 50) break;
    }
    result.capped = processed >= 1000;
    return result;
}
