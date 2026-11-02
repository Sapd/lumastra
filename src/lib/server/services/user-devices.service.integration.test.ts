// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the device registry.
 *
 * These exist because of a specific failure this subsystem already had: three
 * different things were called `device_name`, and each read site picked a
 * different one, so the same device showed a different name on every screen and
 * a Jellyfin credential string leaked into the UI as if it were a label. Type
 * checking cannot see any of that — the columns are strings either way, and the
 * SQL lives in template literals. So the invariants are asserted here instead.
 *
 * Each test names the bug it prevents.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../tests/integration/fixtures/index.js';
import type { UserId } from '$lib/shared/user-id.js';

import {
    reportDeviceName,
    resolveExistingDeviceSession,
    getUserDevices,
    normalizeDeviceName,
    MAX_DEVICE_NAME_LENGTH,
} from './user-devices.service.js';
import {
    getUserDeviceByDeviceId,
    setUserDeviceCustomName,
} from '$lib/server/database/queries/user-devices.queries.js';
import { createRefreshToken } from '$lib/server/database/queries/oauth-refresh-tokens.queries.js';

describe('Device registry (integration)', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'oauth_refresh_tokens',
            'user_provider_device_tokens',
            'user_devices',
        ]);
    });

    /** Create a user with an OAuth session bound to `deviceId`. */
    async function seedSession(opts: {
        deviceId: string | null;
        deviceName?: string | null;
        deviceSessionId?: string;
    }): Promise<{ userId: UserId; deviceSessionId: string }> {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const deviceSessionId = opts.deviceSessionId ?? crypto.randomUUID();
        await createRefreshToken(sql, {
            tokenHash: `hash_${crypto.randomUUID()}`,
            userId,
            clientId: 'stellar-tvos',
            scope: 'openid',
            deviceName: opts.deviceName ?? null,
            groups: ['users'],
            jellyfinUserId: null,
            expiresAt: new Date(Date.now() + 86_400_000),
            deviceSessionId,
            deviceId: opts.deviceId,
        });
        return { userId, deviceSessionId };
    }

    // -----------------------------------------------------------------------
    // Schema — proves the migration actually ran.
    //
    // The migration was silently dropped from the MIGRATIONS array once (a
    // concurrent change removed the registration because the file was still
    // untracked). Everything downstream then failed in confusing ways. Assert
    // the schema exists so that failure reports itself directly.
    // -----------------------------------------------------------------------
    describe('schema', () => {
        it('user_devices exists with the columns the read model depends on', async () => {
            const cols = await sql<{ column_name: string }[]>`
                SELECT column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'user_devices'
            `;
            const names = cols.map((c) => c.column_name);
            expect(names).toEqual(
                expect.arrayContaining([
                    'user_id',
                    'device_id',
                    'reported_name',
                    'custom_name',
                    'last_seen_at',
                ]),
            );
        });

        it('the overloaded device_name column was split apart', async () => {
            const cols = await sql<{ table_name: string; column_name: string }[]>`
                SELECT table_name, column_name FROM information_schema.columns
                WHERE table_schema = 'public'
                  AND ((table_name = 'play_sessions' AND column_name IN ('device_name', 'user_agent'))
                    OR (table_name = 'user_provider_device_tokens'
                        AND column_name IN ('device_name', 'provider_device_binding')))
            `;
            const key = cols.map((c) => `${c.table_name}.${c.column_name}`).sort();
            expect(key).toEqual([
                'play_sessions.user_agent',
                'user_provider_device_tokens.provider_device_binding',
            ]);
        });
    });

    // -----------------------------------------------------------------------
    // Name resolution — the bug that started all of this.
    // -----------------------------------------------------------------------
    describe('display name resolution', () => {
        it('a user-chosen name beats the name the client reported', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });

            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'oauth-device-flow',
            });
            await setUserDeviceCustomName(sql, userId, 'dev-1', 'Wohnzimmer');

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceName).toBe('Wohnzimmer');
            expect(device.isCustomName).toBe(true);
        });

        it('a later client report does NOT clobber the name the user chose', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            // The row must exist before it can carry an override.
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'oauth-device-flow',
            });
            await setUserDeviceCustomName(sql, userId, 'dev-1', 'Wohnzimmer');

            // Simulates the heartbeat firing every 5 minutes forever.
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'heartbeat',
            });

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceName).toBe('Wohnzimmer');

            // ...and the reported name is still recorded underneath it.
            const row = await getUserDeviceByDeviceId(sql, userId, 'dev-1');
            expect(row?.reported_name).toBe('Apple TV');
        });

        it('a client that reports no name does not erase the stored one', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'oauth-device-flow',
            });

            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: null,
                source: 'play-session',
            });

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceName).toBe('Apple TV');
        });

        it('renaming the device is reflected without re-login', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1', deviceName: 'Apple TV' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'oauth-device-flow',
            });

            // The user renames the TV; the next heartbeat reports the new name.
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Fernseher im Wohnzimmer',
                source: 'heartbeat',
            });

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceName).toBe('Fernseher im Wohnzimmer');
        });

        it('NEVER surfaces the Jellyfin credential string as a display name', async () => {
            // This is the regression that motivated the refactor: the provider
            // token row stores "${APP_NAME} - ${name}" because Jellyfin binds the
            // token to that exact string, and every device list used to read it
            // first — so users saw "Lumastra - Wohnzimmer" as their device name.
            const { userId, deviceSessionId } = await seedSession({ deviceId: 'dev-1' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Wohnzimmer',
                source: 'oauth-device-flow',
            });

            await sql`
                INSERT INTO user_provider_device_tokens (
                    user_id, provider_user_id, device_session_id,
                    provider_device_binding, provider_access_token, device_id
                ) VALUES (
                    ${userId}::uuid, 'jf-user', ${deviceSessionId},
                    'Lumastra - Wohnzimmer', 'secret-token', 'dev-1'
                )
            `;

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceName).toBe('Wohnzimmer');
            expect(device.deviceName).not.toContain('Lumastra - ');
        });
    });

    // -----------------------------------------------------------------------
    // Jellyfin independence. Jellyfin is optional; the device list must not
    // change shape or content depending on whether it is installed.
    // -----------------------------------------------------------------------
    describe('independence from Jellyfin', () => {
        it('returns an identical list with and without a provider token row', async () => {
            const { userId, deviceSessionId } = await seedSession({ deviceId: 'dev-1' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Wohnzimmer',
                source: 'oauth-device-flow',
            });

            const without = await getUserDevices(sql, userId);

            await sql`
                INSERT INTO user_provider_device_tokens (
                    user_id, provider_user_id, device_session_id,
                    provider_device_binding, provider_access_token, device_id
                ) VALUES (
                    ${userId}::uuid, 'jf-user', ${deviceSessionId},
                    'Lumastra - Wohnzimmer', 'secret-token', 'dev-1'
                )
            `;

            const withJellyfin = await getUserDevices(sql, userId);
            expect(withJellyfin).toEqual(without);
        });

        it('reuses the existing device session on re-login with no Jellyfin row present', async () => {
            // The phantom-device bug: session reuse used to resolve through the
            // Jellyfin token table, which is empty when Jellyfin sync is off, so
            // every login on a default install minted a new session and the
            // device list grew an entry each time.
            const { userId, deviceSessionId } = await seedSession({ deviceId: 'dev-1' });

            const reused = await resolveExistingDeviceSession(sql, userId, 'dev-1');
            expect(reused).toBe(deviceSessionId);
        });

        it('returns null for a device that has never been seen', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            expect(await resolveExistingDeviceSession(sql, userId, 'unknown-device')).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // User scoping. device_id is client-supplied free text.
    // -----------------------------------------------------------------------
    describe('user scoping', () => {
        it('two users may hold the same device_id without colliding', async () => {
            // Browsers share localStorage between accounts on one machine, so the
            // same device_id legitimately appears under two users.
            const a = await seedSession({ deviceId: 'shared-device' });
            const b = await seedSession({ deviceId: 'shared-device' });

            await reportDeviceName(sql, {
                userId: a.userId,
                deviceId: 'shared-device',
                name: 'Alice Laptop',
                source: 'play-session',
            });
            await reportDeviceName(sql, {
                userId: b.userId,
                deviceId: 'shared-device',
                name: 'Bob Laptop',
                source: 'play-session',
            });

            const [devA] = await getUserDevices(sql, a.userId);
            const [devB] = await getUserDevices(sql, b.userId);
            expect(devA.deviceName).toBe('Alice Laptop');
            expect(devB.deviceName).toBe('Bob Laptop');
        });

        it('does not leak another user’s device by claiming their device_id', async () => {
            const victim = await seedSession({ deviceId: 'victim-device' });
            await reportDeviceName(sql, {
                userId: victim.userId,
                deviceId: 'victim-device',
                name: 'Victim Bedroom TV',
                source: 'play-session',
            });

            const attacker = generateTestUserId();
            await ensureTestUser(sql, attacker);
            const stolen = await getUserDeviceByDeviceId(sql, attacker, 'victim-device');
            expect(stolen).toBeNull();
        });

        it('two distinct device ids under one user yield two device rows', async () => {
            // The core-side complement of the /j per-device identity fix: two
            // Jellyfin clients (Infuse, Streamyfin) report distinct DeviceIds and
            // must not collapse into one row. Asserted here against the registry
            // rather than through /j, so this file imports no proprietary code.
            const { userId } = await seedSession({ deviceId: 'infuse-abc' });

            await reportDeviceName(sql, {
                userId,
                deviceId: 'infuse-abc',
                name: 'Wohnzimmer',
                clientId: 'Infuse',
                source: 'play-session',
            });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'streamyfin-xyz',
                name: 'Pixel',
                clientId: 'Streamyfin',
                source: 'play-session',
            });

            const rows = await sql<{ device_id: string; reported_name: string }[]>`
                SELECT device_id, reported_name FROM user_devices
                WHERE user_id = ${userId}::uuid ORDER BY device_id
            `;
            expect(rows).toHaveLength(2);
            expect(rows.map((r) => r.reported_name)).toEqual(['Wohnzimmer', 'Pixel']);
        });

        it('clearing the override falls back to the client-reported name', async () => {
            // The undo path. Without it a rename would be a one-way door: the user
            // could never get back to whatever the device calls itself.
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'oauth-device-flow',
            });
            await setUserDeviceCustomName(sql, userId, 'dev-1', 'Wohnzimmer');
            expect((await getUserDevices(sql, userId))[0].deviceName).toBe('Wohnzimmer');

            await setUserDeviceCustomName(sql, userId, 'dev-1', null);

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceName).toBe('Apple TV');
            expect(device.isCustomName).toBe(false);
        });

        it('one user cannot rename another user’s device', async () => {
            const victim = await seedSession({ deviceId: 'victim-device' });
            await reportDeviceName(sql, {
                userId: victim.userId,
                deviceId: 'victim-device',
                name: 'Victim TV',
                source: 'play-session',
            });

            const attacker = generateTestUserId();
            await ensureTestUser(sql, attacker);
            // Same device_id, different user — the UPDATE is user-scoped, so it
            // must match nothing rather than rename someone else's device.
            const result = await setUserDeviceCustomName(sql, attacker, 'victim-device', 'Pwned');
            expect(result).toBeNull();

            const [victimDevice] = await getUserDevices(sql, victim.userId);
            expect(victimDevice.deviceName).toBe('Victim TV');
        });

        it('a user’s list contains only their own devices', async () => {
            const a = await seedSession({ deviceId: 'a-device' });
            await seedSession({ deviceId: 'b-device' });

            const list = await getUserDevices(sql, a.userId);
            expect(list).toHaveLength(1);
            expect(list[0].deviceId).toBe('a-device');
        });
    });

    // -----------------------------------------------------------------------
    // Sessions without a device_id must not break the list.
    // -----------------------------------------------------------------------
    describe('sessions with no device_id', () => {
        it('still lists the session, falling back to the name on the token', async () => {
            const { userId } = await seedSession({ deviceId: null, deviceName: 'Legacy Client' });

            const [device] = await getUserDevices(sql, userId);
            expect(device.deviceId).toBeNull();
            expect(device.deviceName).toBe('Legacy Client');
            expect(device.isCustomName).toBe(false);
        });

        it('reportDeviceName is a no-op for an empty device id', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const result = await reportDeviceName(sql, {
                userId,
                deviceId: '',
                name: 'Nowhere',
                source: 'heartbeat',
            });
            expect(result).toBeNull();
        });
    });

    // -----------------------------------------------------------------------
    // Normalisation. Pure, but asserted here so the boundary rules stay next to
    // the surface that depends on them.
    // -----------------------------------------------------------------------
    describe('name normalisation', () => {
        it('collapses whitespace and trims', () => {
            expect(normalizeDeviceName('  Wohnzimmer   TV  ')).toBe('Wohnzimmer TV');
        });

        it('returns null for input that normalises away, so nothing renders blank', () => {
            expect(normalizeDeviceName('   ')).toBeNull();
            expect(normalizeDeviceName('')).toBeNull();
            expect(normalizeDeviceName(null)).toBeNull();
            expect(normalizeDeviceName(undefined)).toBeNull();
        });

        it('strips bidi overrides — a device list is where impersonation pays off', () => {
            const spoofed = normalizeDeviceName('Wohn‮zimmer');
            expect(spoofed).not.toContain('‮');
        });

        it('strips zero-width padding that would make two devices render alike', () => {
            expect(normalizeDeviceName('Wohn​zimmer')).toBe('Wohnzimmer');
        });

        it('strips control characters', () => {
            expect(normalizeDeviceName('Wohn zimmer')).toBe('Wohnzimmer');
        });

        it('caps length', () => {
            const long = 'A'.repeat(500);
            expect(normalizeDeviceName(long)!.length).toBeLessThanOrEqual(
                MAX_DEVICE_NAME_LENGTH + 1, // sanitiser appends an ellipsis when it truncates
            );
        });

        it('keeps unicode and emoji intact', () => {
            expect(normalizeDeviceName('Wohnzimmer 📺')).toBe('Wohnzimmer 📺');
            expect(normalizeDeviceName('Küche')).toBe('Küche');
        });

        it('normalises on the way in, so stored names are already clean', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: '  Wohn​zimmer   ',
                source: 'heartbeat',
            });
            const row = await getUserDeviceByDeviceId(sql, userId, 'dev-1');
            expect(row?.reported_name).toBe('Wohnzimmer');
        });
    });

    // -----------------------------------------------------------------------
    // Repeated reports. The heartbeat calls this every few minutes per device.
    // -----------------------------------------------------------------------
    describe('repeated reports', () => {
        it('does not create duplicate rows for the same device', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            for (let i = 0; i < 5; i++) {
                await reportDeviceName(sql, {
                    userId,
                    deviceId: 'dev-1',
                    name: 'Apple TV',
                    source: 'heartbeat',
                });
            }
            const rows = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM user_devices WHERE user_id = ${userId}::uuid
            `;
            expect(rows[0].count).toBe('1');
        });

        it('concurrent reports for one device still yield a single row', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            await Promise.all(
                Array.from({ length: 8 }, () =>
                    reportDeviceName(sql, {
                        userId,
                        deviceId: 'dev-1',
                        name: 'Apple TV',
                        source: 'heartbeat',
                    }),
                ),
            );
            const rows = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM user_devices WHERE user_id = ${userId}::uuid
            `;
            expect(rows[0].count).toBe('1');
        });

        it('advances last_seen_at', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            const first = await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'heartbeat',
            });
            await new Promise((r) => setTimeout(r, 15));
            const second = await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                source: 'heartbeat',
            });
            expect(new Date(second!.last_seen_at).getTime()).toBeGreaterThan(
                new Date(first!.last_seen_at).getTime(),
            );
            // first_seen_at is the identity of the device and must not move.
            expect(new Date(second!.first_seen_at).getTime()).toBe(
                new Date(first!.first_seen_at).getTime(),
            );
        });
    });

    // -----------------------------------------------------------------------
    // Last active. /settings/sessions showed "Last active Never" for every
    // device: it read last_used_at off the live refresh token, which rotation
    // replaces at the very moment it would have been marked used.
    // -----------------------------------------------------------------------
    describe('last active', () => {
        it('a live session never reads as "never used"', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            const [device] = await getUserDevices(sql, userId);
            expect(device.lastUsedAt).not.toBeNull();
        });

        it('a heartbeat after sign-in moves last active forward', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            const [before] = await getUserDevices(sql, userId);
            await new Promise((r) => setTimeout(r, 15));
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Apple TV',
                deviceType: 'tv',
                source: 'heartbeat',
            });
            const [after] = await getUserDevices(sql, userId);
            expect(new Date(after.lastUsedAt!).getTime()).toBeGreaterThan(
                new Date(before.lastUsedAt!).getTime(),
            );
            // The stored type drives the row icon while the device is offline.
            expect(after.deviceType).toBe('tv');
        });
    });

    // -----------------------------------------------------------------------
    // Erasure. Device names are personal data — "Wohnzimmer" names a room in
    // the subject's home. This was missing from the erasure registry.
    // -----------------------------------------------------------------------
    describe('erasure', () => {
        it('device rows are removed when the user is deleted', async () => {
            const { userId } = await seedSession({ deviceId: 'dev-1' });
            await reportDeviceName(sql, {
                userId,
                deviceId: 'dev-1',
                name: 'Wohnzimmer',
                source: 'oauth-device-flow',
            });

            await sql`DELETE FROM users WHERE id = ${userId}::uuid`;

            const rows = await sql<{ count: string }[]>`
                SELECT COUNT(*)::text AS count FROM user_devices WHERE user_id = ${userId}::uuid
            `;
            expect(rows[0].count).toBe('0');
        });
    });
});
