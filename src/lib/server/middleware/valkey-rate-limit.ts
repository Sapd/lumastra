// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Redis/Valkey-based Rate Limiting Middleware
 *
 * Provides distributed rate limiting using Valkey (Redis-compatible)
 * with automatic fallback to in-memory rate limiting when Valkey is unavailable.
 *
 * Uses a fixed window counter algorithm for simplicity and performance.
 */

import {
    restrictImageRequest,
    runImageProviderBudget,
} from '$lib/server/services/image-proxy/work-budget';
import { dev } from '$app/environment';
import { env } from '$env/dynamic/private';
import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import {
    getCoordinationClient,
    connectValkey,
    isCoordinationValkeyReady,
    getKeysByPattern,
    cacheGet,
    del,
} from '$lib/server/cache/valkey';
import { ApiResponses, getEndpointName } from '$lib/server/utils/api-responses';
import { getClientIp, getClientIpStrict } from '$lib/server/utils/client-ip';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('RateLimit');

// Approval hashes are offline enumerable. Keep them in storage, never in logs.
function logSafeRateLimitKey(key: string): string {
    return key.startsWith('oauth:approval:code:') ? 'oauth:approval:code:[REDACTED]' : key;
}

function logSafeRateLimitError(key: string, error: unknown): Error | undefined {
    // A storage error may echo the key in its message or stack too.
    return key.startsWith('oauth:approval:code:') ? undefined : (error as Error);
}

// In-memory fallback store
const memoryStore = new Map<string, { count: number; resetTime: number }>();

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetAt: number; // Unix timestamp in seconds
    total: number;
}

/** Shared E2E identities burst through both route and failed-auth buckets. */
function rateLimitBudget(limit: number): number {
    // Ignored in production builds, even if the variable is accidentally set.
    const multiplier = dev ? Number(env.LUMASTRA_E2E_RATE_LIMIT_MULTIPLIER ?? '1') : 1;
    return Number.isInteger(multiplier) && multiplier >= 1 && multiplier <= 100
        ? limit * multiplier
        : limit;
}

/**
 * Check rate limit using Valkey with in-memory fallback
 */
export async function checkRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
): Promise<RateLimitResult> {
    limit = rateLimitBudget(limit);
    const now = Math.floor(Date.now() / 1000);
    const windowKey = `ratelimit:${key}:${Math.floor(now / windowSeconds)}`;
    const resetAt = (Math.floor(now / windowSeconds) + 1) * windowSeconds;

    try {
        const client = getCoordinationClient();
        if (client && isCoordinationValkeyReady()) {
            // Use Valkey for distributed rate limiting
            const count = await client.incr(windowKey);

            // TTL on every hit, NX so it never extends: a process that died
            // between the first INCR and its EXPIRE would otherwise leave a
            // TTL-less counter on the noeviction task Valkey forever (and lock
            // the key out for good once it passes the limit).
            await client.customCommand(['EXPIRE', windowKey, String(windowSeconds + 1), 'NX']);

            return {
                allowed: count <= limit,
                remaining: Math.max(0, limit - count),
                resetAt,
                total: limit,
            };
        }
    } catch (error) {
        logger.warn(
            'Valkey rate limit check failed, using fallback',
            { key: logSafeRateLimitKey(key) },
            logSafeRateLimitError(key, error),
        );
    }

    // Fallback to in-memory rate limiting
    return checkMemoryRateLimit(key, limit, windowSeconds, resetAt);
}

/**
 * Standard `X-RateLimit-*` headers for a {@link checkRateLimit} result.
 *
 * Endpoints that call `checkRateLimit` directly (rather than going through
 * {@link withValkeyRateLimit}) used to publish their budget only on a 429 —
 * i.e. only once the client had already overrun it. That is the one moment
 * the information is useless: a client cannot pace itself from a signal it
 * receives after being cut off. Attaching these to SUCCESS responses is what
 * lets a caller slow down before it trips, which matters most for clients
 * that flush queued work in bursts.
 *
 * Header names match the ones {@link withValkeyRateLimit} already emits, so
 * there is exactly one vocabulary across the API.
 *
 * `X-RateLimit-Reset` is a Unix timestamp in SECONDS (not a duration), and
 * `X-RateLimit-Remaining` counts requests left in the CURRENT fixed window,
 * which resets in full at that timestamp rather than refilling gradually.
 */
