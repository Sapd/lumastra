// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { generateTestUserId } from '../../../../../tests/integration/fixtures/index.js';
import {
    upsertUser,
    getUserByUsername,
    getUserAllowDownloads,
    setUserAllowDownloads,
} from './users.queries.js';

describe('users.allow_downloads', () => {
    let sql: postgres.Sql;
    const names: string[] = [];

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        if (names.length) await sql`DELETE FROM users WHERE username = ANY(${names})`;
        await closeTestDb();
    });

    async function mk(): Promise<{ id: string; username: string }> {
        const username = generateTestUserId('dl');
        names.push(username);
        await upsertUser(sql, { username, isAdmin: false });
        const row = await getUserByUsername(sql, username);
        return { id: row!.id, username };
    }

    it('defaults to null, sets true/false and back to null', async () => {
        const u = await mk();
        expect((await getUserAllowDownloads(sql, u.id))?.allowDownloads).toBeNull();
        expect(await setUserAllowDownloads(sql, u.username, false)).toBe(true);
        expect((await getUserAllowDownloads(sql, u.id))?.allowDownloads).toBe(false);
        expect(await setUserAllowDownloads(sql, u.username.toUpperCase(), true)).toBe(true);
        expect((await getUserAllowDownloads(sql, u.id))?.allowDownloads).toBe(true);
        expect(await setUserAllowDownloads(sql, u.username, null)).toBe(true);
        expect((await getUserAllowDownloads(sql, u.id))?.allowDownloads).toBeNull();
    });

    it('returns the synced groups, [] when the column is null', async () => {
        const u = await mk();
        await sql`UPDATE users SET groups = NULL WHERE id = ${u.id}`;
        expect((await getUserAllowDownloads(sql, u.id))?.groups).toEqual([]);
        await sql`UPDATE users SET groups = ${['family', 'kids']} WHERE id = ${u.id}`;
        expect(await getUserAllowDownloads(sql, u.id)).toEqual({
            allowDownloads: null,
            groups: ['family', 'kids'],
        });
    });

    it('returns undefined / false for an unknown user', async () => {
        expect(
            await getUserAllowDownloads(sql, '00000000-0000-4000-8000-000000000000'),
        ).toBeUndefined();
        expect(await setUserAllowDownloads(sql, 'no_such_user_dl', true)).toBe(false);
    });

    it.each(['disabled_at', 'deleted_at'])('returns undefined when %s is set', async (col) => {
        const u = await mk();
        await setUserAllowDownloads(sql, u.username, true);
        await sql`UPDATE users SET ${sql(col)} = NOW() WHERE id = ${u.id}`;
        expect(await getUserAllowDownloads(sql, u.id)).toBeUndefined();
    });

    it('is exposed on the user row used by admin DTOs', async () => {
        const u = await mk();
        await setUserAllowDownloads(sql, u.username, false);
        const row = await getUserByUsername(sql, u.username);
        expect(row?.allow_downloads).toBe(false);
    });
});
