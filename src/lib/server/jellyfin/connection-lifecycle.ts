// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin connection lifecycle for ONE process: the boot check, and keeping the
 * connection state, the API client and the sessions mirror in step with the
 * Jellyfin settings while the process runs.
 *
 * This used to live in hooks.server.ts and only ran at boot. A URL / API key
 * saved later left the connection state `not_configured` for the process
 * lifetime: `canCallJellyfin()` stayed false (image proxy, avatars, admin
 * status, the Jellyfin leg of sync-missing-metadata), admin Reconnect had no
 * verify function to call, and the sessions mirror never started. And only the
 * SAVING process reset the API client; a worker that had built (or failed to
 * build) the client from the old settings kept it until restart.
 *
 * Every process now subscribes to the config-change notification (fired after a
 * local save and after the reload every save broadcasts to the other processes)
 * and re-applies whenever the effective Jellyfin URL, API key or sync flag
 * differ from what it last applied.
 */

import { config, features } from '../config.js';
import { onConfigChange, reloadConfig } from '../config/config.service.js';
import { connectionStatus } from '../services/connection-status.service.js';
import { sessionsCacheService } from '../services/sessions-cache.service.js';
import { Logger } from '../utils/logger.js';
import { jellyfinAuthService } from './auth.service.js';
import { resetJellyfinApi } from './base-client.js';

const logger = Logger.for('JellyfinConnection');

interface AppliedJellyfinConfig {
    url: string;
    apiKey: string;
    sync: boolean;
}

let applied: AppliedJellyfinConfig | null = null;
/** Bumped on every new connection check; a check that finishes after a newer one started is dropped. */
let generation = 0;
/** The connection check started by the latest settings change, until it settles. */
let inflight: Promise<void> | null = null;
let unsubscribe: (() => void) | null = null;
let stopped = false;
let stopping: Promise<void> | undefined;
const verificationPending = new Set<Promise<{ serverName: string; version: string }>>();

function currentConfig(): AppliedJellyfinConfig {
    return {
        url: config.JELLYFINURL,
        apiKey: config.JELLYFINAPIKEY,
        sync: config.FEATURE_JELLYFIN_SYNC,
    };
}

function verify(): Promise<{ serverName: string; version: string }> {
    if (stopped) return Promise.reject(new Error('Jellyfin connection lifecycle is stopping'));
    const pending = jellyfinAuthService.verifyConnection();
    verificationPending.add(pending);
    void pending.then(
        () => verificationPending.delete(pending),
        () => verificationPending.delete(pending),
    );
    return pending;
}

/**
 * Start the sessions mirror if it is not running. `startCaching()` is
 * idempotent and a no-op unless `features.jellyfinSync` is on, and the refresh
 * is Valkey leader-locked per time bucket, so exactly one node polls Jellyfin
 * however many processes call this. It runs on every role: WORKER_MODE=enabled
 * is also the single-host all-in-one config, which serves the session UI.
 */
function startSessionsMirror(): void {
    if (!stopped) sessionsCacheService.startCaching();
}

/**
 * Verify the current credentials and record the result. On failure the
 * connection status schedules its own retries (backoff) with the registered
 * verify function, and the registered callback starts the mirror on recovery.
 * With watch sync off nothing calls Jellyfin in the background, so a failed
 * check is not retried (admin Reconnect and "Test connection" still work).
 */
async function connect(gen: number): Promise<void> {
    connectionStatus.setConnecting('jellyfin');
    // Always registered, so admin Reconnect works whether this first check
    // succeeds or not.
    connectionStatus.registerJellyfinVerifyFn(verify, startSessionsMirror);

    try {
        const info = await verify();
        if (stopped || gen !== generation) return;
        connectionStatus.setConnected('jellyfin', {
            serverName: info.serverName,
            version: info.version,
        });
        logger.info('Jellyfin connection verified', {
            serverName: info.serverName,
            version: info.version,
        });
        startSessionsMirror();
    } catch (error) {
        if (stopped || gen !== generation) return;
        const errorMessage = error instanceof Error ? error.message : String(error);
        connectionStatus.setDisconnected('jellyfin', errorMessage);
        if (!features.jellyfinSync) connectionStatus.stopJellyfinRetry();
        logger.warn('Cannot connect to Jellyfin', {
            error: errorMessage,
            url: config.JELLYFINURL,
            help: features.jellyfinSync
                ? 'App will retry connection automatically.'
                : 'Watch sync is off, so the app does not retry on its own.',
            troubleshooting: [
                'Verify Jellyfin server is running and accessible',
                'Check JELLYFINURL is correct',
                'Verify JELLYFINAPIKEY is valid',
                'Ensure network/firewall allows the connection',
            ],
        });
    }
}

