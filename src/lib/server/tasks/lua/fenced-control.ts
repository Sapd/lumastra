// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthorityToken } from '../../../../task-runtime/authority/store.js';
import type { ValkeyLike } from '../valkey-types.js';
import {
    captureValkeyAuthority,
    VALKEY_TASK_AUTHORITY_KEY,
    VALKEY_TASK_MANAGED_KEY,
} from './fenced.js';

export interface ValkeyTaskAuthoritySnapshot {
    authority: AuthorityToken;
    phase: 'active' | 'draining';
    /** Authoritative PostgreSQL lease, never a newly minted executor lease. */
    leaseUntilMs: number;
}

// Trusted control-plane operations, deliberately separate from executor writes.
// No startup, dispatch or completion path calls these automatically. They are
// CAS building blocks, not an atomic PostgreSQL/Valkey handoff protocol.
const CONTROL_LUA = `
-- @version 1
local current = redis.call('HMGET', KEYS[1], 'generation', 'ownerId', 'phase')
if ARGV[2] == '' then
    if current[1] then return redis.error_reply('TASK_AUTHORITY_CONFLICT') end
elseif current[1] ~= ARGV[2] or current[2] ~= ARGV[3] then
    return redis.error_reply('TASK_AUTHORITY_STALE')
end
if ARGV[1] == 'quarantine' then
    redis.call('SET', KEYS[2], '1')
    redis.call('HSET', KEYS[1], 'partition', 'tasks', 'phase', 'quarantined')
    redis.call('PERSIST', KEYS[1])
    return 1
end
if redis.call('GET', KEYS[2]) ~= '1' then
    return redis.error_reply('TASK_AUTHORITY_MISSING')
end
if current[1] ~= ARGV[4] and current[3] ~= 'quarantined' then
    return redis.error_reply('TASK_AUTHORITY_NOT_QUARANTINED')
end
if current[1] == ARGV[4] and current[2] ~= ARGV[5] then
    return redis.error_reply('TASK_AUTHORITY_CONFLICT')
end
if current[3] == 'draining' and ARGV[6] == 'active' then
    return redis.error_reply('TASK_AUTHORITY_DRAINING')
end
redis.call('HSET', KEYS[1], 'partition', 'tasks', 'generation', ARGV[4],
    'ownerId', ARGV[5], 'phase', ARGV[6], 'leaseUntilMs', ARGV[7])
redis.call('PERSIST', KEYS[1])
redis.call('PERSIST', KEYS[2])
return 1
`;

/** Close Valkey mutations before changing durable authority or reconciling loss. */
export async function quarantineValkeyTaskAuthority(
    client: ValkeyLike,
    expected?: AuthorityToken,
): Promise<void> {
    const token = captureValkeyAuthority(expected);
    await client.customCommand([
        'EVAL',
        CONTROL_LUA,
        '2',
        VALKEY_TASK_AUTHORITY_KEY,
        VALKEY_TASK_MANAGED_KEY,
        'quarantine',
        token?.generation ?? '',
        token?.ownerId ?? '',
    ]);
}

/**
 * Explicitly mirror a durable, verified snapshot after quarantine/reconciliation.
 * Caller must serialize with PostgreSQL authority changes and prove drain; this
 * function cannot do either across stores. Never call this from an executor.
 */
export async function installValkeyTaskAuthority(
    client: ValkeyLike,
    expected: AuthorityToken | undefined,
    snapshot: ValkeyTaskAuthoritySnapshot,
): Promise<void> {
    const prior = captureValkeyAuthority(expected);
    const next = captureValkeyAuthority(snapshot.authority);
    if (
        !next ||
        !Number.isSafeInteger(snapshot.leaseUntilMs) ||
        snapshot.leaseUntilMs <= 0 ||
        !['active', 'draining'].includes(snapshot.phase) ||
        (prior && BigInt(next.generation) < BigInt(prior.generation)) ||
        (prior && next.generation === prior.generation && next.ownerId !== prior.ownerId)
    )
        throw new Error('TASK_AUTHORITY_INVALID');
    await client.customCommand([
        'EVAL',
        CONTROL_LUA,
        '2',
        VALKEY_TASK_AUTHORITY_KEY,
        VALKEY_TASK_MANAGED_KEY,
        'install',
        prior?.generation ?? '',
        prior?.ownerId ?? '',
        next.generation,
        next.ownerId,
        snapshot.phase,
        String(snapshot.leaseUntilMs),
    ]);
}
