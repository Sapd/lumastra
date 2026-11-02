// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Device control grants against real Postgres: CRUD, the self/duplicate
 * constraints, cascade on user delete, case-insensitive username lookup, and
 * the per-request access check (`verifyDeviceControlAccess`) that lets a
 * granted helper reach an owner's device and stops the moment the grant goes.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    MAX_GRANTS_PER_OWNER,
    addGrantCapped,
    findUserByUsernameFolded,
    listControllableDevices,
    listDeviceSessionIdsOfUser,
    listGrantsByGrantee,
    listGrantsByOwner,
    removeGrant,
} from './device-control-grants.queries.js';
import { verifyDeviceControlAccess } from '../../api/defs/devices/device-access.js';

const PREFIX = 'itest_grant';

describe('device_control_grants', () => {
    let sql: postgres.Sql;
    let owner: string;
    let helper: string;
    let stranger: string;

    async function makeUser(name: string): Promise<string> {
        const [row] = await sql<
            { id: string }[]
        >`INSERT INTO users (username) VALUES (${`${PREFIX}_${name}`}) RETURNING id`;
        return row.id;
    }

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '\\_%'}`;
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '\\_%'}`;
        owner = await makeUser('Owner');
        helper = await makeUser('Helper');
        stranger = await makeUser('Stranger');
    });

    it('adds, lists by owner and by grantee, and removes', async () => {
        const added = await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
        expect(added.status).toBe('added');
        // A repeat is not new and answers the STORED creation time.
        await new Promise((r) => setTimeout(r, 15));
        const repeat = await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
        expect(repeat.status).toBe('exists');
        expect(repeat.createdAt).toEqual(added.createdAt);

        const byOwner = await listGrantsByOwner.all(sql, { ownerUserId: owner });
        expect(byOwner.map((r) => r.username)).toEqual([`${PREFIX}_Helper`]);
        expect(byOwner[0].created_at).toEqual(added.createdAt);
        const byGrantee = await listGrantsByGrantee.all(sql, { granteeUserId: helper });
        expect(byGrantee.map((r) => r.username)).toEqual([`${PREFIX}_Owner`]);
        // Direction matters.
        expect(await listGrantsByOwner.all(sql, { ownerUserId: helper })).toHaveLength(0);

        expect(
            await removeGrant.execute(sql, { ownerUserId: owner, granteeUserId: helper }),
        ).toHaveLength(1);
        expect(
            await removeGrant.execute(sql, { ownerUserId: owner, granteeUserId: helper }),
        ).toHaveLength(0);
        expect(await listGrantsByOwner.all(sql, { ownerUserId: owner })).toHaveLength(0);
    });

    it('caps the helpers per owner, also under concurrent adds', async () => {
        const extra: string[] = [];
        for (let i = 0; i < MAX_GRANTS_PER_OWNER + 3; i++) extra.push(await makeUser(`Extra${i}`));
        const results = await Promise.all(
            extra.map((granteeUserId) =>
                addGrantCapped(sql, { ownerUserId: owner, granteeUserId }),
            ),
        );
        expect(results.filter((r) => r.status === 'added')).toHaveLength(MAX_GRANTS_PER_OWNER);
        expect(results.filter((r) => r.status === 'limit')).toHaveLength(3);
        const [{ n }] = await sql<
            { n: number }[]
        >`SELECT count(*)::int AS n FROM device_control_grants WHERE owner_user_id = ${owner}::uuid`;
        expect(n).toBe(MAX_GRANTS_PER_OWNER);
        // At the cap, an existing helper is still "exists", not "limit".
        const granted = results.findIndex((r) => r.status === 'added');
        expect(
            (await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: extra[granted] }))
                .status,
        ).toBe('exists');
        // Another owner is not affected.
        expect(
            (await addGrantCapped(sql, { ownerUserId: stranger, granteeUserId: owner })).status,
        ).toBe('added');
    });

    it('lists skip owners and helpers that are soft-deleted or disabled', async () => {
        await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
        await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: stranger });
        await addGrantCapped(sql, { ownerUserId: stranger, granteeUserId: helper });

        await sql`UPDATE users SET deleted_at = now() WHERE id = ${helper}::uuid`;
        expect(
            (await listGrantsByOwner.all(sql, { ownerUserId: owner })).map((r) => r.user_id),
        ).toEqual([stranger]);
        await sql`UPDATE users SET deleted_at = NULL WHERE id = ${helper}::uuid`;

        await sql`UPDATE users SET disabled_at = now() WHERE id = ${stranger}::uuid`;
        expect(
            (await listGrantsByOwner.all(sql, { ownerUserId: owner })).map((r) => r.user_id),
        ).toEqual([helper]);
        // The helper's own list no longer shows the disabled owner either.
        expect(await listGrantsByGrantee.all(sql, { granteeUserId: helper })).toHaveLength(1);
        await sql`UPDATE users SET disabled_at = NULL WHERE id = ${stranger}::uuid`;
        expect(await listGrantsByGrantee.all(sql, { granteeUserId: helper })).toHaveLength(2);
    });

    it('refuses a grant to yourself', async () => {
        await expect(
            addGrantCapped(sql, { ownerUserId: owner, granteeUserId: owner }),
        ).rejects.toThrow();
    });

    it('deleting either user removes the grant', async () => {
        await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
        await addGrantCapped(sql, { ownerUserId: stranger, granteeUserId: helper });
        await sql`DELETE FROM users WHERE id = ${stranger}::uuid`;
        expect(await listGrantsByGrantee.all(sql, { granteeUserId: helper })).toHaveLength(1);
        await sql`DELETE FROM users WHERE id = ${helper}::uuid`;
        expect(await listGrantsByOwner.all(sql, { ownerUserId: owner })).toHaveLength(0);
    });

    it('finds a user by username ignoring case, and skips soft-deleted users', async () => {
        expect((await findUserByUsernameFolded(sql, `${PREFIX}_HELPER`.toUpperCase()))?.id).toBe(
            helper,
        );
        expect(await findUserByUsernameFolded(sql, `${PREFIX}_nobody`)).toBeNull();
        expect(await findUserByUsernameFolded(sql, '   ')).toBeNull();
        await sql`UPDATE users SET deleted_at = now() WHERE id = ${helper}::uuid`;
        expect(await findUserByUsernameFolded(sql, `${PREFIX}_Helper`)).toBeNull();
    });

    it('does not find a disabled user, and picks the same one every time', async () => {
        await sql`UPDATE users SET disabled_at = now() WHERE id = ${helper}::uuid`;
        expect(await findUserByUsernameFolded(sql, `${PREFIX}_Helper`)).toBeNull();
        await sql`UPDATE users SET disabled_at = NULL WHERE id = ${helper}::uuid`;
        for (let i = 0; i < 3; i++) {
            expect((await findUserByUsernameFolded(sql, `${PREFIX}_helper`))?.id).toBe(helper);
        }
    });

    describe('verifyDeviceControlAccess', () => {
        async function makeDevice(userId: string, deviceSessionId: string, name: string) {
            await sql`
                INSERT INTO oauth_refresh_tokens (user_id, client_id, token_hash, device_id, device_session_id, device_name, created_at, expires_at)
                VALUES (${userId}::uuid, 'itest-client', ${`hash-${deviceSessionId}`}, ${`dev-${deviceSessionId}`},
                        ${deviceSessionId}, ${name}, NOW(), NOW() + INTERVAL '30 days')
            `;
        }

        it('answers the owner, a granted helper, and nobody else', async () => {
            await makeDevice(owner, `${PREFIX}-tv`, 'Living Room');

            const own = await verifyDeviceControlAccess(`${PREFIX}-tv`, owner);
            expect(own).toMatchObject({
                viaGrant: false,
                ownerUserId: owner,
                deviceName: 'Living Room',
            });

            // No grant yet: indistinguishable from an unknown device.
            expect(await verifyDeviceControlAccess(`${PREFIX}-tv`, helper)).toBeNull();

            await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
            const viaGrant = await verifyDeviceControlAccess(`${PREFIX}-tv`, helper);
            expect(viaGrant).toMatchObject({
                viaGrant: true,
                ownerUserId: owner,
                ownerUsername: `${PREFIX}_Owner`,
            });
            // The grant is one-way and per owner.
            expect(await verifyDeviceControlAccess(`${PREFIX}-tv`, stranger)).toBeNull();
            await makeDevice(helper, `${PREFIX}-phone`, 'Phone');
            expect(await verifyDeviceControlAccess(`${PREFIX}-phone`, owner)).toBeNull();

            // Revoked: takes effect on the very next check.
            await removeGrant.execute(sql, { ownerUserId: owner, granteeUserId: helper });
            expect(await verifyDeviceControlAccess(`${PREFIX}-tv`, helper)).toBeNull();
        });

        it('a deleted or disabled owner or helper is not controllable', async () => {
            await makeDevice(owner, `${PREFIX}-gone`, 'Gone TV');
            await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
            expect(await verifyDeviceControlAccess(`${PREFIX}-gone`, helper)).not.toBeNull();

            await sql`UPDATE users SET deleted_at = now() WHERE id = ${owner}::uuid`;
            expect(await verifyDeviceControlAccess(`${PREFIX}-gone`, helper)).toBeNull();
            await sql`UPDATE users SET deleted_at = NULL WHERE id = ${owner}::uuid`;

            await sql`UPDATE users SET disabled_at = now() WHERE id = ${owner}::uuid`;
            expect(await verifyDeviceControlAccess(`${PREFIX}-gone`, helper)).toBeNull();
            await sql`UPDATE users SET disabled_at = NULL WHERE id = ${owner}::uuid`;

            await sql`UPDATE users SET deleted_at = now() WHERE id = ${helper}::uuid`;
            expect(await verifyDeviceControlAccess(`${PREFIX}-gone`, helper)).toBeNull();
            await sql`UPDATE users SET deleted_at = NULL WHERE id = ${helper}::uuid`;

            expect(await verifyDeviceControlAccess(`${PREFIX}-gone`, helper)).not.toBeNull();
        });

        it('does not reach a revoked device session', async () => {
            await makeDevice(owner, `${PREFIX}-old`, 'Old TV');
            await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
            await sql`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE device_session_id = ${`${PREFIX}-old`}`;
            expect(await verifyDeviceControlAccess(`${PREFIX}-old`, helper)).toBeNull();
            expect(await verifyDeviceControlAccess(`${PREFIX}-old`, owner)).toBeNull();
        });
    });

    describe('listControllableDevices / listDeviceSessionIdsOfUser', () => {
        async function makeDevice(userId: string, deviceSessionId: string, name: string) {
            await sql`
                INSERT INTO oauth_refresh_tokens (user_id, client_id, token_hash, device_id, device_session_id, device_name, created_at, expires_at)
                VALUES (${userId}::uuid, 'itest-client', ${`hash-${deviceSessionId}`}, ${`dev-${deviceSessionId}`},
                        ${deviceSessionId}, ${name}, NOW(), NOW() + INTERVAL '30 days')
            `;
        }

        it('returns every live device of every granting owner in one query, and nobody else’s', async () => {
            await makeDevice(owner, `${PREFIX}-tv1`, 'TV 1');
            await makeDevice(owner, `${PREFIX}-tv2`, 'TV 2');
            await makeDevice(stranger, `${PREFIX}-radio`, 'Radio');
            await makeDevice(helper, `${PREFIX}-mine`, 'Mine');
            await addGrantCapped(sql, { ownerUserId: owner, granteeUserId: helper });
            await addGrantCapped(sql, { ownerUserId: stranger, granteeUserId: helper });
            await sql`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE device_session_id = ${`${PREFIX}-tv2`}`;

            const rows = await listControllableDevices.all(sql, { granteeUserId: helper });
            expect(rows.map((r) => r.device_session_id).sort()).toEqual([
                `${PREFIX}-radio`,
                `${PREFIX}-tv1`,
            ]);
            expect(rows.find((r) => r.device_session_id === `${PREFIX}-tv1`)).toMatchObject({
                device_name: 'TV 1',
                owner_username: `${PREFIX}_Owner`,
            });

            // A deleted owner's devices drop out.
            await sql`UPDATE users SET deleted_at = now() WHERE id = ${stranger}::uuid`;
            expect(
                (await listControllableDevices.all(sql, { granteeUserId: helper })).map(
                    (r) => r.device_session_id,
                ),
            ).toEqual([`${PREFIX}-tv1`]);
            // Revoked grant: nothing.
            await removeGrant.execute(sql, { ownerUserId: owner, granteeUserId: helper });
            expect(await listControllableDevices.all(sql, { granteeUserId: helper })).toEqual([]);
        });

        it('lists a user’s live device sessions once each', async () => {
            await makeDevice(owner, `${PREFIX}-a`, 'A');
            await makeDevice(owner, `${PREFIX}-b`, 'B');
            await sql`UPDATE oauth_refresh_tokens SET revoked_at = now() WHERE device_session_id = ${`${PREFIX}-b`}`;
            expect(
                (await listDeviceSessionIdsOfUser.all(sql, { userId: owner })).map(
                    (r) => r.device_session_id,
                ),
            ).toEqual([`${PREFIX}-a`]);
        });
    });
});
