// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { randomBytes, randomInt } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
    cacheGet,
    cacheSet,
    cacheDel,
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey';
import { storeQuickConnectRequest, updateQuickConnectRequest } from './quick-connect-store';
import { authorizeQuickConnectCode } from './quick-connect-authorize';
import { QC_CODE_PREFIX, QC_SECRET_PREFIX } from './quick-connect-utils';

const code = String(randomInt(100000, 1000000));
const secret = randomBytes(16).toString('hex');
const attackerSecret = randomBytes(16).toString('hex');
const keys = [QC_CODE_PREFIX + code, QC_SECRET_PREFIX + secret, QC_SECRET_PREFIX + attackerSecret];
const pending = JSON.stringify({
    code,
    authenticated: false,
    userId: null,
    username: null,
    isAdmin: false,
    groups: [],
    displayName: null,
});
const approver = {
    userId: 'user-id',
    username: 'alice',
    isAdmin: false,
    groups: [],
    displayName: null,
};

beforeAll(async () => {
    expect(await connectValkey()).toBe(true);
    await cacheDel(keys);
});
afterAll(async () => {
    await cacheDel(keys);
    await disconnectValkey();
});

describe('Quick Connect request binding on Valkey', () => {
    it('a simultaneous code collision cannot replace the original secret', async () => {
        const results = await Promise.all([
            storeQuickConnectRequest(code, secret, pending),
            storeQuickConnectRequest(code, attackerSecret, pending),
        ]);
        expect(results.filter(Boolean)).toHaveLength(1);
        const winner = results[0] ? secret : attackerSecret;
        const loser = results[0] ? attackerSecret : secret;
        expect(await cacheGet(QC_CODE_PREFIX + code)).toBe(winner);
        expect(await cacheGet(QC_SECRET_PREFIX + loser)).toBeNull();
        expect(await authorizeQuickConnectCode(code, approver)).toBe('ok');
        expect(JSON.parse((await cacheGet(QC_SECRET_PREFIX + winner))!)).toMatchObject({
            authenticated: true,
            username: 'alice',
        });
        await cacheDel(keys);
    });

    it('rejects a mapping changed while an approval was in flight', async () => {
        await storeQuickConnectRequest(code, secret, pending);
        await cacheSet(QC_CODE_PREFIX + code, attackerSecret, 300);
        expect(
            await updateQuickConnectRequest(code, secret, pending, '{"authenticated":true}'),
        ).toBe(false);
        expect(await cacheGet(QC_SECRET_PREFIX + secret)).toBe(pending);
        await cacheDel(keys);
    });

    it('rejects a secret record with a different stored code', async () => {
        await cacheSet(QC_CODE_PREFIX + code, secret, 300);
        await cacheSet(
            QC_SECRET_PREFIX + secret,
            pending.replace(code, code === '654321' ? '654322' : '654321'),
            300,
        );
        expect(await authorizeQuickConnectCode(code, approver)).toBe('not_found');
        await cacheDel(keys);
    });

    it('a stale approval cannot overwrite the first approver or extend expiry', async () => {
        await storeQuickConnectRequest(code, secret, pending);
        const client = getCoordinationClient()!;
        await client.expire(QC_SECRET_PREFIX + secret, 30);
        expect(await authorizeQuickConnectCode(code, approver)).toBe('ok');
        const ttl = await client.ttl(QC_SECRET_PREFIX + secret);
        expect(ttl).toBeGreaterThan(0);
        expect(ttl).toBeLessThanOrEqual(30);
        expect(
            await updateQuickConnectRequest(code, secret, pending, '{"authenticated":true}'),
        ).toBe(false);
        expect(await authorizeQuickConnectCode(code, approver)).toBe('already_authorized');
    });
});