export function rateLimitHeaders(result: {
    total: number;
    remaining: number;
    resetAt: number;
}): Record<string, string> {
    return {
        'X-RateLimit-Limit': String(result.total),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetAt),
    };
}

/**
 * Attach {@link rateLimitHeaders} to an existing Response and return it.
 *
 * Mutates in place when the headers are mutable (every server-constructed
 * Response, including SvelteKit's `json()`), and falls back to a re-wrap for
 * the immutable case — a fetched/proxied Response — so a caller can apply
 * this uniformly without knowing which kind it holds.
 *
 * A 204/304 keeps its null body through the fallback path, which matters:
 * re-wrapping those with a non-null body would make them invalid.
 */
export function withRateLimitHeaders<T extends Response>(
    response: T,
    result: { total: number; remaining: number; resetAt: number },
): Response {
    const extra = rateLimitHeaders(result);
    try {
        for (const [name, value] of Object.entries(extra)) {
            response.headers.set(name, value);
        }
        return response;
    } catch {
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(extra)) {
            headers.set(name, value);
        }
        const bodyless = response.status === 204 || response.status === 304;
        return new Response(bodyless ? null : response.body, {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    }
}

/**
 * Read the current counter for a window WITHOUT incrementing it. Use as a
 * pre-flight gate so a check doesn't itself consume budget (e.g. a successful
 * login must not erode a per-username failure cap). `allowed` is false once the
 * recorded count has reached `limit`.
 */
export async function peekRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
): Promise<{ allowed: boolean; resetAt: number }> {
    limit = rateLimitBudget(limit);
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / windowSeconds);
    const windowKey = `ratelimit:${key}:${bucket}`;
    const resetAt = (bucket + 1) * windowSeconds;

    try {
        const client = getCoordinationClient();
        if (client && isCoordinationValkeyReady()) {
            const raw = await cacheGet(windowKey);
            const count = raw ? parseInt(raw, 10) : 0;
            return { allowed: count < limit, resetAt };
        }
    } catch (error) {
        logger.warn(
            'Valkey rate-limit peek failed, using fallback',
            { key: logSafeRateLimitKey(key) },
            logSafeRateLimitError(key, error),
        );
    }

    const entry = memoryStore.get(key);
    const count = entry && Date.now() < entry.resetTime ? entry.count : 0;
    return { allowed: count < limit, resetAt };
}

/**
 * Clear a rate-limit counter (e.g. reset a per-username failure cap after a
 * successful login). Best-effort; never throws.
 */
export async function resetRateLimit(key: string, windowSeconds: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const windowKey = `ratelimit:${key}:${Math.floor(now / windowSeconds)}`;
    try {
        const client = getCoordinationClient();
        if (client && isCoordinationValkeyReady()) {
            await del(windowKey);
        }
    } catch {
        // best-effort
    }
    memoryStore.delete(key);
}

/**
 * Give back one attempt that {@link checkRateLimit} reserved, in the SAME window
 * (`resetAt` is the value that call returned). Only for a caller that has
 * proven the attempt was legitimate (a correct PIN), so nobody can refund
 * attempts they did not earn. The decrement is atomic and never goes below 0;
 * a window that has already ended is left alone. Best-effort; never throws.
 */