function startConnect(): Promise<void> {
    const gen = ++generation;
    const run = connect(gen).finally(() => {
        if (inflight === run) inflight = null;
    });
    inflight = run;
    return run;
}

/**
 * Bring this process in line with the current Jellyfin settings. A no-op when
 * nothing Jellyfin-related changed since the last call (it then waits for a
 * check still running), so it is cheap to run on every config notification.
 */
export async function applyJellyfinConfig(): Promise<void> {
    if (stopped) return;
    const next = currentConfig();
    const prev = applied;
    applied = next;

    const credentialsChanged =
        prev === null || prev.url !== next.url || prev.apiKey !== next.apiKey;

    if (!credentialsChanged) {
        if (prev.sync !== next.sync) {
            // Only the sync switch moved: the credentials are unchanged.
            if (!features.jellyfinSync) {
                sessionsCacheService.stopCaching();
                connectionStatus.stopJellyfinRetry();
            } else if (connectionStatus.isJellyfinAvailable()) {
                startSessionsMirror();
            } else if (features.jellyfin && !inflight) {
                // Off → on while not connected: background retries were off.
                return startConnect();
            }
        }
        if (inflight) await inflight;
        return;
    }

    // Supersede a check still running for the old settings, and any retry.
    generation++;
    inflight = null;
    connectionStatus.stopJellyfinRetry();
    sessionsCacheService.stopCaching();
    // The saving process already reset its client; every other process still
    // holds one built from the old settings (or a latched "not configured",
    // possibly even before the first apply). Resetting twice is harmless.
    resetJellyfinApi();

    if (!features.jellyfin) {
        connectionStatus.setNotConfigured('jellyfin');
        if (prev === null) {
            logger.info('Jellyfin not configured (optional: watch-history import and sync only)', {
                help: 'Configure JELLYFINURL and JELLYFINAPIKEY only if you want to connect a Jellyfin server',
            });
        } else {
            logger.info('Jellyfin settings removed — connection closed');
        }
        return;
    }

    if (prev !== null) logger.info('Jellyfin settings changed — reconnecting');
    return startConnect();
}

/**
 * Boot entry point: first check, then follow every config change in this
 * process. Idempotent. Resolves once the first check is done.
 */
export async function startJellyfinConnectionLifecycle(): Promise<void> {
    if (stopped) throw new Error('Jellyfin connection lifecycle is stopping');
    if (!unsubscribe) {
        unsubscribe = onConfigChange(() => {
            void applyJellyfinConfig().catch((error: unknown) => {
                logger.warn('Applying changed Jellyfin settings failed', {
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        });
    }
    await applyJellyfinConfig();
}

/** Stop new config/retry checks and await all checks, including superseded ones. */
export function stopJellyfinConnectionLifecycle(): Promise<void> {
    stopped = true;
    generation++;
    stopping ??= (async (): Promise<void> => {
        const failures: unknown[] = [];
        // These independent releases must all run even if one rejects. They
        // happen before awaiting network work, whose bound is the host deadline.
        for (const release of [
            () => {
                unsubscribe?.();
                unsubscribe = null;
            },
            () => connectionStatus.unregisterJellyfinVerifyFn(),
            () => sessionsCacheService.stopCaching(),
        ]) {
            try {
                release();
            } catch (error) {
                failures.push(error);
            }
        }
        await Promise.allSettled([...verificationPending]);
        if (failures.length)
            throw new AggregateError(failures, 'Jellyfin lifecycle cleanup incomplete');
    })().catch((error: unknown) => {
        stopping = undefined;
        throw error;
    });
    return stopping;
}

/**
 * Admin Reconnect. Re-reads the settings first (in case this process missed or
 * has not yet received the reload broadcast), applies them, then checks.
 * Returns null when Jellyfin is not configured, otherwise whether it is connected.
 */
export async function reconnectJellyfin(): Promise<boolean | null> {
    if (stopped) return false;
    // Captured before the reload: its notification may start a check synchronously.
    const gen = generation;
    try {
        // Fires the config notification, which applies changed settings.
        await reloadConfig();
    } catch (error) {
        logger.warn('Reconnect: could not re-read settings', {
            error: error instanceof Error ? error.message : String(error),
        });
    }
    await applyJellyfinConfig();
    if (stopped) return false;
    if (!features.jellyfin) return null;
    // The settings changed and were just checked: don't check twice.
    if (gen !== generation) return connectionStatus.isJellyfinAvailable();
    return connectionStatus.forceJellyfinReconnect();
}

/** Test-only: forget the applied settings and the subscription. */
export function resetJellyfinConnectionLifecycleForTests(): void {
    unsubscribe?.();
    unsubscribe = null;
    applied = null;
    generation = 0;
    inflight = null;
    stopped = false;
    stopping = undefined;
    verificationPending.clear();
}
