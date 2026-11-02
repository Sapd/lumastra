// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { config } from '$lib/server/config.js';
import { getUserLiveTvAllowed } from '$lib/server/database/queries/users.queries.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    onRemoteUserLiveTvInvalidate,
    onAuthCacheBusResync,
    publishAuthCacheInvalidation,
} from '$lib/server/cache/auth-cache-bus.js';

const TTL_MS = 5_000;
const MAX_ENTRIES = 10_000;
const REVOCATION_TTL_MS = 60_000;
// Local policy writes carry revocation knowledge; remote clears/resync mean unknown.
const revocations = new Map<string, number>();
const cache = new Map<string, { allowed: boolean; expires: number; ageDefaultChecked: boolean }>();
const pending = new Map<string, Promise<boolean | undefined>>();
let generation = 0;
function clear(username: string): void {
    generation++;
    cache.delete(username.toLowerCase());
    pending.delete(username.toLowerCase());
}
onRemoteUserLiveTvInvalidate(clear);
onAuthCacheBusResync(() => {
    generation++;
    cache.clear();
    pending.clear();
});

/** Invalidate locally before publishing on the existing cross-replica auth channel. */
export function invalidateUserLiveTvPolicy(username: string): void {
    clear(username);
    const key = username.toLowerCase();
    const now = Date.now();
    for (const [name, expires] of revocations) {
        if (expires <= now) revocations.delete(name);
    }
    if (revocations.size >= MAX_ENTRIES) revocations.delete(revocations.keys().next().value!);
    revocations.set(key, now + REVOCATION_TTL_MS);
    publishAuthCacheInvalidation({ kind: 'user-live-tv', username: username.toLowerCase() });
}

/** Only trusted credential resolution can mark a synthetic service identity. */
export function isSyntheticLiveTvIdentity(
    principal: { kind?: string; syntheticServiceIdentity?: boolean } | null | undefined,
): boolean {
    return principal?.kind === 'service_token' && principal.syntheticServiceIdentity === true;
}

/** Five-second, coalesced permission cache. A definitive denial always wins.
 * DB failure is never cached: new playback fails closed; an already-authorized
 * stream may continue during an outage unless we last observed a revocation.
 */
export async function userAllowsLiveTv(
    username: string,
    options: { continuation?: boolean; ageLimited?: boolean } = {},
): Promise<boolean> {
    const key = username.toLowerCase();
    const hit = cache.get(key);
    if (
        hit &&
        hit.expires > Date.now() &&
        (!options.ageLimited || hit.ageDefaultChecked || !hit.allowed)
    )
        return hit.allowed;
    let query = pending.get(key);
    if (!query) {
        const started = generation;
        query = (async () => {
            try {
                const { getDb } = await import('$lib/server/database/connection.js');
                const sql = getDb();
                if (!sql) return undefined;
                const allowed = options.ageLimited
                    ? await getUserLiveTvAllowed(sql, key, { ageLimited: true })
                    : await getUserLiveTvAllowed(sql, key);
                if (started === generation) {
                    if (cache.size >= MAX_ENTRIES) {
                        const oldest = cache.keys().next().value;
                        if (oldest !== undefined) cache.delete(oldest);
                    }
                    if (allowed) revocations.delete(key);
                    cache.set(key, {
                        allowed,
                        expires: Date.now() + TTL_MS,
                        ageDefaultChecked: options.ageLimited === true,
                    });
                }
                return allowed;
            } catch {
                return undefined;
            }
        })();
        pending.set(key, query);
        void query.finally(() => {
            if (pending.get(key) === query) pending.delete(key);
        });
    }
    const allowed = await query;
    // An invalidation raced this read: do not use a pre-write authorization.
    const current = cache.get(key);
    if (
        allowed !== undefined &&
        current?.allowed === allowed &&
        (!options.ageLimited || current.ageDefaultChecked || !allowed)
    )
        return allowed;
    if (allowed !== undefined) return userAllowsLiveTv(username, options);
    return (
        options.continuation === true &&
        hit?.allowed !== false &&
        (revocations.get(key) ?? 0) <= Date.now()
    );
}

export async function applyLiveTvUserPolicy(
    user:
        | {
              username: string;
              hasLiveTvPermission: boolean;
              isAgeRestricted?: boolean;
              maxAgeRating?: number | null;
          }
        | null
        | undefined,
    options: { continuation?: boolean; syntheticIdentity?: boolean; routeId?: string | null } = {},
): Promise<void> {
    if (options.syntheticIdentity) return;
    if (user && !config.FEATURE_LIVETV && !isLiveTvAdminConfigRouteId(options.routeId ?? null)) {
        user.hasLiveTvPermission = false;
        return;
    }
    if (user?.hasLiveTvPermission)
        user.hasLiveTvPermission = await userAllowsLiveTv(user.username, {
            ...options,
            ageLimited: user.isAgeRestricted === true || user.maxAgeRating != null,
        });
}

function routePath(id: string | null): string {
    return (id ?? '').replace(/\/\([^/]+\)/g, '');
}
function isLiveTvAdminConfigRouteId(id: string | null): boolean {
    return /\/admin\/livetv(?:\/|$)|\/livetv\/admin(?:\/|$)/.test(routePath(id));
}
/** Viewer surfaces only: source configuration is an administrator capability. */
export function isLiveTvRouteId(id: string | null): boolean {
    const path = routePath(id);
    return !isLiveTvAdminConfigRouteId(id) && /(?:^|\/)(?:livetv|LiveTv)(?:\/|$)/.test(path);
}
/** Only these operations reach the lifecycle's owner check after viewing is revoked. */
export function isLiveTvCleanupRequest(event: {
    route?: { id: string | null };
    request?: { method: string };
}): boolean {
    const path = routePath(event.route?.id ?? null);
    return (
        (event.request?.method === 'DELETE' &&
            /\/livetv\/playback-sessions\/\[playbackSessionId\]$/.test(path)) ||
        (event.request?.method === 'POST' &&
            /\/livetv\/playback-sessions\/\[playbackSessionId\]\/leave$/.test(path))
    );
}
export function liveTvRouteGate(event: {
    route: { id: string | null };
    request?: { method: string };
    locals: { user?: { hasLiveTvPermission: boolean } | null };
}): Response | null {
    if (!isLiveTvRouteId(event.route.id) || isLiveTvCleanupRequest(event)) return null;
    if (!event.locals.user) return null;
    if (!config.FEATURE_LIVETV) return ApiProblem.notFound();
    return event.locals.user.hasLiveTvPermission ? null : ApiProblem.notFound();
}