export async function refundRateLimit(
    key: string,
    windowSeconds: number,
    resetAt: number,
): Promise<void> {
    if (Math.floor(Date.now() / 1000) >= resetAt) return;
    const windowKey = `ratelimit:${key}:${resetAt / windowSeconds - 1}`;
    try {
        const client = getCoordinationClient();
        if (client && isCoordinationValkeyReady()) {
            const count = await client.decr(windowKey);
            if (count < 0) await client.incr(windowKey);
            return;
        }
    } catch (error) {
        logger.warn(
            'Valkey rate-limit refund failed',
            { key: logSafeRateLimitKey(key) },
            logSafeRateLimitError(key, error),
        );
    }
    const entry = memoryStore.get(key);
    if (entry && Date.now() < entry.resetTime && entry.count > 0) entry.count--;
}

/**
 * In-memory rate limit check (fallback)
 */
function checkMemoryRateLimit(
    key: string,
    limit: number,
    windowSeconds: number,
    resetAt: number,
): RateLimitResult {
    const now = Date.now();
    const windowMs = windowSeconds * 1000;
    const entry = memoryStore.get(key);

    if (entry) {
        if (now < entry.resetTime) {
            // Within rate limit window
            entry.count++;
            return {
                allowed: entry.count <= limit,
                remaining: Math.max(0, limit - entry.count),
                resetAt,
                total: limit,
            };
        }
    }

    // New window or first request
    memoryStore.set(key, { count: 1, resetTime: now + windowMs });

    // Cleanup old entries periodically (1% chance)
    if (Math.random() < 0.01) {
        cleanupMemoryStore(windowMs);
    }

    return {
        allowed: true,
        remaining: limit - 1,
        resetAt,
        total: limit,
    };
}

/**
 * Cleanup expired entries from memory store
 */
function cleanupMemoryStore(maxAge: number): void {
    const cutoff = Date.now() - maxAge;
    for (const [key, entry] of memoryStore.entries()) {
        if (entry.resetTime < cutoff) {
            memoryStore.delete(key);
        }
    }
}

/**
 * Rate limit configuration presets for different endpoint types
 */
export const RateLimitPresets = {
    // Resource-intensive AI operations
    AI_EMBEDDINGS: { limit: 5, windowSeconds: 60 },

    // AI suggestions and recommendations
    AI_SUGGESTIONS: { limit: 30, windowSeconds: 60 },

    // Search queries
    SEARCH: { limit: 60, windowSeconds: 60 },

    // Anonymous image-provider work; authenticated users get 2000/min below.
    // Cache hits and local files are free for both identities.
    IMAGE_PROXY: { limit: 300, windowSeconds: 60 },

    // General API endpoints
    STANDARD: { limit: 100, windowSeconds: 60 },

    // Strict limit for expensive operations
    STRICT: { limit: 10, windowSeconds: 60 },

    // Heavy admin analytics endpoints — per-user-per-route abuse cap
    ADMIN_HEAVY: { limit: 30, windowSeconds: 60 },
} as const;

/**
 * 30 req/min per user per route — abuse cap for multi-table / analytics admin reads.
 * Key = ip:username:endpoint (per-user-per-route). Fails open on Valkey outage.
 */
export const ADMIN_HEAVY_RATE_LIMIT = RateLimitPresets.ADMIN_HEAVY;

/**
 * Rate limiting middleware using Valkey with in-memory fallback
 *
 * @param limit - Maximum requests per window
 * @param windowSeconds - Window size in seconds (default: 60)
 * @param keyGenerator - Custom key generator function (default: IP + username)
 * @param options.strict - security review 2026-09-12, C13: when true and no
 *   `keyGenerator` is supplied, the DEFAULT key uses `getClientIpStrict`
 *   instead of the implicit-trust `getClientIp`, so the bucket cannot be
 *   dodged by rotating `X-Forwarded-For` when `TRUSTED_PROXY_IPS` is unset.
 *   Ignored when a custom `keyGenerator` is provided (it owns key derivation).
 */
