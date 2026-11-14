// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { getCoordinationClient } from '$lib/server/cache/valkey';
import { QC_CODE_PREFIX, QC_SECRET_PREFIX, QC_TTL_SECONDS } from './quick-connect-utils';

/** Atomically reserve a code and store its secret, without replacing another request. */
export async function storeQuickConnectRequest(
    code: string,
    secret: string,
    data: string,
): Promise<boolean> {
    const client = getCoordinationClient();
    if (!client) throw new Error('Quick Connect storage unavailable');
    const result = await client.customCommand([
        'EVAL',
        `if redis.call('exists', KEYS[1]) == 1 or redis.call('exists', KEYS[2]) == 1 then
            return 0
        end
        redis.call('set', KEYS[1], ARGV[1], 'EX', ARGV[3])
        redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
        return 1`,
        '2',
        QC_CODE_PREFIX + code,
        QC_SECRET_PREFIX + secret,
        secret,
        data,
        String(QC_TTL_SECONDS),
    ]);
    return result === 1 || result === '1';
}

/** Approve only the exact request read by the caller; preserve its expiry window. */
export async function updateQuickConnectRequest(
    code: string,
    secret: string,
    original: string,
    updated: string,
): Promise<boolean> {
    const client = getCoordinationClient();
    if (!client) return false;
    const result = await client.customCommand([
        'EVAL',
        `if redis.call('get', KEYS[1]) ~= ARGV[1] or
            redis.call('get', KEYS[2]) ~= ARGV[2] then return 0 end
        redis.call('set', KEYS[2], ARGV[3], 'KEEPTTL')
        return 1`,
        '2',
        QC_CODE_PREFIX + code,
        QC_SECRET_PREFIX + secret,
        secret,
        original,
        updated,
    ]);
    return result === 1 || result === '1';
}
