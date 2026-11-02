// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Node.js Runtime Optimizations
 *
 * Optimizes connection pooling and networking for high-throughput scenarios.
 * Import this module early in hooks.server.ts to apply optimizations before other code runs.
 */

import http from 'node:http';
import https from 'node:https';
import { Agent, setGlobalDispatcher } from 'undici';
import { Logger } from './utils/logger.js';
import { installDnsCache } from './utils/dns-cache.js';
import { OUTBOUND_ALLOW_H2, OUTBOUND_CONNECT_TIMEOUT_MS } from './utils/outbound-agent-options.js';

const logger = Logger.for('RuntimeOptimizations');

// =============================================================================
// HTTP AGENT CONFIGURATION
// =============================================================================

/**
 * Optimized HTTP agents with:
 * - Keep-alive enabled (connections persist and are reused)
 * - Higher max sockets per host
 * - Connection scheduling for better latency
 *
 * Note: Connections stay open indefinitely until:
 * - The server closes them (Jellyfin's idle timeout)
 * - Socket timeout triggers (no data for 60s)
 * - maxFreeSockets limit reached and we need room
 */
export const httpAgent = new http.Agent({
    keepAlive: true, // Enable persistent connections (connections are reused)
    keepAliveMsecs: 10000, // Send TCP keep-alive probes every 10s on idle sockets (detects dead servers)
    maxSockets: 100, // Max concurrent sockets per host
    maxFreeSockets: 20, // Keep up to 20 idle connections in pool ready for reuse
    timeout: 60000, // Close socket if no data for 60s (0 = no timeout)
    scheduling: 'lifo', // Last-in-first-out: prefer recently used connections (still warm)
});

export const httpsAgent = new https.Agent({
    keepAlive: true,
    keepAliveMsecs: 10000,
    maxSockets: 100,
    maxFreeSockets: 20,
    timeout: 60000,
    scheduling: 'lifo',
});

// =============================================================================
// GLOBAL AGENT OVERRIDES
// =============================================================================

/**
 * Override global HTTP agents so all http/https.request calls use optimized agents.
 * This affects axios, node-fetch, and other libraries that use the global agent.
 */
export function applyGlobalAgentOptimizations(): void {
    http.globalAgent = httpAgent;
    https.globalAgent = httpsAgent;

    logger.debug('Applied global HTTP agent optimizations', {
        keepAlive: true,
        maxSockets: 100,
        maxFreeSockets: 20,
        timeoutMs: 60000,
        scheduling: 'lifo',
    });
}

// =============================================================================
// AXIOS CONFIGURATION HELPER
// =============================================================================

/**
 * Configure an axios instance to use optimized HTTP agents.
 * Call this after creating an axios instance.
 */
type BeforeRedirectOptions = { hostname?: string; host?: string };
type AxiosLike = {
    defaults?: {
        httpAgent?: http.Agent;
        httpsAgent?: https.Agent;
        timeout?: number;
        maxRedirects?: number;
        beforeRedirect?: (options: BeforeRedirectOptions) => void;
    };
};

/**
 * Configure an axios instance's HTTP agents, timeout, and redirect policy.
 *
 * `allowedRedirectHost`, when given, is the ONLY hostname a redirect may
 * target — scheme and port may differ (so a same-host http→https upgrade is
 * followed), but a redirect to any OTHER hostname is refused. This is for
 * the Jellyfin SDK's axios instance specifically: it sends a `MediaBrowser
 * Token` Authorization header on every request, and axios's default
 * (follow-redirects, unbounded within its own cap) would resend that header
 * to wherever a compromised or misconfigured Jellyfin server 3xx's the
 * request — including an internal address the caller cannot reach directly
 * (blind SSRF). Enforced via follow-redirects' own `beforeRedirect` hook
 * (thrown errors abort the redirect) rather than an origin/full-URL compare,
 * since disabling ALL redirects (the original C29 fix) also blocked a
 * legitimate same-host protocol upgrade.
 *
 * Omitting `allowedRedirectHost` disables redirects entirely
 * (`maxRedirects: 0`) — the safe default for a caller with no known
 * expected host to pin against.
 */
