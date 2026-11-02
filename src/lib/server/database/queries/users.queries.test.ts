// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import {
    collisionSafeUserIdMap,
    createNativeAdmin,
    resolveUsernamesToUsers,
} from './users.queries.js';
import type postgres from 'postgres';

const U1 = '11111111-1111-1111-1111-111111111111';
const U2 = '22222222-2222-2222-2222-222222222222';
const U3 = '33333333-3333-3333-3333-333333333333';

/**
 * Mock a top-level `sql` handle whose `.begin(cb)` runs `cb` against a single
 * `tx` tagged-template mock — every statement inside the transaction lands on
 * the SAME mock, mirroring how postgres-js pins a transaction to one
 * connection. `txResults` supplies the resolved value for each successive
 * statement (in call order): index 0 = the advisory-lock SELECT, index 1 =
 * the INSERT.
 */
function makeAdvisoryLockSql(txResults: unknown[]) {
    const calls: unknown[][] = [];
    let callIndex = 0;
    const tx = vi.fn((...args: unknown[]) => {
        calls.push(args);
        const result = txResults[callIndex];
        callIndex += 1;
        return Promise.resolve(result);
    }) as unknown as postgres.Sql;

    const sql = vi.fn() as unknown as postgres.Sql;
    (sql as unknown as Record<string, unknown>).begin = vi.fn(
        async (cb: (tx: postgres.Sql) => unknown) => cb(tx),
    );

    return { sql, tx, calls };
}

describe('collisionSafeUserIdMap', () => {
    it('maps each unique provider name to its user id', () => {
        const { map, collisions } = collisionSafeUserIdMap([
            { id: U1, jellyfin_name: 'alice' },
            { id: U2, jellyfin_name: 'bob' },
        ]);
        expect(map.get('alice')).toBe(U1);
        expect(map.get('bob')).toBe(U2);
        expect(collisions).toEqual([]);
    });

    it('EXCLUDES all entries that share a provider name (never last-write-wins)', () => {
        // Two distinct Lumastra users resolve to the same Jellyfin name (e.g.
        // 'Alice' + 'alice', or one user overriding jellyfin_username='alice').
        // Attributing one user's history to the other would be silent corruption,
        // so neither is resolved until an operator disambiguates.
        const { map, collisions } = collisionSafeUserIdMap([
            { id: U1, jellyfin_name: 'alice' },
            { id: U2, jellyfin_name: 'alice' },
            { id: U3, jellyfin_name: 'carol' },
        ]);
        expect(map.has('alice')).toBe(false);
        expect(map.get('carol')).toBe(U3);
        expect(collisions).toEqual(['alice']);
    });

    it('reports each colliding name once even with 3+ collisions', () => {
        const { map, collisions } = collisionSafeUserIdMap([
            { id: U1, jellyfin_name: 'dup' },
            { id: U2, jellyfin_name: 'dup' },
            { id: U3, jellyfin_name: 'dup' },
        ]);
        expect(map.size).toBe(0);
        expect(collisions).toEqual(['dup']);
    });

    it('handles an empty input', () => {
        const { map, collisions } = collisionSafeUserIdMap([]);
        expect(map.size).toBe(0);
        expect(collisions).toEqual([]);
    });
});

describe('resolveUsernamesToUsers', () => {
    it('fails closed for Unicode-equivalent local usernames', async () => {
        const sql = vi.fn(async () => [
            { id: U1, username: 'Fjörn' },
            { id: U2, username: 'Fjörn' },
            { id: U3, username: 'Marc' },
        ]) as unknown as postgres.Sql;

        const users = await resolveUsernamesToUsers(sql);

        expect(users.has('fjörn')).toBe(false);
        expect(users.get('marc')).toEqual({ id: U3, username: 'Marc' });
        const query = String((sql as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]);
        expect(query).toContain('disabled_at IS NULL');
        expect(query).toContain('deleted_at IS NULL');
    });

    it('filters requested names using the same canonical fold', async () => {
        const sql = vi.fn(async () => [
            { id: U1, username: 'Fjörn' },
            { id: U2, username: 'Marc' },
        ]) as unknown as postgres.Sql;

        const users = await resolveUsernamesToUsers(sql, ['Fjörn']);

        expect([...users.keys()]).toEqual(['fjörn']);
    });
});

