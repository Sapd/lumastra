// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TTL for a validated-token cache entry: the cache default, capped at the
 * token's own expiry. The SQL on the cache-miss path is the only place that
 * checks `expires_at`, so an entry that outlived its token would keep it valid
 * on the cache-hit path for up to the full cache TTL past its deadline.
 */
export function cacheTtlUntilExpiry(
    expiresAt: Date | string | null | undefined,
    defaultTtlMs: number,
    now: number = Date.now(),
): number {
    if (expiresAt === null || expiresAt === undefined) return defaultTtlMs;
    const expiresMs = new Date(expiresAt).getTime();
    if (Number.isNaN(expiresMs)) return 0;
    return Math.max(0, Math.min(defaultTtlMs, expiresMs - now));
}