export function configureAxiosWithOptimizedAgents(
    axiosInstance: unknown,
    allowedRedirectHost?: string,
): void {
    // A real axios instance (from `axios.create()`, or the default `axios`
    // export the Jellyfin SDK falls back to when no instance is passed) is a
    // *function* with methods/properties attached — `typeof === 'function'`,
    // NOT 'object'. The former `typeof !== 'object'` guard rejected every
    // real axios instance and silently no-opped; only a plain `{defaults:
    // {...}}` test stub happened to pass it. Accept both shapes and rely on
    // the `.defaults` duck-type check below for the real validation.
    if (
        !axiosInstance ||
        (typeof axiosInstance !== 'object' && typeof axiosInstance !== 'function')
    ) {
        logger.debug('Invalid axios instance provided');
        return;
    }
    const instance = axiosInstance as AxiosLike;
    if (!instance.defaults) {
        logger.debug('Invalid axios instance provided');
        return;
    }

    instance.defaults.httpAgent = httpAgent;
    instance.defaults.httpsAgent = httpsAgent;
    instance.defaults.timeout = 30000;

    if (allowedRedirectHost) {
        instance.defaults.maxRedirects = 5;
        instance.defaults.beforeRedirect = (redirectOptions) => {
            const targetHost = redirectOptions.hostname ?? redirectOptions.host;
            if (targetHost !== allowedRedirectHost) {
                logger.warn('Refusing cross-host redirect', { host: targetHost });
                throw new Error(`refusing to follow cross-host redirect to ${targetHost}`);
            }
        };
    } else {
        instance.defaults.maxRedirects = 0;
    }

    logger.debug('Configured axios instance with optimized agents');
}

// =============================================================================
// UNDICI (NATIVE FETCH) CONFIGURATION
// =============================================================================

/**
 * Optimized undici Agent for native fetch() calls.
 *
 * Native fetch in Node.js uses undici under the hood, which has its own
 * connection pool separate from http.Agent. Default undici settings:
 * - connections: 10 (too low for video streaming)
 * - keepAliveTimeout: 4000ms (too short, connections close between segments)
 *
 * These settings are optimized for video streaming where:
 * - Many concurrent segment requests may occur
 * - Connections should stay alive between segment fetches
 * - Pipelining can improve throughput for sequential requests
 */
export const undiciAgent = new Agent({
    keepAliveTimeout: 30000, // Keep connections alive for 30s (up from 4s default)
    keepAliveMaxTimeout: 60000, // Max keepalive of 60s
    connections: 50, // Max connections per origin (up from 10 default)
    pipelining: 1, // Sequential requests (pipelining can cause issues with some servers)
    // undici 8 turns HTTP/2 on by default. Held off here deliberately, and not
    // only out of caution: `pipelining: 1` is undici's cap on in-flight requests
    // per connection and it applies to h2 streams too (see the note in
    // direct-apns-transport.ts), so h2 would give this agent ONE stream per
    // connection — strictly less throughput than 50 keep-alive h1 sockets, with
    // a different flow-control path under every segment fetch and live-TV pull.
    // Raise `pipelining` first if you want to try h2; the two settings only make
    // sense together.
    allowH2: OUTBOUND_ALLOW_H2,
    connect: {
        timeout: OUTBOUND_CONNECT_TIMEOUT_MS,
    },
});

/**
 * Apply undici optimizations to global fetch()
 */
export function applyUndiciOptimizations(): void {
    setGlobalDispatcher(undiciAgent);

    logger.debug('Applied undici (native fetch) optimizations', {
        keepAliveTimeout: 30000,
        connections: 50,
        connectTimeout: 15000,
    });
}

/**
 * Cleanup undici agent - call on server shutdown to release connections gracefully
 */
export async function cleanupUndiciAgent(): Promise<void> {
    try {
        await undiciAgent.close();
        logger.info('Undici agent closed');
    } catch (error) {
        logger.warn('Error closing undici agent', { error: String(error) });
    }
}

// =============================================================================
// RECOMMENDED ENVIRONMENT VARIABLES
// =============================================================================

/**
 * Log recommended environment variables for optimal performance.
 * These should be set in the Docker container or .env file.
 */
export function logRecommendedEnvVars(): void {
    const recommendations: Record<
        string,
        {
            current: string | undefined;
            recommended: string;
            description: string;
        }
    > = {
        UV_THREADPOOL_SIZE: {
            current: process.env.UV_THREADPOOL_SIZE,
            recommended: '64',
            description: 'Increase from default 4 for I/O heavy workloads (file ops, DNS, crypto)',
        },
        NODE_OPTIONS: {
            current: process.env.NODE_OPTIONS,
            recommended: '--max-old-space-size=512',
            description: 'Set appropriate heap size for your workload',
        },
    };

    const missing: string[] = [];

    for (const [key, info] of Object.entries(recommendations)) {
        if (!info.current) {
            missing.push(`${key}=${info.recommended} (${info.description})`);
        }
    }

    if (missing.length > 0) {
        logger.debug('Recommended environment variables for optimal performance', {
            missing,
            hint: 'Add these to your Docker container or .env file',
        });
    }
}

// =============================================================================
// APPLY ALL OPTIMIZATIONS
// =============================================================================

let optimizationsApplied = false;

export function applyRuntimeOptimizations(): void {
    if (optimizationsApplied) return;
    optimizationsApplied = true;

    // FIRST: cache DNS before any connection pool is created, so postgres.js /
    // ioredis connects never queue getaddrinfo on a threadpool busy with fs.
    const dnsInstalled = installDnsCache();
    applyGlobalAgentOptimizations();
    applyUndiciOptimizations();
    logRecommendedEnvVars();

    logger.info('Runtime optimizations applied', { dnsCache: dnsInstalled });
}