describe('createNativeAdmin', () => {
    it('runs the advisory-lock acquire, the in-lock admin-existence check, and the insert on the SAME transaction-pinned connection', async () => {
        // C5 fix round 3 (controller ruling): the in-lock re-check
        // (`setupGateAdminExists()`) is now ONE statement — a single SELECT
        // returning `{cap, gnames, inapp}` in one READ COMMITTED snapshot
        // (fix round 2's version split this into 3 separate statements,
        // itself a bug the round-3 finding closed). Call order, all on
        // `tx`: (1) advisory lock, (2) the single admin-existence SELECT —
        // `cap: false` (no column/capability admin) and both name arrays
        // empty here, so `hasGroupPermission()` is never even reached (no
        // candidates), (3) the INSERT itself, and (4) the setup-lock write
        // (ruling S-C5c-2) in the same transaction.
        const { sql, tx, calls } = makeAdvisoryLockSql([
            undefined, // (1) lock acquire
            [{ locked: false, cap: false, gnames: [], inapp: [] }], // (2) the one admin-existence SELECT
            [{ id: 'new-admin-id' }], // (3) the INSERT itself
            [], // (4) the setup-lock INSERT
        ]);

        const id = await createNativeAdmin(sql, {
            username: 'Admin',
            passwordHash: 'hash',
            groups: ['admin'],
            adminGroupNames: ['admin'],
        });

        expect(id).toBe('new-admin-id');
        expect(sql.begin).toHaveBeenCalledOnce();
        // All four calls ran on `tx`, never a second, unpinned connection —
        // otherwise the lock wouldn't actually serialize the check-and-insert.
        expect(tx).toHaveBeenCalledTimes(4);
        expect(calls).toHaveLength(4);
        expect(String(calls[0][0])).toContain('pg_advisory_xact_lock');
        expect(String(calls[3][0])).toContain('INSERT INTO setup_lock');
        expect(calls[3][1]).toBe('new-admin-id');
    });

    it('returns null without inserting when the setup lock row exists, even with a blank adminGroupNames and no admin (S-C5c-2)', async () => {
        // The lock term is checked before the blank-ADMIN_GROUPS throw: a
        // completed install stays "set up" with no admin and a blank config.
        const { sql, tx } = makeAdvisoryLockSql([
            undefined, // (1) lock acquire
            [{ locked: true, cap: false, gnames: [], inapp: [] }], // (2) locked, no admin
        ]);

        const id = await createNativeAdmin(sql, {
            username: 'admin-locked',
            passwordHash: 'hash',
            groups: [],
            adminGroupNames: ['', '   '],
        });

        expect(id).toBeNull();
        expect(tx).toHaveBeenCalledTimes(2);
    });

    it('returns null without inserting when the in-lock check finds a column/capability admin (lock loser)', async () => {
        // The one admin-existence SELECT alone (call 2) already finds an
        // admin via `cap: true`, so setupGateAdminExists() short-circuits —
        // the INSERT is never reached. Only 2 calls total.
        const { sql, tx } = makeAdvisoryLockSql([
            undefined, // (1) lock acquire
            [{ cap: true, gnames: [], inapp: [] }], // (2) an admin exists via column/capability
        ]);

        const id = await createNativeAdmin(sql, {
            username: 'admin2',
            passwordHash: 'hash',
            groups: ['admin'],
            adminGroupNames: ['admin'],
        });

        expect(id).toBeNull();
        expect(tx).toHaveBeenCalledTimes(2);
    });

    it('returns null without inserting when the in-lock check finds a NAME-only admin (lock loser, name axis)', async () => {
        // `cap: false` but a candidate NAME matches adminGroupNames via
        // hasGroupPermission() — proves the name-axis short-circuit (not
        // just the capability/column axis) also skips the INSERT.
        const { sql, tx } = makeAdvisoryLockSql([
            undefined, // (1) lock acquire
            [{ cap: false, gnames: ['admin'], inapp: [] }], // (2) a name-only admin
        ]);

        const id = await createNativeAdmin(sql, {
            username: 'admin3',
            passwordHash: 'hash',
            groups: ['admin'],
            adminGroupNames: ['admin'],
        });

        expect(id).toBeNull();
        expect(tx).toHaveBeenCalledTimes(2);
    });

    it('throws for a blank adminGroupNames only AFTER the admin-existence read finds no column/capability admin (fail-closed, C5 fix round 4)', async () => {
        // Fix round 4: the blank-config throw runs after the one SELECT, not
        // before it — so the lock and the read both run, then it throws and
        // the INSERT is never reached.
        const { sql, tx } = makeAdvisoryLockSql([
            undefined, // (1) lock acquire
            [{ cap: false, gnames: ['admin'], inapp: [] }], // (2) no column/capability admin
        ]);

        await expect(
            createNativeAdmin(sql, {
                username: 'admin4',
                passwordHash: 'hash',
                groups: [],
                adminGroupNames: ['', '   '],
            }),
        ).rejects.toThrow('ADMIN_GROUPS is empty; the first-run setup gate cannot be evaluated');
        expect(tx).toHaveBeenCalledTimes(2);
    });

    it('returns null (no throw) for a blank adminGroupNames when the read finds a column/capability admin (C5 fix round 4)', async () => {
        // An installed instance with a blank ADMIN_GROUPS: `cap: true` is the
        // exact answer (a blank config's name axis is empty), so no throw and
        // no INSERT.
        const { sql, tx } = makeAdvisoryLockSql([
            undefined, // (1) lock acquire
            [{ cap: true, gnames: [], inapp: [] }], // (2) a column/capability admin exists
        ]);

        const id = await createNativeAdmin(sql, {
            username: 'admin5',
            passwordHash: 'hash',
            groups: [],
            adminGroupNames: ['', '   '],
        });

        expect(id).toBeNull();
        expect(tx).toHaveBeenCalledTimes(2);
    });
});
