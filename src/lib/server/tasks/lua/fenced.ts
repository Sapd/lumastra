// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import type { AuthorityToken } from '../../../../task-runtime/authority/store.js';
import type { ValkeyLike } from '../valkey-types.js';
import fenceSource from './ownership-fence.lua?raw';
import { OWNERSHIP_FENCE_VERSION } from './SCRIPT_VERSIONS.js';

export const VALKEY_TASK_AUTHORITY_KEY = 'task:runtime:v1:authority:tasks';
export const VALKEY_TASK_MANAGED_KEY = 'task:runtime:v1:managed:tasks';
export const VALKEY_OWNERSHIP_FENCE_VERSION = OWNERSHIP_FENCE_VERSION;

/** Copy at dispatch/buffer creation; never fetch a newer token for delayed work. */
export function captureValkeyAuthority(
    authority: AuthorityToken | undefined,
): Readonly<AuthorityToken> | undefined {
    if (!authority) return undefined;
    if (
        authority.partition !== 'tasks' ||
        !/^[1-9][0-9]{0,18}$/.test(authority.generation) ||
        BigInt(authority.generation) > 9223372036854775807n ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(authority.ownerId)
    ) {
        throw new Error('TASK_AUTHORITY_INVALID');
    }
    return Object.freeze({
        partition: authority.partition,
        generation: authority.generation,
        ownerId: authority.ownerId,
    });
}

export function isNoScriptError(e: unknown): boolean {
    const msg = e instanceof Error ? e.message : String(e);
    return /noscript|no matching script/i.test(msg);
}

interface FencedScript {
    source: string;
    sha: string;
}
const scripts = new Map<string, FencedScript>();

/**
 * Protect trusted task-system Lua, including direct HSET writers, at the actual
 * mutation boundary. Original KEYS/ARGV positions are preserved by the prefix.
 * This never installs, renews or discovers authority. The trusted control plane
 * must explicitly quarantine and reconcile PostgreSQL/Valkey before activation.
 * A bound writer fails closed if a restart/failover loses either fence key.
 * Complete loss of both keys cannot distinguish an unmanaged install: that
 * durable startup reconciliation remains an activation blocker.
 */
export async function invokeFencedValkey(
    source: string,
    keys: string[],
    argv: (string | number)[],
    client: ValkeyLike,
    authority?: AuthorityToken,
    options: { allowDraining?: boolean } = {},
): Promise<unknown> {
    const original = captureValkeyAuthority(authority);
    let script = scripts.get(source);
    if (!script) {
        const version = /-- @version (\d+)/.exec(fenceSource);
        if (Number(version?.[1]) !== VALKEY_OWNERSHIP_FENCE_VERSION) {
            throw new Error('Task ownership fence version mismatch');
        }
        const wrapped = `${fenceSource}\n${source}`;
        script = { source: wrapped, sha: createHash('sha1').update(wrapped).digest('hex') };
        scripts.set(source, script);
    }
    // Snapshot both script input and token before the first asynchronous call,
    // including NOSCRIPT retry after authority has moved to a newer generation.
    const scriptKeys = [...keys, VALKEY_TASK_AUTHORITY_KEY, VALKEY_TASK_MANAGED_KEY];
    const scriptArgs = [
        ...argv.map(String),
        original?.partition ?? '',
        original?.generation ?? '',
        original?.ownerId ?? '',
        options.allowDraining === false ? '0' : '1',
    ];
    const command = (op: string, body: string): string[] => [
        op,
        body,
        String(scriptKeys.length),
        ...scriptKeys,
        ...scriptArgs,
    ];
    try {
        return await client.customCommand(command('EVALSHA', script.sha));
    } catch (error) {
        if (!isNoScriptError(error)) throw error;
        return client.customCommand(command('EVAL', script.source));
    }
}