export function withValkeyRateLimit(
    limit = 100,
    windowSeconds = 60,
    keyGenerator?: (event: RequestEvent) => string,
    options?: { strict?: boolean },
) {
    return function (handler: RequestHandler): RequestHandler {
        return async (event: RequestEvent): Promise<Response> => {
            const endpoint = getEndpointName(event);

            // Generate rate limit key
            const ip = options?.strict ? getClientIpStrict(event) : getClientIp(event);
            const username = event.locals.user?.username || 'anonymous';
            const defaultKey = `${ip}:${username}:${endpoint}`;
            const key = keyGenerator ? keyGenerator(event) : defaultKey;

            // Check rate limit
            const result = await checkRateLimit(key, limit, windowSeconds);

            // Add rate limit headers to response
            const rateLimitHeaders = {
                'X-RateLimit-Limit': String(result.total),
                'X-RateLimit-Remaining': String(result.remaining),
                'X-RateLimit-Reset': String(result.resetAt),
            };

            if (!result.allowed) {
                logger.warn('Rate limit exceeded', {
                    key: logSafeRateLimitKey(key),
                    limit,
                    endpoint,
                    resetAt: new Date(result.resetAt * 1000).toISOString(),
                });

                const response = ApiResponses.rateLimited(result.resetAt * 1000, endpoint);

                // Add rate limit headers to 429 response
                const headers = new Headers(response.headers);
                for (const [name, value] of Object.entries(rateLimitHeaders)) {
                    headers.set(name, value);
                }

                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            }

            // Proceed to handler and add rate limit headers to response.
            // Server-constructed Responses have mutable headers, so we
            // mutate in place to skip the body re-wrap (saves an
            // allocation per image request — 300+ on a poster grid).
            //
            // Defensive fallback: this middleware is generic
            // (also used by withSearchRateLimit / withAI* /…), so a
            // future handler that returns a fetched (immutable) Response
            // would throw `TypeError: immutable` on .set. Catch and fall
            // back to the wrap path so a refactor elsewhere doesn't
            // silently 500 every rate-limited endpoint.
            const response = await handler(event);
            try {
                for (const [name, value] of Object.entries(rateLimitHeaders)) {
                    response.headers.set(name, value);
                }
                return response;
            } catch {
                const headers = new Headers(response.headers);
                for (const [name, value] of Object.entries(rateLimitHeaders)) {
                    headers.set(name, value);
                }
                return new Response(response.body, {
                    status: response.status,
                    statusText: response.statusText,
                    headers,
                });
            }
        };
    };
}

/**
 * Convenience middleware for AI embedding endpoints
 */
export const withAIEmbeddingRateLimit = withValkeyRateLimit(
    RateLimitPresets.AI_EMBEDDINGS.limit,
    RateLimitPresets.AI_EMBEDDINGS.windowSeconds,
);

/**
 * Convenience middleware for AI suggestion endpoints
 */
export function aiSuggestionRateLimitKey(userId: string): string {
    return `ai-suggestions:${userId}`;
}

export const withAISuggestionRateLimit = withValkeyRateLimit(
    RateLimitPresets.AI_SUGGESTIONS.limit,
    RateLimitPresets.AI_SUGGESTIONS.windowSeconds,
    (event) =>
        aiSuggestionRateLimitKey(
            event.locals.principal?.userId ??
                event.locals.user?.userId ??
                event.locals.principal?.username ??
                event.locals.user?.username ??
                'anonymous',
        ),
);

/**
 * Convenience middleware for search endpoints
 */
export const withSearchRateLimit = withValkeyRateLimit(
    RateLimitPresets.SEARCH.limit,
    RateLimitPresets.SEARCH.windowSeconds,
);

function imageProxyUser(event: RequestEvent): string | undefined {
    return (
        event.locals.principal?.userId ??
        event.locals.user?.userId ??
        event.locals.principal?.username ??
        event.locals.user?.username
    );
}

