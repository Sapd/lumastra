// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Base Jellyfin client with shared API instance and utilities
 * All Jellyfin services extend this class to access the API
 *
 * Includes a circuit breaker that fast-fails requests when Jellyfin is unreachable,
 * preventing cascading timeouts and improving resilience during outages.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders, clientName } from '$lib/server/jellyfin/auth-headers.js';
import { Jellyfin } from '@jellyfin/sdk';
import type { Api } from '@jellyfin/sdk';
import axios from 'axios';
import { recordProviderCall } from '../utils/provider-calls.js';
import type { AxiosInstance, InternalAxiosRequestConfig } from 'axios';
import { config } from '../config.js';
import { Logger } from '../utils/logger.js';
import { configureAxiosWithOptimizedAgents } from '../runtime-optimizations.js';
import { operationMode } from '../operation-mode.js';
import { isRecord } from '$lib/utils/data-extraction';

const logger = Logger.for('Jellyfin');

// =============================================================================
// CIRCUIT BREAKER
// =============================================================================
// Shared across all JellyfinBaseClient instances since they all use the same
// axios instance. Prevents cascading failures when Jellyfin is down.

const CIRCUIT_BREAKER_CONFIG = {
    /** Number of consecutive failures before opening the circuit */
    FAILURE_THRESHOLD: 5,
    /** Time in ms before allowing a probe request through an open circuit */
    RESET_TIMEOUT_MS: 30_000,
    /** Request timeout in ms — prevents hanging on unresponsive Jellyfin */
    REQUEST_TIMEOUT_MS: 10_000,
} as const;

/** Circuit breaker state — module-level singleton */
export const circuitBreaker = {
    failureCount: 0,
    isOpen: false,
    openedAt: 0,
    lastFailureAt: 0,

    /** Record a successful request — closes the circuit */
    recordSuccess(): void {
        if (this.failureCount > 0 || this.isOpen) {
            logger.info('Jellyfin circuit breaker: closing (success)');
        }
        this.failureCount = 0;
        this.isOpen = false;
        this.openedAt = 0;
    },

    /** Record a failed request — may open the circuit */
    recordFailure(): void {
        this.failureCount++;
        this.lastFailureAt = Date.now();
        if (!this.isOpen && this.failureCount >= CIRCUIT_BREAKER_CONFIG.FAILURE_THRESHOLD) {
            this.isOpen = true;
            this.openedAt = Date.now();
            logger.warn(
                `Jellyfin circuit breaker: OPEN after ${this.failureCount} consecutive failures. ` +
                    `Requests will fast-fail for ${CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS / 1000}s.`,
            );
        }
    },

    /**
     * Check if a request should be allowed through.
     * Returns true if the request should proceed, false if it should fast-fail.
     */
    shouldAllowRequest(): boolean {
        if (!this.isOpen) return true;

        // Check if reset timeout has elapsed — allow a probe request
        const elapsed = Date.now() - this.openedAt;
        if (elapsed >= CIRCUIT_BREAKER_CONFIG.RESET_TIMEOUT_MS) {
            logger.info('Jellyfin circuit breaker: allowing probe request (half-open)');
            return true;
        }

        return false;
    },

    /** Get current state for diagnostics */
    getState(): {
        isOpen: boolean;
        failureCount: number;
        timeSinceOpenMs: number | null;
    } {
        return {
            isOpen: this.isOpen,
            failureCount: this.failureCount,
            timeSinceOpenMs: this.isOpen ? Date.now() - this.openedAt : null,
        };
    },

    /** Reset to initial state (for testing) */
    reset(): void {
        this.failureCount = 0;
        this.isOpen = false;
        this.openedAt = 0;
        this.lastFailureAt = 0;
    },
};

// Custom axios config key to bypass circuit breaker for health checks
declare module 'axios' {
    interface AxiosRequestConfig {
        _bypassCircuitBreaker?: boolean;
    }
}

let interceptorsInstalled = false;

/**
 * Install axios interceptors for circuit breaker and timeout.
 * Called once when the API is first initialized.
 */
