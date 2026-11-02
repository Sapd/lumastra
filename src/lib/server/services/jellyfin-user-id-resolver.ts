// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin User ID Resolver
 *
 * Lazy resolver mapping a Lumastra username to a Jellyfin user UUID, honoring the
 * per-user account mapping (users.jellyfin_username / jellyfin_user_id, mig 16.45.0):
 *   L1:  In-memory Map (1h TTL)
 *   DB:  cached jellyfin_user_id (authoritative) / jellyfin_username login override
 *   API: Jellyfin getUserByName(<resolved name>), then persist the UUID to the DB
 *        (the durable, cross-replica, override-aware cache)
 *
 * Returns undefined (never throws) when Jellyfin is disabled, the user is not
 * found, or the service is unreachable.
 */

import { jellyfinUserService } from '../jellyfin/user.service.js';
import { operationMode } from '../operation-mode.js';
import { features } from '../config.js';
import { Logger } from '../utils/logger.js';
import { ApiResponses } from '../utils/api-responses.js';
import type { UserId } from '$lib/shared/user-id';

const logger = Logger.for('JellyfinUserIdResolver');

const L1_TTL_MS = 60 * 60 * 1000; // 1 hour

// L1: In-memory cache with TTL, keyed by Lumastra username.
const jellyfinUserIdCache = new Map<string, { value: string; ts: number }>();

// L1: In-memory cache with TTL, keyed by stable users.id UUID. Kept SEPARATE
// from the username map so a username and a UUID can never collide on a key.
const jellyfinUserIdByUserIdCache = new Map<string, { value: string; ts: number }>();

/**
 * Resolve a Lumastra username to its Jellyfin user UUID, honoring the per-user
 * Jellyfin account mapping (migration 16.45.0).
 *
 * Resolution order:
 *   1. Return undefined immediately if Jellyfin is disabled
 *   2. L1 in-memory cache (keyed by Lumastra username)
 *   3. DB mapping: a cached `jellyfin_user_id` is authoritative; otherwise the
 *      Jellyfin login is `jellyfin_username ?? username` (the override, default
 *      same-name → zero config for existing setups)
 *   4. Jellyfin API getUserByName(<resolved name>), then persist the UUID to the DB
 *      (durable, cross-replica, override-aware cache)
 *
 * Never throws — returns undefined on any failure. A DB hiccup degrades gracefully
 * to a same-name API lookup.
 */
export async function resolveJellyfinUserId(username: string): Promise<string | undefined> {
    // Fast path: Jellyfin not configured or sync disabled
    if (!operationMode.isJellyfinEnabled || !features.jellyfinSync) {
        return undefined;
    }

    // L1: In-memory cache
    const cached = jellyfinUserIdCache.get(username);
    if (cached) {
        if (cached.value && Date.now() - cached.ts < L1_TTL_MS) {
            return cached.value;
        }
        // Expired — evict to prevent unbounded growth
        jellyfinUserIdCache.delete(username);
    }

    // Resolve the Jellyfin login name + any cached UUID from the DB mapping. A DB
    // failure degrades to a same-name lookup rather than failing the resolution.
    let jellyfinName = username;
    try {
        const { aiDbService } = await import('./database.service.js');
        const { getJellyfinMapping, cacheJellyfinUserId } =
            await import('../database/queries/users.queries.js');
        const sql = await aiDbService.getSql();
        if (sql) {
            const mapping = await getJellyfinMapping(sql, username);
            if (mapping?.jellyfin_user_id) {
                // Authoritative cached UUID.
                jellyfinUserIdCache.set(username, {
                    value: mapping.jellyfin_user_id,
                    ts: Date.now(),
                });
                return mapping.jellyfin_user_id;
            }
            if (mapping?.jellyfin_username) jellyfinName = mapping.jellyfin_username;

            // API resolution by the (possibly overridden) Jellyfin name.
            const jellyfinUser = await jellyfinUserService.getUserByName(jellyfinName);
            if (jellyfinUser?.Id) {
                jellyfinUserIdCache.set(username, { value: jellyfinUser.Id, ts: Date.now() });
                await cacheJellyfinUserId(sql, username, jellyfinUser.Id).catch(() => {});
                return jellyfinUser.Id;
            }
            logger.debug('Jellyfin user not found', { username, jellyfinName });
            return undefined;
        }
    } catch (error) {
        logger.warn('Jellyfin mapping lookup failed; falling back to same-name resolution', {
            username,
            error: String(error),
        });
    }

    // DB unavailable — best-effort same-name API resolution (no persistence).
    try {
        const jellyfinUser = await jellyfinUserService.getUserByName(jellyfinName);
        if (jellyfinUser?.Id) {
            jellyfinUserIdCache.set(username, { value: jellyfinUser.Id, ts: Date.now() });
            return jellyfinUser.Id;
        }
        return undefined;
    } catch (error) {
        logger.warn('Failed to resolve Jellyfin user ID', { username, error: String(error) });
        return undefined;
    }
}

