// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Connection Status Service
 *
 * Tracks the status of external service connections (Jellyfin, PostgreSQL, Valkey)
 * and provides retry logic for services that become unavailable.
 *
 * Design principles:
 * - PostgreSQL and Valkey are REQUIRED - app exits if unavailable
 * - Jellyfin is OPTIONAL - app runs in degraded mode if unavailable
 * - Automatic retry for Jellyfin with exponential backoff
 * - Connection status exposed for health checks and admin UI
 */

import { Logger } from '../utils/logger.js';

const logger = Logger.for('ConnectionStatus');

export type ServiceName = 'jellyfin' | 'postgres' | 'valkey';
export type ConnectionState =
    'unknown' | 'connecting' | 'connected' | 'disconnected' | 'not_configured';

export interface ServiceStatus {
    state: ConnectionState;
    lastCheck: Date | null;
    lastError: string | null;
    retryCount: number;
    serverInfo?: Record<string, unknown>;
}

export interface ConnectionStatusSnapshot {
    jellyfin: ServiceStatus;
    postgres: ServiceStatus;
    valkey: ServiceStatus;
    overallHealthy: boolean;
    degradedMode: boolean;
}

// Retry configuration
const JELLYFIN_RETRY_INTERVAL_MS = 30_000; // 30 seconds base
const JELLYFIN_MAX_RETRY_INTERVAL_MS = 5 * 60_000; // 5 minutes max

class ConnectionStatusService {
    private status: Record<ServiceName, ServiceStatus> = {
        jellyfin: {
            state: 'unknown',
            lastCheck: null,
            lastError: null,
            retryCount: 0,
        },
        postgres: {
            state: 'unknown',
            lastCheck: null,
            lastError: null,
            retryCount: 0,
        },
        valkey: {
            state: 'unknown',
            lastCheck: null,
            lastError: null,
            retryCount: 0,
        },
    };

    private jellyfinRetryTimer: ReturnType<typeof setTimeout> | null = null;
    private jellyfinVerifyFn: (() => Promise<{ serverName: string; version: string }>) | null =
        null;
    private onJellyfinConnected: (() => void) | null = null;
    /**
     * Bumped when pending retries are cancelled (settings changed or removed,
     * forced reconnect). A retry still awaiting its verify when that happens
     * must not write its stale result over the newer state.
     */
    private jellyfinRetryEpoch = 0;

    /**
     * Mark a service as connected
     */
    setConnected(service: ServiceName, serverInfo?: Record<string, unknown>): void {
        const wasDisconnected = this.status[service].state === 'disconnected';

        this.status[service] = {
            state: 'connected',
            lastCheck: new Date(),
            lastError: null,
            retryCount: 0,
            serverInfo,
        };

        if (service === 'jellyfin' && wasDisconnected) {
            logger.info('Jellyfin connection restored', serverInfo);
            this.onJellyfinConnected?.();
        }
    }

    /**
     * Mark a service as disconnected with error
     */
    setDisconnected(service: ServiceName, error: string): void {
        const wasConnected = this.status[service].state === 'connected';

        this.status[service] = {
            ...this.status[service],
            state: 'disconnected',
            lastCheck: new Date(),
            lastError: error,
            retryCount: this.status[service].retryCount + 1,
        };

        if (wasConnected) {
            logger.warn(`${service} connection lost`, { error });
        }

        // Losing the connection has to START the recovery, not just record the
        // loss. The retry used to be started from the STARTUP failure path only
        // path, so an instance that connected at boot and lost Jellyfin later —
        // a Jellyfin restart, a blip that trips the circuit breaker — had
        // nothing scheduled to ever check again. It sat "unreachable" until the
        // process was restarted.
        //
        // Observed on prod: the worker logged "jellyfin connection lost" at
        // 00:48 and never attempted a reconnect in the following NINE hours,
        // while Jellyfin was up the whole time and the app was successfully
        // talking to it. The admin providers page reported "Jellyfin sync:
        // unreachable" throughout.
        //
        // Guarded on an existing timer so repeated failures cannot stack
        // timers, and `scheduleJellyfinRetry` itself no-ops without a
        // registered verify function or once the state is connected again.
        if (service === 'jellyfin' && this.jellyfinRetryTimer === null) {
            this.scheduleJellyfinRetry();
        }
    }

