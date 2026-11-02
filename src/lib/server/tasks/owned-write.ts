// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AuthorityToken } from '../../../task-runtime/authority/store.js';
import { invokeFencedValkey } from './lua/fenced.js';
import type { ValkeyLike } from './valkey-types.js';

/** Single-key existing task mutations only. The owner check and write execute
 * in one script; callers keep the original runtime token across callbacks. */
export async function invokeOwnedCommand(
    command: string[],
    client: ValkeyLike,
    authority?: AuthorityToken,
): Promise<unknown> {
    const [operation, key, ...args] = command;
    if (!key || !['HSET', 'PEXPIRE', 'SET', 'DEL'].includes(operation))
        throw new Error('Unsupported owned task mutation');
    return invokeFencedValkey(
        'return redis.call(ARGV[1], KEYS[1], unpack(ARGV, 2))',
        [key],
        [operation, ...args],
        client,
        authority,
    );
}
