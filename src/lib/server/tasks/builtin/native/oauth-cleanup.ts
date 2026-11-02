// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * OAuth & Session Cleanup — native defineTask implementation.
 *
 * Cleans up expired OAuth-related tokens and sessions:
 * - Expired device codes (only when device auth is enabled)
 * - Revoked refresh tokens (only when device auth is enabled)
 * - Expired Personal Access Tokens (always — independent of device-auth flow)
 * - Expired Service Tokens (always — independent of device-auth flow)
 * - Orphaned Jellyfin device tokens (only when Jellyfin is enabled)
 * - Inactive streaming sessions
 *
 * Error isolation: each service's cleanup call runs in its own try/catch
 * so one broken dependency doesn't block the rest. Per-service errors are
 * collected into `errors: string[]` on the result; `success` is true if and
 * only if all services succeeded. Individual failures log at `warn` level.
 *
 * Configuration:
 * - DISABLE_OAUTH_CLEANUP: Set to 'true' to disable this task entirely
 *   (both scheduled and manual triggers). Checked at execute() entry.
 *   Note: schedule.envOverride is for interval override only, not full-disable;
 *   we gate here instead so manual triggers are also blocked.
 */

import { z } from 'zod';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import { operationMode } from '$lib/server/operation-mode.js';

type OAuthModule = {
    isDeviceAuthEnabled: () => boolean;
    getDeviceCodeService: () => { cleanupExpired: () => Promise<number> };
    getRefreshTokenService: () => { cleanup: () => Promise<number> };
    getPatService: () => { cleanup: () => Promise<number> };
    getServiceTokenService: () => { cleanup: () => Promise<number> };
    getJellyfinTokenService: () => { cleanup: () => Promise<number> };
};

type StreamingModule = {
    getStreamingSessionService: () => {
        cleanup: () => Promise<{
            inactiveEnded: number;
            expiredEnded: number;
            orphanedParentsEnded: number;
            oldDeleted: number;
        }>;
    };
};

type OAuthCleanupInput = Record<string, unknown>;

type OAuthCleanupResult = {
    deviceCodesDeleted: number;
    refreshTokensDeleted: number;
    patsDeleted: number;
    serviceTokensDeleted: number;
    jellyfinTokensDeleted: number;
    streamingSessionsEnded: number;
    streamingSessionsOrphanedEnded: number;
    streamingSessionsDeleted: number;
    errors: string[];
    message: string;
};

const ALL_ZEROS: Omit<OAuthCleanupResult, 'message'> = {
    deviceCodesDeleted: 0,
    refreshTokensDeleted: 0,
    patsDeleted: 0,
    serviceTokensDeleted: 0,
    jellyfinTokensDeleted: 0,
    streamingSessionsEnded: 0,
    streamingSessionsOrphanedEnded: 0,
    streamingSessionsDeleted: 0,
    errors: [],
};

/**
 * Run a single-number cleanup call in isolation. Errors are logged at `warn`
 * and appended to the shared errors array; caller gets 0 on failure.
 */
async function runCount(
    name: string,
    fn: () => Promise<number>,
    logger: TaskContext['logger'],
    errors: string[],
): Promise<number> {
    try {
        return await fn();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`OAuth cleanup: ${name} failed`, { reason: message });
        errors.push(`${name}: ${message}`);
        return 0;
    }
}

const inputSchema = z.object({}).passthrough();

