// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Who an admin broadcast reaches — in real SQL.
 *
 * The service tests mock both recipient queries, so dropping the
 * `deleted_at IS NULL` / `disabled_at IS NULL` filters failed nothing: a
 * disabled or deleted account would have received every announcement and push.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    listBroadcastRecipients,
    listBroadcastRecipientsByIds,
} from './admin-broadcasts.queries.js';

const PREFIX = 'broadcast-recipient-it-';

let sql: postgres.Sql;
const ids: Record<'active' | 'disabled' | 'deleted', string> = {
    active: '',
    disabled: '',
    deleted: '',
};

async function seedUser(
    name: string,
    extra: postgres.PendingQuery<postgres.Row[]>,
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO users (username) VALUES (${PREFIX + name})
        ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username
        RETURNING id
    `;
    await sql`UPDATE users SET ${extra} WHERE id = ${row.id}`;
    return row.id;
}

beforeAll(async () => {
    sql = await getTestDb();
    ids.active = await seedUser('active', sql`deleted_at = NULL, disabled_at = NULL`);
    ids.disabled = await seedUser('disabled', sql`deleted_at = NULL, disabled_at = now()`);
    ids.deleted = await seedUser('deleted', sql`deleted_at = now(), disabled_at = NULL`);
});

afterAll(async () => {
    await sql`DELETE FROM users WHERE username LIKE ${PREFIX + '%'}`;
    await closeTestDb();
});

describe('admin broadcast recipients', () => {
    it('the "all" audience includes active users only', async () => {
        const recipients = (await listBroadcastRecipients(sql)).map((r) => r.id);

        expect(recipients).toContain(ids.active);
        expect(recipients).not.toContain(ids.disabled);
        expect(recipients).not.toContain(ids.deleted);
    });

    it('an explicit selection resolves only active users (the caller 422s on the rest)', async () => {
        const unknown = '00000000-0000-4000-8000-00000000b0b0';
        const found = await listBroadcastRecipientsByIds(sql, [
            ids.active,
            ids.disabled,
            ids.deleted,
            unknown,
        ]);

        expect(found.map((r) => r.id)).toEqual([ids.active]);
        expect(found[0].username).toBe(PREFIX + 'active');
    });

    it('an empty selection resolves to nobody without a query error', async () => {
        await expect(listBroadcastRecipientsByIds(sql, [])).resolves.toEqual([]);
    });
});