    /**
     * Mark a service as not configured
     */
    setNotConfigured(service: ServiceName): void {
        if (service === 'jellyfin') this.stopJellyfinRetry();
        this.status[service] = {
            state: 'not_configured',
            lastCheck: new Date(),
            lastError: null,
            retryCount: 0,
        };
    }

    /**
     * Mark a service as connecting (in progress)
     */
    setConnecting(service: ServiceName): void {
        this.status[service] = {
            ...this.status[service],
            state: 'connecting',
            lastCheck: new Date(),
        };
    }

    /**
     * Get status for a specific service
     */
    getStatus(service: ServiceName): ServiceStatus {
        return { ...this.status[service] };
    }

    /**
     * Get snapshot of all connection statuses
     */
    getSnapshot(): ConnectionStatusSnapshot {
        const jellyfin = this.getStatus('jellyfin');
        const postgres = this.getStatus('postgres');
        const valkey = this.getStatus('valkey');

        // Core services must be connected
        const coreHealthy = postgres.state === 'connected' && valkey.state === 'connected';

        // Jellyfin can be disconnected or not configured
        const jellyfinOk = jellyfin.state === 'connected';

        return {
            jellyfin,
            postgres,
            valkey,
            overallHealthy: coreHealthy && jellyfinOk,
            degradedMode: coreHealthy && !jellyfinOk,
        };
    }

    /**
     * Check if Jellyfin is available
     */
    isJellyfinAvailable(): boolean {
        return this.status.jellyfin.state === 'connected';
    }

    /**
     * Check if Jellyfin is configured (URL and API key present)
     */
    isJellyfinConfigured(): boolean {
        return this.status.jellyfin.state !== 'not_configured';
    }

    /**
     * Check if app is running in degraded mode (Jellyfin unavailable)
     */
    isDegradedMode(): boolean {
        const { jellyfin, postgres, valkey } = this.status;
        return (
            postgres.state === 'connected' &&
            valkey.state === 'connected' &&
            jellyfin.state !== 'connected'
        );
    }

    /**
     * Register the Jellyfin verify function (allows force reconnect even after
     * initial success) and, optionally, the callback run when a retry or a
     * forced reconnect brings the connection back.
     */
    registerJellyfinVerifyFn(
        verifyFn: () => Promise<{ serverName: string; version: string }>,
        onConnected?: () => void,
    ): void {
        this.jellyfinVerifyFn = verifyFn;
        if (onConnected) this.onJellyfinConnected = onConnected;
    }

    /** Terminal lifecycle teardown: invalidate any in-flight retry/reconnect. */
    unregisterJellyfinVerifyFn(): void {
        this.stopJellyfinRetry();
        this.jellyfinVerifyFn = null;
        this.onJellyfinConnected = null;
    }

    /**
     * Stop automatic retry for Jellyfin
     */
    stopJellyfinRetry(): void {
        this.jellyfinRetryEpoch++;
        if (this.jellyfinRetryTimer) {
            clearTimeout(this.jellyfinRetryTimer);
            this.jellyfinRetryTimer = null;
        }
    }

