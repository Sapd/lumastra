// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Health verdict for one Valkey instance on System Health → Valkey capacity.
//
// The instance holding the task keyspace (the shared single instance, or the
// TASK_CACHE_URL one) must run `noeviction`: BullMQ lock / stalled-tracker keys
// and task run-state carry TTLs, so `volatile-*` evicts them just like
// `allkeys-*` does. A cache-only instance may use any policy.
//
// No `maxmemory` is a valid setup (the shipped compose runs the single
// instance under `noeviction` with no cap — cache keys expire on their own),
// so an uncapped instance passes instead of warning.

export type ValkeyHealthStatus = 'pass' | 'warn' | 'fail';

export function valkeyCapacityStatus(
    usagePercent: number | null,
    maxmemoryPolicy: string | null,
    roles: ReadonlyArray<'cache' | 'tasks'>,
): { status: ValkeyHealthStatus; reason?: string } {
    if (usagePercent !== null && usagePercent > 95) {
        return { status: 'fail', reason: 'near exhaustion (>95% of maxmemory)' };
    }
    if (usagePercent !== null && usagePercent > 80) {
        return { status: 'fail', reason: 'capacity critical (>80% of maxmemory)' };
    }
    if (roles.includes('tasks') && maxmemoryPolicy && maxmemoryPolicy !== 'noeviction') {
        return {
            status: 'warn',
            reason:
                `eviction policy '${maxmemoryPolicy}' can evict task locks and job state — ` +
                "run this instance with '--maxmemory-policy noeviction', or move tasks to a " +
                'separate noeviction Valkey via TASK_CACHE_URL',
        };
    }
    if (usagePercent !== null && usagePercent > 70) {
        return { status: 'warn', reason: 'capacity warning (>70% of maxmemory)' };
    }
    return { status: 'pass' };
}
