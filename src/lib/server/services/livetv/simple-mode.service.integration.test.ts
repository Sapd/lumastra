// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV simple mode against real PostgreSQL: defaults, channel replace
 * (favorites), start channel, PIN lock for the user, admin override.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { toUserId, type UserId } from '$lib/shared/user-id.js';
import { createChannelWithMediaItem } from '$lib/server/database/queries/livetv-channels.queries.js';
import * as password from '$lib/server/crypto/password.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { getSimpleMode, updateSimpleMode, verifySimpleModePin } from './simple-mode.service.js';
import { simpleModeLocksFavorites } from '$lib/server/database/queries/livetv-simple-mode.queries.js';

vi.mock('$lib/server/crypto/password.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/crypto/password.js')>();
    return {
        ...actual,
        hashPassword: vi.fn(actual.hashPassword),
        verifyPassword: vi.fn(actual.verifyPassword),
    };
});

describe('Live TV simple mode service', () => {
    let sql: postgres.Sql;
    let sourceId: string;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql.unsafe(
            'TRUNCATE TABLE livetv_simple_mode, livetv_channel_favorites, livetv_channels, livetv_sources, media_items RESTART IDENTITY CASCADE',
        );
        sourceId = crypto.randomUUID();
        await sql`
            INSERT INTO livetv_sources (id, name, source_type, max_streams)
            VALUES (${sourceId}::uuid, 'Test Source', 'm3u', 2)
        `;
    });

    async function insertUser(): Promise<UserId> {
        const [row] = await sql<{ id: string }[]>`
            INSERT INTO users (username) VALUES (${`simple-${crypto.randomUUID()}`}) RETURNING id
        `;
        return toUserId(row.id);
    }

    async function insertChannel(name: string): Promise<string> {
        const id = crypto.randomUUID();
        await createChannelWithMediaItem(sql, {
            id,
            name,
            streamUrl: 'http://stream.test/live.m3u8',
            sourceId,
        });
        return id;
    }

    it('returns defaults for a user who never set it up', async () => {
        const user = await insertUser();
        const mode = await getSimpleMode(sql, user);
        expect(mode).toMatchObject({
            enabled: false,
            layout: 'tv',
            textSize: 'large',
            autostart: true,
            locked: false,
            stationIds: [],
        });
        expect(mode.startStationId).toBeUndefined();
    });

    it('replaces the favorites with the chosen channels in order and keeps a start channel', async () => {
        const user = await insertUser();
        const a = await insertChannel('Nordwelle');
        const b = await insertChannel('Kanal Sieben');
        const c = await insertChannel('Sonnenland TV');

        const first = await updateSimpleMode(
            sql,
            user,
            { enabled: true, layout: 'list', stationIds: [c, a, b], startStationId: a },
            { actorUserId: user, asAdmin: false },
        );
        expect(first.ok).toBe(true);
        if (!first.ok) return;
        expect(first.value.stationIds).toEqual([c, a, b]);
        expect(first.value.startStationId).toBe(a);
        expect(first.value.layout).toBe('list');

        // Removing the start channel falls back to "the first channel".
        const second = await updateSimpleMode(
            sql,
            user,
            { stationIds: [b, c] },
            { actorUserId: user, asAdmin: false },
        );
        expect(second.ok && second.value.stationIds).toEqual([b, c]);
        expect(second.ok && second.value.startStationId).toBeUndefined();
        expect(second.ok && second.value.enabled).toBe(true);
    });

    it('rejects a start channel that is not one of the channels, and unknown channels', async () => {
        const user = await insertUser();
        const a = await insertChannel('Nordwelle');
        const b = await insertChannel('Kanal Sieben');
        const bad = await updateSimpleMode(
            sql,
            user,
            { stationIds: [a], startStationId: b },
            { actorUserId: user, asAdmin: false },
        );
        expect(bad).toEqual({ ok: false, error: expect.objectContaining({ kind: 'invalid' }) });
        // Nothing was written.
        expect((await getSimpleMode(sql, user)).stationIds).toEqual([]);

        const unknown = await updateSimpleMode(
            sql,
            user,
            { stationIds: [crypto.randomUUID()] },
            { actorUserId: user, asAdmin: false },
        );
        expect(unknown).toEqual({ ok: false, error: { kind: 'unknown_channel' } });
    });

    it('a locked setup needs the PIN on the own account; the admin needs none and can unlock', async () => {
        const user = await insertUser();
        const admin = await insertUser();
        const a = await insertChannel('Nordwelle');

        const locked = await updateSimpleMode(
            sql,
            user,
            { enabled: true, stationIds: [a], locked: true, newPin: '2468' },
            { actorUserId: admin, asAdmin: true },
        );
        expect(locked.ok && locked.value.locked).toBe(true);

        const noPin = await updateSimpleMode(
            sql,
            user,
            { enabled: false },
            { actorUserId: user, asAdmin: false },
        );
        expect(noPin).toEqual({ ok: false, error: { kind: 'pin_required' } });

        const wrong = await updateSimpleMode(
            sql,
            user,
            { enabled: false, pin: '1111' },
            { actorUserId: user, asAdmin: false },
        );
        expect(wrong).toEqual({ ok: false, error: { kind: 'pin_invalid' } });
        expect(await verifySimpleModePin(sql, user, '1111')).toEqual({
            ok: false,
            error: { kind: 'pin_invalid' },
        });
        expect(await verifySimpleModePin(sql, user, '2468')).toMatchObject({ ok: true });
        expect((await getSimpleMode(sql, user)).enabled).toBe(true);

        const right = await updateSimpleMode(
            sql,
            user,
            { layout: 'tiles', pin: '2468' },
            { actorUserId: user, asAdmin: false },
        );
        expect(right.ok && right.value.layout).toBe('tiles');
        expect(right.ok && right.value.locked).toBe(true);

        const unlocked = await updateSimpleMode(
            sql,
            user,
            { locked: false },
            { actorUserId: admin, asAdmin: true },
        );
        expect(unlocked.ok && unlocked.value.locked).toBe(false);
        const [row] = await sql<{ pin_hash: string | null }[]>`
            SELECT pin_hash FROM livetv_simple_mode WHERE user_id = ${user}
        `;
        expect(row.pin_hash).toBeNull();
        // Unlocked: no PIN needed any more.
        const free = await updateSimpleMode(
            sql,
            user,
            { enabled: false },
            { actorUserId: user, asAdmin: false },
        );
        expect(free.ok && free.value.enabled).toBe(false);
    });

    it('locking without a PIN is refused', async () => {
        const user = await insertUser();
        const result = await updateSimpleMode(
            sql,
            user,
            { locked: true },
            { actorUserId: user, asAdmin: false },
        );
        expect(result).toEqual({ ok: false, error: expect.objectContaining({ kind: 'invalid' }) });
    });

    it('records who set it up', async () => {
        const user = await insertUser();
        const admin = await insertUser();
        await updateSimpleMode(sql, user, { enabled: true }, { actorUserId: admin, asAdmin: true });
        const [{ display_name }] = await sql<{ display_name: string | null }[]>`
            SELECT display_name FROM users WHERE id = ${admin}
        `;
        expect((await getSimpleMode(sql, user)).updatedBy).toMatchObject({
            userId: admin,
            displayName: display_name,
        });
    });

    it('a locked, enabled simple mode locks the favorites; unlocked or off does not', async () => {
        const user = await insertUser();
        const a = await insertChannel('Nordwelle');
        expect(await simpleModeLocksFavorites(sql, user)).toBe(false);
        await updateSimpleMode(
            sql,
            user,
            { enabled: true, stationIds: [a], locked: true, newPin: '1357' },
            { actorUserId: user, asAdmin: true },
        );
        expect(await simpleModeLocksFavorites(sql, user)).toBe(true);
        await updateSimpleMode(sql, user, { enabled: false }, { actorUserId: user, asAdmin: true });
        expect(await simpleModeLocksFavorites(sql, user)).toBe(false);
    });

    it('only wrong PINs count; after 5 even the right PIN waits, and saves with the right PIN never lock out', async () => {
        const user = await insertUser();
        const a = await insertChannel('Nordwelle');
        await updateSimpleMode(
            sql,
            user,
            { enabled: true, stationIds: [a], locked: true, newPin: '8642' },
            { actorUserId: user, asAdmin: true },
        );
        // Ten saves with the right PIN: none counts.
        for (let i = 0; i < 10; i++) {
            const ok = await updateSimpleMode(
                sql,
                user,
                { textSize: i % 2 ? 'large' : 'xlarge', pin: '8642' },
                { actorUserId: user, asAdmin: false },
            );
            expect(ok.ok).toBe(true);
        }
        for (let i = 0; i < 5; i++) {
            expect(await verifySimpleModePin(sql, user, '0000')).toEqual({
                ok: false,
                error: { kind: 'pin_invalid' },
            });
        }
        expect(await verifySimpleModePin(sql, user, '8642')).toEqual({
            ok: false,
            error: expect.objectContaining({ kind: 'rate_limited' }),
        });
        const blocked = await updateSimpleMode(
            sql,
            user,
            { enabled: false, pin: '8642' },
            { actorUserId: user, asAdmin: false },
        );
        expect(blocked).toEqual({
            ok: false,
            error: expect.objectContaining({ kind: 'rate_limited' }),
        });
    });

    it('a new PIN without a lock, hidden channels and mixed-case duplicates are handled', async () => {
        const user = await insertUser();
        const a = await insertChannel('Nordwelle');
        const hidden = await insertChannel('Kanal Sieben');
        await sql`UPDATE livetv_channels SET is_visible = false WHERE id = ${hidden}`;
        expect(
            await updateSimpleMode(
                sql,
                user,
                { newPin: '1234' },
                { actorUserId: user, asAdmin: false },
            ),
        ).toEqual({ ok: false, error: expect.objectContaining({ kind: 'invalid' }) });
        expect(
            await updateSimpleMode(
                sql,
                user,
                { stationIds: [hidden] },
                { actorUserId: user, asAdmin: false },
            ),
        ).toEqual({ ok: false, error: { kind: 'unknown_channel' } });
        const mixed = await updateSimpleMode(
            sql,
            user,
            { stationIds: [a.toUpperCase(), a], startStationId: a.toUpperCase() },
            { actorUserId: user, asAdmin: false },
        );
        expect(mixed.ok && mixed.value.stationIds).toEqual([a]);
        expect(mixed.ok && mixed.value.startStationId).toBe(a);
    });

    it('parallel wrong PINs: at most 5 are evaluated, the rest are rate limited, every attempt counts', async () => {
        const user = await insertUser();
        await updateSimpleMode(
            sql,
            user,
            { locked: true, newPin: '8642' },
            { actorUserId: user, asAdmin: true },
        );
        vi.mocked(password.verifyPassword).mockClear();
        const results = await Promise.all(
            Array.from({ length: 10 }, () => verifySimpleModePin(sql, user, '0000')),
        );
        const invalid = results.filter((r) => !r.ok && r.error.kind === 'pin_invalid');
        const limited = results.filter((r) => !r.ok && r.error.kind === 'rate_limited');
        expect(invalid).toHaveLength(5);
        expect(limited).toHaveLength(5);
        expect(vi.mocked(password.verifyPassword)).toHaveBeenCalledTimes(5);
        // Probe the counter with a huge limit: 10 attempts + this probe.
        const probe = await checkRateLimit(`livetv-simple-pin:${user}`, 1000, 15 * 60);
        expect(1000 - probe.remaining).toBe(11);
        // Even the right PIN waits now.
        expect(await verifySimpleModePin(sql, user, '8642')).toEqual({
            ok: false,
            error: expect.objectContaining({ kind: 'rate_limited' }),
        });
    });

    it('a locked row with a new PIN but no current PIN is refused before any hashing', async () => {
        const user = await insertUser();
        await updateSimpleMode(
            sql,
            user,
            { locked: true, newPin: '8642' },
            { actorUserId: user, asAdmin: true },
        );
        vi.mocked(password.hashPassword).mockClear();
        const result = await updateSimpleMode(
            sql,
            user,
            { newPin: '1234', locked: true },
            { actorUserId: user, asAdmin: false },
        );
        expect(result).toEqual({ ok: false, error: { kind: 'pin_required' } });
        expect(vi.mocked(password.hashPassword)).not.toHaveBeenCalled();

        const wrong = await updateSimpleMode(
            sql,
            user,
            { newPin: '1234', locked: true, pin: '0000' },
            { actorUserId: user, asAdmin: false },
        );
        expect(wrong).toEqual({ ok: false, error: { kind: 'pin_invalid' } });
        expect(vi.mocked(password.hashPassword)).not.toHaveBeenCalled();

        // With the right PIN the new PIN is hashed and takes effect.
        const right = await updateSimpleMode(
            sql,
            user,
            { newPin: '1234', locked: true, pin: '8642' },
            { actorUserId: user, asAdmin: false },
        );
        expect(right.ok).toBe(true);
        expect(vi.mocked(password.hashPassword)).toHaveBeenCalledTimes(1);
        expect(await verifySimpleModePin(sql, user, '1234')).toMatchObject({ ok: true });
    });
});