    /**
     * Schedule next Jellyfin retry with exponential backoff
     */
    private scheduleJellyfinRetry(): void {
        if (!this.jellyfinVerifyFn) return;
        // setDisconnected() already scheduled one; a second timer would
        // overwrite the handle and survive stopJellyfinRetry().
        if (this.jellyfinRetryTimer !== null) return;
        if (this.status.jellyfin.state === 'connected') return;
        if (this.status.jellyfin.state === 'not_configured') return;

        // Calculate delay with exponential backoff
        const retryCount = this.status.jellyfin.retryCount;
        const delay = Math.min(
            JELLYFIN_RETRY_INTERVAL_MS * Math.pow(1.5, Math.min(retryCount, 10)),
            JELLYFIN_MAX_RETRY_INTERVAL_MS,
        );

        logger.debug('Scheduling Jellyfin retry', {
            retryCount,
            delayMs: delay,
            nextRetryAt: new Date(Date.now() + delay).toISOString(),
        });

        this.jellyfinRetryTimer = setTimeout(() => {
            // Clear the handle as it fires. Only `stopJellyfinRetry` used to null
            // it, so after the first schedule the field held a spent handle
            // forever — indistinguishable from a retry still pending, which makes
            // "is one already scheduled?" unanswerable for any future caller.
            this.jellyfinRetryTimer = null;
            void this.attemptJellyfinReconnect();
        }, delay);
    }

    /**
     * Attempt to reconnect to Jellyfin
     */
    private async attemptJellyfinReconnect(): Promise<void> {
        if (!this.jellyfinVerifyFn) return;
        if (this.status.jellyfin.state === 'connected') return;

        logger.info('Attempting Jellyfin reconnection...', {
            retryCount: this.status.jellyfin.retryCount,
        });

        this.setConnecting('jellyfin');
        const epoch = this.jellyfinRetryEpoch;

        try {
            const info = await this.jellyfinVerifyFn();
            if (epoch !== this.jellyfinRetryEpoch) return;
            this.setConnected('jellyfin', {
                serverName: info.serverName,
                version: info.version,
            });
            logger.info('Jellyfin reconnected successfully', info);
            // setConnected() above saw 'connecting', not 'disconnected', so it
            // did not run the callback; a retry that succeeds IS a recovery.
            this.onJellyfinConnected?.();
        } catch (error) {
            if (epoch !== this.jellyfinRetryEpoch) return;
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.setDisconnected('jellyfin', errorMessage);
            logger.warn('Jellyfin reconnection failed', {
                error: errorMessage,
                retryCount: this.status.jellyfin.retryCount,
            });

            // Schedule next retry
            this.scheduleJellyfinRetry();
        }
    }

    /**
     * Force an immediate Jellyfin connection check/reconnection attempt
     * Works even if currently connected (validates connection is still valid)
     */
    async forceJellyfinReconnect(): Promise<boolean> {
        if (!this.jellyfinVerifyFn) {
            logger.warn('Cannot force reconnect - no verify function registered');
            return false;
        }

        // Cancel any pending retry
        this.stopJellyfinRetry();

        // Reset retry count for manual reconnect
        this.status.jellyfin.retryCount = 0;

        // Check state BEFORE changing to connecting
        const wasNotConnected = this.status.jellyfin.state !== 'connected';

        logger.info('Forcing Jellyfin connection check...', {
            previousState: this.status.jellyfin.state,
        });
        this.setConnecting('jellyfin');
        const epoch = this.jellyfinRetryEpoch;

        try {
            const info = await this.jellyfinVerifyFn();
            // Settings changed while this check ran: its answer is about the old ones.
            if (epoch !== this.jellyfinRetryEpoch) return this.isJellyfinAvailable();
            this.setConnected('jellyfin', {
                serverName: info.serverName,
                version: info.version,
            });
            logger.info('Jellyfin connection verified', info);

            // Fire callback if we were not connected and just (re)connected
            if (wasNotConnected && this.onJellyfinConnected) {
                logger.info('Triggering reconnection callback');
                this.onJellyfinConnected();
            }

            return true;
        } catch (error) {
            if (epoch !== this.jellyfinRetryEpoch) return this.isJellyfinAvailable();
            const errorMessage = error instanceof Error ? error.message : String(error);
            this.setDisconnected('jellyfin', errorMessage);
            logger.warn('Jellyfin connection check failed', {
                error: errorMessage,
            });

            // Start automatic retry
            this.scheduleJellyfinRetry();

            return false;
        }
    }
}

// Singleton instance
export const connectionStatus = new ConnectionStatusService();