/**
 * Resolve a stable `users.id` UUID (UserId) to its Jellyfin user UUID, honoring
 * the per-user Jellyfin account mapping (migration 16.45.0).
 *
 * Same contract as {@link resolveJellyfinUserId}, but the input is the immutable
 * `users.id` UUID rather than the username — used by callers that hold a UserId
 * after the mig-16.46.0 re-key (watch-sync push, watched-series invalidation).
 *
 * Resolution order:
 *   1. Return undefined immediately if Jellyfin is disabled
 *   2. L1 in-memory cache (keyed by UserId — a SEPARATE map from the username one)
 *   3. DB mapping by id: a cached `jellyfin_user_id` is authoritative; otherwise
 *      the Jellyfin login is `jellyfin_username ?? username`
 *   4. Jellyfin API getUserByName(<resolved name>), then persist the UUID to the DB
 *      (durable, override-aware cache — keyed by username via cacheJellyfinUserId)
 *
 * Never throws — returns undefined on any failure.
 */
export async function resolveJellyfinUserIdByUserId(userId: UserId): Promise<string | undefined> {
    // Fast path: Jellyfin not configured or sync disabled
    if (!operationMode.isJellyfinEnabled || !features.jellyfinSync) {
        return undefined;
    }

    // L1: In-memory cache (keyed by UserId)
    const cached = jellyfinUserIdByUserIdCache.get(userId);
    if (cached) {
        if (cached.value && Date.now() - cached.ts < L1_TTL_MS) {
            return cached.value;
        }
        // Expired — evict to prevent unbounded growth
        jellyfinUserIdByUserIdCache.delete(userId);
    }

    // Resolve the Jellyfin login name + any cached UUID from the DB mapping. A DB
    // failure degrades to undefined (no username known off-DB to fall back on).
    try {
        const { aiDbService } = await import('./database.service.js');
        const { getJellyfinMappingById, cacheJellyfinUserId } =
            await import('../database/queries/users.queries.js');
        const sql = await aiDbService.getSql();
        if (sql) {
            const mapping = await getJellyfinMappingById(sql, userId);
            if (!mapping) {
                logger.debug('No Lumastra user for id', { userId });
                return undefined;
            }
            if (mapping.jellyfin_user_id) {
                // Authoritative cached UUID.
                jellyfinUserIdByUserIdCache.set(userId, {
                    value: mapping.jellyfin_user_id,
                    ts: Date.now(),
                });
                return mapping.jellyfin_user_id;
            }

            // API resolution by the (possibly overridden) Jellyfin name.
            const jellyfinName = mapping.jellyfin_username ?? mapping.username;
            const jellyfinUser = await jellyfinUserService.getUserByName(jellyfinName);
            if (jellyfinUser?.Id) {
                jellyfinUserIdByUserIdCache.set(userId, {
                    value: jellyfinUser.Id,
                    ts: Date.now(),
                });
                // cacheJellyfinUserId keys the durable cache by username.
                await cacheJellyfinUserId(sql, mapping.username, jellyfinUser.Id).catch(() => {});
                return jellyfinUser.Id;
            }
            logger.debug('Jellyfin user not found', { userId, jellyfinName });
            return undefined;
        }
    } catch (error) {
        logger.warn('Failed to resolve Jellyfin user ID by user id', {
            userId,
            error: String(error),
        });
        return undefined;
    }

    // DB unavailable and no username known off-DB — cannot resolve.
    return undefined;
}

/**
 * Invalidate the L1 cache entry for a user.
 *
 * Call this after a username change or when a Jellyfin account is re-created
 * (rare — UUIDs change on reinstall). In normal operation the L1 cache is
 * indefinitely lived and cleared only on process restart, which is the expected
 * production lifecycle. L2 (Valkey) is NOT cleared here — if Valkey still has
 * a stale entry, the next resolution will re-populate L1 from it. Clear Valkey
 * separately if you need a full reset: `DEL jellyfin:user:{username}`.
 */
export function invalidateJellyfinUserIdCache(username: string): void {
    jellyfinUserIdCache.delete(username);
}

/**
 * Return a 503 Service Unavailable response for routes that require a
 * Jellyfin user ID but could not obtain one.
 *
 * Distinguishes "Jellyfin not configured" from "Jellyfin reachable but user
 * lookup failed" so operators can diagnose from the response body without
 * tailing logs.
 *
 * Note: returns 503, not 401 — the caller IS authenticated; the downstream
 * service is the problem.
 */
export function jellyfinUnavailableResponse(): Response {
    return !operationMode.isJellyfinEnabled
        ? ApiResponses.serviceUnavailable('Jellyfin', 'Jellyfin is not configured on this server')
        : ApiResponses.serviceUnavailable('Jellyfin', 'Unable to resolve Jellyfin user ID');
}