export const oauthCleanupTask = defineTask<OAuthCleanupInput, OAuthCleanupResult>({
    id: 'oauth-cleanup',
    // Internal machinery: hidden from the admin task list unless it fails.
    visibility: 'system',
    purpose: 'maintenance',
    name: 'OAuth & Session Cleanup',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true },

    schedule: {
        every: '1h',
        runOnStartup: false,
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    resourceClass: 'maintenance',

    inputSchema,

    timeout: { hard: '60m', soft: '55m' },

    async execute(ctx) {
        const { logger, signal } = ctx;

        // envOverride is for interval override only; for full-disable semantics
        // (blocks both scheduled and manual triggers) we gate at execute() entry.
        if (config.DISABLE_OAUTH_CLEANUP) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    ...ALL_ZEROS,
                    message: 'oauth-cleanup disabled via DISABLE_OAUTH_CLEANUP',
                },
            };
        }

        if (signal.aborted) {
            return {
                success: true,
                itemsProcessed: 0,
                stopReason: 'aborted',
                result: {
                    ...ALL_ZEROS,
                    message: 'Aborted before start',
                },
            };
        }

        const errors: string[] = [];
        let deviceCodesDeleted = 0;
        let refreshTokensDeleted = 0;
        let patsDeleted = 0;
        let serviceTokensDeleted = 0;
        let jellyfinTokensDeleted = 0;
        let streamingSessionsEnded = 0;
        let streamingSessionsOrphanedEnded = 0;
        let streamingSessionsDeleted = 0;

        let oauthModule: OAuthModule;
        try {
            oauthModule = (await import('$lib/server/oauth/index.js')) as OAuthModule;
        } catch (error) {
            // The OAuth module itself failed to load — this is a real
            // configuration problem, not "OAuth not enabled". Promote to warn.
            logger.warn('OAuth cleanup: failed to load oauth module', {
                reason: error instanceof Error ? error.message : 'Unknown import failure',
            });
            throw error instanceof Error
                ? error
                : new Error('Failed to load oauth module', { cause: error });
        }

        // PATs and service tokens are independent of the device-auth flow —
        // they authenticate API callers regardless of whether the device-code
        // grant is enabled. Always clean them up.
        if (!signal.aborted) {
            patsDeleted = await runCount(
                'personal-access-tokens',
                () => oauthModule.getPatService().cleanup(),
                logger,
                errors,
            );
        }

        if (!signal.aborted) {
            serviceTokensDeleted = await runCount(
                'service-tokens',
                () => oauthModule.getServiceTokenService().cleanup(),
                logger,
                errors,
            );
        }

        // Device-code flow tokens (device codes + refresh tokens) only exist
        // when device auth is enabled. Skip these if the feature is off to
        // avoid touching tables that may be empty/unreachable.
        if (oauthModule.isDeviceAuthEnabled()) {
            if (!signal.aborted) {
                deviceCodesDeleted = await runCount(
                    'device-codes',
                    () => oauthModule.getDeviceCodeService().cleanupExpired(),
                    logger,
                    errors,
                );
            }

            if (!signal.aborted) {
                refreshTokensDeleted = await runCount(
                    'refresh-tokens',
                    () => oauthModule.getRefreshTokenService().cleanup(),
                    logger,
                    errors,
                );
            }
        }

        // Jellyfin token cleanup is gated on Jellyfin being enabled.
        if (!signal.aborted && operationMode.isJellyfinEnabled) {
            jellyfinTokensDeleted = await runCount(
                'jellyfin-tokens',
                () => oauthModule.getJellyfinTokenService().cleanup(),
                logger,
                errors,
            );
        }

        // Streaming session service is imported lazily and may fail its
        // import independently — keep the previous behaviour of treating an
        // import error as "service not available" but log it at `warn` so
        // operators can investigate rather than lose the signal.
        if (!signal.aborted) {
            try {
                const streamingModule =
                    (await import('$lib/server/oauth/streaming-session.service.js')) as StreamingModule;
                const cleanupResult = await streamingModule.getStreamingSessionService().cleanup();
                const {
                    inactiveEnded = 0,
                    expiredEnded = 0,
                    orphanedParentsEnded = 0,
                    oldDeleted = 0,
                } = cleanupResult ?? {};
                streamingSessionsEnded = inactiveEnded + expiredEnded;
                streamingSessionsOrphanedEnded = orphanedParentsEnded;
                streamingSessionsDeleted = oldDeleted;
            } catch (streamError) {
                const message =
                    streamError instanceof Error ? streamError.message : 'Service not available';
                logger.warn('OAuth cleanup: streaming session cleanup failed', {
                    reason: message,
                });
                errors.push(`streaming-sessions: ${message}`);
            }
        }

        const totalCleaned =
            deviceCodesDeleted +
            refreshTokensDeleted +
            patsDeleted +
            serviceTokensDeleted +
            jellyfinTokensDeleted +
            streamingSessionsEnded +
            streamingSessionsOrphanedEnded +
            streamingSessionsDeleted;

        if (totalCleaned > 0 || errors.length > 0) {
            logger.info('OAuth cleanup completed', {
                deviceCodesDeleted,
                refreshTokensDeleted,
                patsDeleted,
                serviceTokensDeleted,
                jellyfinTokensDeleted,
                streamingSessionsEnded,
                streamingSessionsOrphanedEnded,
                streamingSessionsDeleted,
                errorCount: errors.length,
            });
        }

        const success = errors.length === 0;
        const messageParts: string[] = [];
        if (totalCleaned > 0) {
            messageParts.push(`Cleaned up ${totalCleaned} expired items`);
        } else {
            messageParts.push('No expired items to clean up');
        }
        if (errors.length > 0) {
            messageParts.push(`${errors.length} service cleanup error(s) — see logs`);
        }

        const wasAborted = signal.aborted;

        // Total failure: every attempted service errored and nothing was
        // cleaned up. A bare `success:false` return here never marks the Run
        // failed or feeds the circuit breaker (only a thrown error does), so
        // a persistently-broken dependency (e.g. streaming-session service
        // import failing every run) would stay invisible forever. Per-item
        // isolation above is unaffected — each service still gets its own
        // try/catch and a single broken service doesn't block the others;
        // this only escalates when EVERY attempted service failed.
        if (!wasAborted && errors.length > 0 && totalCleaned === 0) {
            throw new TaskError({
                message: `oauth-cleanup: total failure — 0 items cleaned across ${errors.length} service error(s): ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? '...' : ''}`,
                kind: 'transient',
                cause: errors,
            });
        }

        return {
            success,
            itemsProcessed: totalCleaned,
            stopReason: wasAborted ? 'aborted' : undefined,
            result: {
                deviceCodesDeleted,
                refreshTokensDeleted,
                patsDeleted,
                serviceTokensDeleted,
                jellyfinTokensDeleted,
                streamingSessionsEnded,
                streamingSessionsOrphanedEnded,
                streamingSessionsDeleted,
                errors,
                message: messageParts.join('; '),
            },
        };
    },
});

registry.registerTask(oauthCleanupTask);