function installAxiosInterceptors(axiosInstance: AxiosInstance): void {
    if (interceptorsInstalled) return;
    interceptorsInstalled = true;

    // Request interceptor: check circuit breaker + enforce timeout
    axiosInstance.interceptors.request.use((requestConfig: InternalAxiosRequestConfig) => {
        // Always enforce timeout. Axios defaults to timeout=0 ("no timeout"), and
        // ??= won't override 0 since it isn't null/undefined. Use explicit falsy
        // check so the 10 s ceiling is applied to every request.
        if (!requestConfig.timeout) {
            requestConfig.timeout = CIRCUIT_BREAKER_CONFIG.REQUEST_TIMEOUT_MS;
        }

        // Allow health check probes through
        if (requestConfig._bypassCircuitBreaker) {
            return requestConfig;
        }

        // Check circuit breaker
        if (!circuitBreaker.shouldAllowRequest()) {
            const error = new Error('Jellyfin circuit breaker is open — request fast-failed');
            error.name = 'CircuitBreakerOpen';
            return Promise.reject(error);
        }

        return requestConfig;
    });

    // Response interceptor: track successes and failures
    axiosInstance.interceptors.response.use(
        (response) => {
            recordProviderCall('jellyfin', response.status);
            // Success — record it (closes circuit if open)
            circuitBreaker.recordSuccess();
            return response;
        },
        (error: unknown) => {
            const err = error instanceof Error ? error : null;

            // Don't count circuit breaker rejections as new failures
            if (err?.name === 'CircuitBreakerOpen') {
                return Promise.reject(error);
            }

            // Don't count cancelled requests as failures
            if (err && 'code' in err && (err as { code: string }).code === 'ERR_CANCELED') {
                return Promise.reject(error);
            }

            // Don't count most 4xx client errors as failures — they indicate bad
            // requests or missing resources (e.g. 404 for deleted series), not
            // server outages.  Only 5xx and network errors should trip the
            // circuit breaker.
            //
            // EXCEPTION: 401/403 signal a revoked/invalid API key. A sustained
            // auth failure re-throws on EVERY request forever and, if excluded
            // here, NEVER trips the breaker — so `isAvailable()` stays true and
            // watch-sync (which resolves IDs at the queue head) head-of-line-
            // blocks the entire push run indefinitely. Treat auth failures as
            // transport failures so the breaker eventually opens and callers back
            // off until the credentials are fixed.
            if (axios.isAxiosError(error) && error.request) {
                recordProviderCall('jellyfin', error.response?.status ?? null);
            }
            const status = (error as { response?: { status?: number } })?.response?.status;
            if (status && status >= 400 && status < 500 && status !== 401 && status !== 403) {
                return Promise.reject(error);
            }

            // Record failure (may open circuit) — only reached for 5xx, timeouts, network errors
            circuitBreaker.recordFailure();

            // Lazily import connectionStatus to avoid circular deps
            void import('../services/connection-status.service.js')
                .then(({ connectionStatus }) => {
                    if (circuitBreaker.isOpen && connectionStatus.isJellyfinAvailable()) {
                        connectionStatus.setDisconnected(
                            'jellyfin',
                            `Circuit breaker opened after ${circuitBreaker.failureCount} failures`,
                        );
                    }
                })
                .catch(() => {
                    // Import failure is non-critical — circuit breaker still works
                });

            return Promise.reject(error);
        },
    );
}

// Match the shared header's default identity for SDK-generated requests too.
const jellyfin = new Jellyfin({
    clientInfo: {
        name: clientName,
        version: '1.0.0',
    },
    deviceInfo: {
        name: 'Lumastra Server',
        id: 'lumastra-server',
    },
});

let api: Api | null = null;
let apiInitAttempted = false;

function getOrInitApi(): Api | null {
    if (api || apiInitAttempted) return api;
    apiInitAttempted = true;

    if (!operationMode.isJellyfinEnabled) {
        logger.warn('Jellyfin not configured - missing URL or API key');
        return null;
    }

    try {
        // SDK 1.0 made `accessToken` a read-only getter; the token is passed to
        // createApi() instead of being assigned after construction.
        api = jellyfin.createApi(
            config.JELLYFINURL,
            config.JELLYFINAPIKEY,
            axios.create({ headers: buildJellyfinAuthHeaders({ token: config.JELLYFINAPIKEY }) }),
        );

        // Configure axios with keep-alive agents for persistent connections to
        // Jellyfin. The hostname pins the redirect policy: a same-host
        // scheme/port change (e.g. an operator's http→https upgrade) is
        // followed, any other host is refused (see the function's own doc
        // comment). An unparseable JELLYFINURL falls back to no redirects at
        // all rather than failing initialization over it.
        let allowedRedirectHost: string | undefined;
        try {
            allowedRedirectHost = new URL(config.JELLYFINURL).hostname;
        } catch {
            allowedRedirectHost = undefined;
        }
        configureAxiosWithOptimizedAgents(api.axiosInstance, allowedRedirectHost);

        // Install circuit breaker and timeout interceptors
        installAxiosInterceptors(api.axiosInstance);

        logger.info('Jellyfin API initialized with keep-alive connections and circuit breaker');
    } catch (error) {
        logger.error('Failed to initialize Jellyfin API', error as Error);
        api = null;
    }

    return api;
}