/** Shared provider-work budget across image defs, sizes, roles and API surfaces. */
export const IMAGE_PROXY_RATE_LIMIT = {
    work: 'image-provider' as const,
    limit: (event: RequestEvent): number =>
        imageProxyUser(event) ? 2000 : RateLimitPresets.IMAGE_PROXY.limit,
    windowSec: RateLimitPresets.IMAGE_PROXY.windowSeconds,
    keyBy: (event: RequestEvent): string => {
        const user = imageProxyUser(event);
        return user ? `image-proxy:user:${user}` : `image-proxy:ip:${getClientIpStrict(event)}`;
    },
};

/**
 * Separate CPU budget: a cache hit never reserves an encode.
 * Current HMAC image/showcase URLs carry no token/user identity. Use the verified
 * request principal when available, otherwise IP; never key on unsigned query
 * parameters or the signature itself (minting another URL must not reset a budget).
 */
export const IMAGE_ENCODE_RATE_LIMIT = {
    limit: (event: RequestEvent): number => (restrictImageRequest(event) ? 300 : 1000),
    windowSec: 60,
    keyBy: (event: RequestEvent): string => {
        const user = imageProxyUser(event);
        return user ? `image-encode:user:${user}` : `image-encode:ip:${getClientIpStrict(event)}`;
    },
};

export async function checkImageEncodeLimit(event: RequestEvent): Promise<Response | null> {
    const policy = IMAGE_ENCODE_RATE_LIMIT;
    const result = await checkRateLimit(policy.keyBy(event), policy.limit(event), policy.windowSec);
    return result.allowed
        ? null
        : withRateLimitHeaders(
              ApiResponses.rateLimited(result.resetAt * 1000, getEndpointName(event)),
              result,
          );
}

/**
 * Convenience middleware for image proxy endpoints
 */
export function withImageProxyRateLimit(handler: RequestHandler): RequestHandler {
    return (event): Promise<Response> =>
        runImageProviderBudget(
            async () => {
                const policy = IMAGE_PROXY_RATE_LIMIT;
                const result = await checkRateLimit(
                    policy.keyBy(event),
                    policy.limit(event),
                    policy.windowSec,
                );
                if (result.allowed) return null;
                return withRateLimitHeaders(
                    ApiResponses.rateLimited(result.resetAt * 1000, getEndpointName(event)),
                    result,
                );
            },
            async () => handler(event),
            () => checkImageEncodeLimit(event),
            restrictImageRequest(event),
            event.request.signal,
        );
}

/**
 * Convenience middleware for heavy admin endpoints (30/min per user per route).
 * Key = ip:username:endpoint (per-user-per-route). Fails open on Valkey outage.
 */
export const withAdminHeavyRateLimit = withValkeyRateLimit(
    ADMIN_HEAVY_RATE_LIMIT.limit,
    ADMIN_HEAVY_RATE_LIMIT.windowSeconds,
);

/**
 * Initialize Valkey connection for rate limiting
 * Called during app startup
 */
export async function initRateLimitCache(): Promise<boolean> {
    try {
        const connected = await connectValkey();
        if (connected) {
            logger.info('Rate limit cache initialized with Valkey');
        } else {
            logger.info('Rate limit using in-memory fallback (Valkey not available)');
        }
        return connected;
    } catch (error) {
        logger.warn('Rate limit cache initialization failed', {}, error as Error);
        return false;
    }
}

/**
 * Get current rate limit stats (for admin/monitoring)
 */
export async function getRateLimitStats(): Promise<{
    backend: 'valkey' | 'memory';
    memoryEntries: number;
    valkeyKeys?: number;
}> {
    const stats: {
        backend: 'valkey' | 'memory';
        memoryEntries: number;
        valkeyKeys?: number;
    } = {
        backend: 'memory',
        memoryEntries: memoryStore.size,
    };

    try {
        const client = getCoordinationClient();
        if (client && isCoordinationValkeyReady()) {
            // Use SCAN instead of KEYS to avoid blocking Redis
            const keys = await getKeysByPattern('ratelimit:*', 10000);
            stats.backend = 'valkey';
            stats.valkeyKeys = keys.length;
        }
    } catch {
        // Valkey not available, using memory
    }

    return stats;
}
