// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * provider-artwork-report — the operator dry run for the artwork backfill.
 *
 * Answers, before a multi-hour multi-GB filesystem mutation starts: how many
 * items remain per stage, roughly how many bytes that is, whether the bytes
 * land alongside the media or in the central config volume, and how much room
 * each of those volumes actually has.
 *
 * READ-ONLY BY CONSTRUCTION. It declares NO `coversStages`, so
 * `runner.ts:1974-1977` leaves `singleStage` undefined and the pipeline-coverage
 * wrapper never engages — running the report cannot move a single stage row.
 * (The five drain tasks also accept `dryRun` for a SINGLE item; that path is a
 * diagnostic, not the library-wide report, precisely because the wrapper flips
 * its row to `running` before execute() is reached.)
 *
 * The byte figures are ESTIMATES from measured CDN averages at the pinned size
 * tokens (poster w342, backdrop w780, logo w300, thumb w300) — not a HEAD
 * request per item, which would cost one round trip per file to answer a
 * planning question.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config } from '../../../config.js';
import { countProviderArtworkBacklog } from '../../../database/queries/provider-artwork.queries.js';
import {
    collectArtworkTargetVolumes,
    measureVolumeHeadroom,
    type VolumeHeadroom,
} from '../../../utils/artwork-volume-headroom.js';
import { peekArtworkBudget } from '../../../utils/artwork-rate-budget.js';
import { PROVIDER_ARTWORK_STAGE_IDS } from './provider-artwork-stages.js';

const BYTES_PER_GB = 1024 * 1024 * 1024;

/**
 * Average encoded size at the size token each stage fetches. Keyed by STAGE id
 * (not artwork type) because the season-poster stage fetches a poster.
 */
export const PROVIDER_ARTWORK_AVG_BYTES: Readonly<Record<string, number>> = {
    'provider-artwork-poster': 60_000,
    'provider-artwork-season-poster': 60_000,
    'provider-artwork-backdrop': 160_000,
    'provider-artwork-logo': 25_000,
    'provider-artwork-thumb': 35_000,
};

/** Fallback for a stage id with no measured average (should not happen). */
const DEFAULT_AVG_BYTES = 150_000;

export interface ProviderArtworkStageReport {
    stageId: string;
    pending: number;
    withOwnFile: number;
    estimatedBytes: number;
}

export interface ProviderArtworkReport {
    enabled: boolean;
    storageStrategy: string;
    perStage: ProviderArtworkStageReport[];
    totalItems: number;
    totalEstimatedBytes: number;
    /** ~2x: fetchFromUrl also persists each buffer into the 7-day customUrlCache. */
    transientPeakBytes: number;
    estimatedAlongsideItems: number;
    estimatedCentralItems: number;
    volumes: VolumeHeadroom[];
    headroomOk: boolean;
    minFreeGb: number;
    hourlyCap: number;
    hourlyBudgetUsed: number;
}

const inputSchema = z.object({}).passthrough();

export const providerArtworkReportTask = defineTask<
    z.infer<typeof inputSchema>,
    ProviderArtworkReport
>({
    id: 'provider-artwork-report',
    purpose: 'library',
    name: 'Provider Artwork: Dry Run Report',
    description:
        'Read-only preview of the artwork backfill: how many items remain, how much disk it needs, and how much free space each target volume has.',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',
    capabilities: { database: true },

    // Operator-triggered only — this is the pre-flight dry run an admin runs by
    // hand before starting the backfill; there is nothing to poll for on a timer.
    // It also declares no `coversStages` (see the header), so without this the
    // boot trigger-coverage audit classifies it `unknown` and reports it as an
    // orphan: `auditTriggerCoverage()` THROWS in dev/test (orchestrator never
    // boots) and error-logs `TASK_TRIGGER_INCONSISTENCY` in prod.
    manualOnly: true,

    identityFor: () => 'provider-artwork-report',
    scope: 'global',
    resourceClass: 'maintenance',
    quotas: { maxConcurrent: 1 },
    inputSchema,
    timeout: { hard: '5m', soft: '4m' },

    async execute(ctx) {
        const counts = await countProviderArtworkBacklog(ctx.sql, PROVIDER_ARTWORK_STAGE_IDS);

        const perStage: ProviderArtworkStageReport[] = counts.map((c) => ({
            stageId: c.stageId,
            pending: c.pending,
            withOwnFile: c.withOwnFile,
            estimatedBytes:
                c.pending * (PROVIDER_ARTWORK_AVG_BYTES[c.stageId] ?? DEFAULT_AVG_BYTES),
        }));

        const totalItems = perStage.reduce((sum, s) => sum + s.pending, 0);
        const totalEstimatedBytes = perStage.reduce((sum, s) => sum + s.estimatedBytes, 0);
        const withOwnFile = perStage.reduce((sum, s) => sum + s.withOwnFile, 0);

        // Under 'central' nothing goes alongside. Under either alongside mode
        // an item that owns a file writes next to it; an item that does not
        // (series/season containers) resolves via findDescendantDirAnchors or
        // falls back to central — counted as central here, which is the
        // conservative direction for the small /config volume.
        const strategy = config.METADATA_STORAGE_LOCATION;
        const estimatedAlongsideItems = strategy === 'central' ? 0 : withOwnFile;
        const estimatedCentralItems = totalItems - estimatedAlongsideItems;

        const minFreeGb = Math.max(0, config.PROVIDER_ARTWORK_MIN_FREE_GB);
        const volumes = await measureVolumeHeadroom(
            await collectArtworkTargetVolumes(ctx.sql),
            minFreeGb * BYTES_PER_GB,
        );

        const report: ProviderArtworkReport = {
            enabled: config.PROVIDER_ARTWORK_BACKFILL_ENABLED,
            storageStrategy: strategy,
            perStage,
            totalItems,
            totalEstimatedBytes,
            transientPeakBytes: totalEstimatedBytes * 2,
            estimatedAlongsideItems,
            estimatedCentralItems,
            volumes,
            headroomOk: !volumes.some((v) => v.belowMargin),
            minFreeGb,
            hourlyCap: config.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR,
            hourlyBudgetUsed: await peekArtworkBudget(),
        };

        ctx.logger.info('provider-artwork dry run', {
            totalItems: report.totalItems,
            totalEstimatedBytes: report.totalEstimatedBytes,
            headroomOk: report.headroomOk,
        });

        return { success: true, itemsProcessed: report.totalItems, result: report };
    },
});

registry.registerTask(providerArtworkReportTask);
