// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Telemetry Cleanup — native defineTask implementation.
 *
 * Removes telemetry data older than the retention period from:
 *   - playback_telemetry (raw events, 30d)
 *   - playback_session_quality (per-session rollup, 90d)
 *   - user_playback_quality (daily rollup, 365d)
 *   - device_playback_quality (daily rollup, 365d)
 *
 * The service performs batched DELETEs and honors the abort signal between batches.
 *
 * Error visibility: a throw from the telemetry service is NOT treated as
 * "telemetry not configured". Real failures propagate so the admin UI
 * surfaces the failure correctly.
 *
 * Configuration:
 * - DISABLE_TELEMETRY_CLEANUP: Set to 'true' to disable this task entirely
 *   (both scheduled and manual triggers). Checked at execute() entry.
 *   Note: schedule.envOverride is for interval override only, not full-disable;
 *   we gate here instead so manual triggers are also blocked.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { config } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';

type TelemetryCleanupInput = Record<string, unknown>;

type TelemetryCleanupResult = {
    deletedCount: number;
    message: string;
};

const inputSchema = z.object({}).passthrough();

export const telemetryCleanupTask = defineTask<TelemetryCleanupInput, TelemetryCleanupResult>({
    id: 'telemetry-cleanup',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'Telemetry Cleanup',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '24h',
        runOnStartup: false,
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema,

    timeout: { hard: '60m', soft: '55m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { logger, signal } = ctx;

        // envOverride is for interval override only; for full-disable semantics
        // (blocks both scheduled and manual triggers) we gate at execute() entry.
        if (config.DISABLE_TELEMETRY_CLEANUP) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    deletedCount: 0,
                    message: 'telemetry-cleanup disabled via DISABLE_TELEMETRY_CLEANUP',
                },
            };
        }

        let telemetryModule: {
            playbackTelemetryService: {
                cleanup: (signal?: AbortSignal) => Promise<number>;
            };
        };
        try {
            telemetryModule =
                (await import('$lib/server/services/playback-telemetry.service.js')) as typeof telemetryModule;
        } catch (err) {
            throw new Error(
                `telemetry-cleanup: failed to load service: ${err instanceof Error ? err.message : String(err)}`,
                { cause: err },
            );
        }

        const deletedCount = await telemetryModule.playbackTelemetryService.cleanup(signal);

        const wasAborted = signal.aborted;

        if (deletedCount > 0) {
            logger.info('Telemetry cleanup completed', {
                deletedCount,
                wasAborted,
            });
        }

        const message =
            deletedCount > 0
                ? wasAborted
                    ? `Aborted after deleting ${deletedCount} telemetry records`
                    : `Deleted ${deletedCount} old telemetry records`
                : 'No old telemetry records to delete';

        return {
            success: true,
            itemsProcessed: deletedCount,
            stopReason: wasAborted ? 'aborted' : undefined,
            result: {
                deletedCount,
                message,
            },
        };
    },
});

registry.registerTask(telemetryCleanupTask);
