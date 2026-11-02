// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Lumastra Update Check — once a day, ask GitHub which Lumastra releases
 * exist, so the admin notice can say when this install is behind and, above
 * all, when it is missing a security fix.
 *
 * Like the plugin update check it NEVER installs anything; its whole output is
 * a stored release list (see `services/lumastra-update/check.ts`) that the
 * attention adapter and the Instance page compare with the running build.
 *
 * Scheduling: the task wakes hourly, but the check itself only contacts GitHub
 * when the stored `nextCheckAt` has passed — 24h ± 2h after the previous
 * check, plus a random 0–5 min delay — so installs spread over the day rather
 * than all calling at the same bucket boundary. A manual run checks at once.
 * The admin switch `UPDATE_CHECK_ENABLED` turns it off: no request is made.
 *
 * Failures (offline box, GitHub down, rate limit, the repo 404ing before its
 * first release) are reported in the run result, never thrown: a remote outage
 * must not mark the run failed or feed the circuit breaker.
 */

import { z } from 'zod';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { config } from '$lib/server/config.js';
import { runUpdateCheck } from '$lib/server/services/lumastra-update/check.js';
import { fetchLumastraReleases } from '$lib/server/services/lumastra-update/github-releases.js';

type LumastraUpdateCheckInput = Record<string, unknown>;

type LumastraUpdateCheckResult = {
    status: string;
    runningVersion: string;
    latestVersion: string | null;
    securityFixedIn: string | null;
    message: string;
};

/** Spread the actual request over a few minutes after the hourly tick. */
const MAX_START_DELAY_MS = 5 * 60 * 1000;

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done(): void {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        }
        signal.addEventListener('abort', done, { once: true });
    });
}

export const lumastraUpdateCheckTask = defineTask<
    LumastraUpdateCheckInput,
    LumastraUpdateCheckResult
>({
    id: 'lumastra-update-check',
    purpose: 'maintenance',
    name: 'Lumastra Update Check',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    // Database for its state; the one outbound request goes through the
    // pinned ssrf-guard transport in github-releases.ts, never ctx.http.
    capabilities: { database: true },

    schedule: {
        // Hourly wake-up; the daily cadence and its jitter live in the state.
        every: '1h',
        runOnStartup: false,
    },

    identityFor: () => 'global',
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema: z.object({}).passthrough(),

    timeout: { hard: '10m', soft: '8m' },

    async execute(ctx) {
        const { logger, signal } = ctx;
        const runningVersion = config.buildInfo.version;
        const base = {
            runningVersion,
            latestVersion: null,
            securityFixedIn: null,
        };

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted',
                result: { ...base, status: 'aborted', message: 'Aborted before start' },
            };
        }
        if (!config.UPDATE_CHECK_ENABLED) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { ...base, status: 'disabled', message: 'Update check is turned off' },
            };
        }
        const sql = getDb();
        if (!sql) {
            return {
                success: true,
                itemsProcessed: 0,
                result: { ...base, status: 'no-database', message: 'No database — nothing to do' },
            };
        }

        const manual = ctx.mode === 'manual';
        const outcome = await runUpdateCheck({
            sql,
            enabled: true,
            build: { version: runningVersion, buildTime: config.buildInfo.buildTime },
            fetchReleases: async (opts) => {
                if (!manual) await abortableDelay(Math.random() * MAX_START_DELAY_MS, signal);
                if (signal.aborted) throw new Error('aborted');
                return fetchLumastraReleases(opts);
            },
            logger,
            force: manual,
            signal,
        });

        const latest = outcome.evaluation?.latest?.version ?? null;
        const security = outcome.evaluation?.securityFixedIn?.version ?? null;
        let message: string;
        switch (outcome.status) {
            case 'aborted':
                message = 'Aborted';
                break;
            case 'not-due':
                message = 'Not due yet';
                break;
            case 'failed':
                message = `Could not reach GitHub: ${outcome.error ?? 'unknown error'}`;
                break;
            case 'rate-limited':
                message = 'GitHub rate limit reached; postponed';
                break;
            case 'no-releases':
                message = 'No Lumastra releases published yet';
                break;
            default:
                if (outcome.evaluation && !outcome.evaluation.comparable) {
                    message = `Running version ${runningVersion} cannot be compared`;
                } else if (latest) {
                    message = security
                        ? `Lumastra ${latest} is available (security fix in ${security})`
                        : `Lumastra ${latest} is available`;
                } else {
                    message = 'Lumastra is up to date';
                }
        }
        if (latest) logger.info('Lumastra update available', { latest, security });

        return {
            success: true,
            itemsProcessed: 0,
            result: {
                status: outcome.status,
                runningVersion,
                latestVersion: latest,
                securityFixedIn: security,
                message,
            },
        };
    },
});

registry.registerTask(lumastraUpdateCheckTask);