/**
 * Drop the memoized Jellyfin API client so the next call re-reads config and
 * rebuilds it. Call this after the Jellyfin URL/API-key config changes at
 * runtime (admin Settings save, first-run setup wizard) so new credentials take
 * effect WITHOUT a restart — `getOrInitApi` otherwise latches `apiInitAttempted`
 * for the process lifetime. Also clears the circuit breaker so a breaker opened
 * by the old (bad/absent) credentials doesn't immediately block the new ones.
 *
 * Class instances cache `this.api` lazily via `getOrInitApi()`, so clearing the
 * module singleton is enough — their next getter call re-fetches the rebuilt one.
 */
export function resetJellyfinApi(): void {
    api = null;
    apiInitAttempted = false;
    // The next getOrInitApi() builds a NEW axios instance; clear this latch so
    // installAxiosInterceptors re-arms the circuit-breaker + timeout interceptors
    // on it (otherwise the rebuilt client would run without them).
    interceptorsInstalled = false;
    circuitBreaker.reset();
    logger.info('Jellyfin API client reset — will reinitialize from current config on next use');
}

/**
 * Base client class that all Jellyfin services extend
 * Provides shared API instance and common utilities
 */
export class JellyfinBaseClient {
    protected api: Api | null;
    protected logger: ReturnType<typeof Logger.for>;

    constructor(loggerContext?: string) {
        this.api = null;
        this.logger = loggerContext ? Logger.for(loggerContext) : logger;
    }

    /**
     * Check if Jellyfin is configured, ready, and the circuit breaker allows requests.
     * Returns false if not configured OR if the circuit breaker is open (Jellyfin down).
     */
    protected isConfigured(): boolean {
        this.api = getOrInitApi();
        if (!this.api) return false;

        // Fast-fail if circuit breaker is open and reset timeout hasn't elapsed
        if (!circuitBreaker.shouldAllowRequest()) {
            return false;
        }

        return true;
    }

    /**
     * Get the axios instance for making direct API calls
     */
    getAxiosInstance(): AxiosInstance | null {
        // Assign (not `??=`) so a runtime config change picked up by
        // resetJellyfinApi() rebuilds the client here too — `getOrInitApi` is
        // O(1) after init, and a cached instance must not pin a stale client.
        this.api = getOrInitApi();
        return this.api?.axiosInstance || null;
    }

    /**
     * Get the base path for API calls
     */
    getBasePath(): string | null {
        this.api = getOrInitApi();
        return this.api?.basePath || null;
    }

    /**
     * Get the access token for API calls
     */
    getAccessToken(): string | null {
        this.api = getOrInitApi();
        return this.api?.accessToken || null;
    }

    /**
     * Alias for getBasePath (for backward compatibility)
     */
    getBaseUrl(): string | null {
        return this.getBasePath();
    }

    /**
     * Alias for getAccessToken (for backward compatibility)
     */
    getApiToken(): string | null {
        return this.getAccessToken();
    }

    /**
     * Verify connection to Jellyfin server by fetching system info.
     * Bypasses the circuit breaker — this IS the health probe.
     * Throws an error if connection fails.
     */
    async verifyConnection(): Promise<{ serverName: string; version: string }> {
        const currentApi = getOrInitApi();
        if (!currentApi) {
            throw new Error('Jellyfin client not configured');
        }

        try {
            this.api = currentApi;
            const response = await currentApi.axiosInstance.get(
                joinUpstreamUrl(currentApi.basePath, `/System/Info`),
                {
                    headers: buildJellyfinAuthHeaders({ token: currentApi.accessToken }),
                    _bypassCircuitBreaker: true,
                },
            );

            return {
                serverName:
                    isRecord(response.data) && typeof response.data.ServerName === 'string'
                        ? response.data.ServerName
                        : 'Unknown',
                version:
                    isRecord(response.data) && typeof response.data.Version === 'string'
                        ? response.data.Version
                        : 'Unknown',
            };
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            this.logger.error('Failed to verify Jellyfin connection', err);
            throw new Error(`Jellyfin connection failed: ${err.message}`, {
                cause: error,
            });
        }
    }
}

// Export the client name for use in other modules
export { clientName };
