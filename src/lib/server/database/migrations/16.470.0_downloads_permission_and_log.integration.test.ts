// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrate-schema.js';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';

describe('downloads permission and log schema', () => {
    const migration = MIGRATIONS.find((m) => m.version === '16.470.0');

    it('is registered', () => {
        expect(migration?.name).toBe('downloads_permission_and_log');
    });

    it('adds users.allow_downloads as nullable boolean without default', async () => {
        const db = getTestDb();
        const [col] = await db<
            { data_type: string; is_nullable: string; column_default: string | null }[]
        >`
            SELECT data_type, is_nullable, column_default FROM information_schema.columns
             WHERE table_name = 'users' AND column_name = 'allow_downloads'`;
        expect(col?.data_type).toBe('boolean');
        expect(col?.is_nullable).toBe('YES');
        expect(col?.column_default).toBeNull();
    });

    it('creates download_events with its checks and indexes', async () => {
        const db = getTestDb();
        const [user] = await db<{ id: string }[]>`
            INSERT INTO users (username, email, password_hash)
            VALUES (${'dl-' + crypto.randomUUID()}, ${crypto.randomUUID() + '@example.test'}, 'x')
            RETURNING id`;
        const userId = user!.id;
        try {
            const mediaId = crypto.randomUUID();
            const [row] = await db<{ bytes_sent: string; outcome: string | null }[]>`
                INSERT INTO download_events (user_id, media_item_id, surface, device_key)
                VALUES (${userId}, ${mediaId}, 'web', 'dev-1')
                RETURNING bytes_sent, outcome`;
            expect(Number(row?.bytes_sent)).toBe(0);
            expect(row?.outcome).toBeNull();
            await expect(
                db`INSERT INTO download_events (user_id, media_item_id, surface, device_key, outcome)
                   VALUES (${userId}, ${mediaId}, 'web', 'dev-1', 'bogus')`,
            ).rejects.toThrow(/download_events_outcome_check/);
            await expect(
                db`INSERT INTO download_events (user_id, media_item_id, surface, device_key)
                   VALUES (${userId}, ${mediaId}, 'ftp', 'dev-1')`,
            ).rejects.toThrow(/download_events_surface_check/);
            const idx = await db<{ indexname: string }[]>`
                SELECT indexname FROM pg_indexes WHERE tablename = 'download_events'`;
            expect(idx.map((i) => i.indexname)).toEqual(
                expect.arrayContaining([
                    'idx_download_events_started',
                    'idx_download_events_user_started',
                    'idx_download_events_open_lease',
                ]),
            );
            await db`DELETE FROM users WHERE id = ${userId}`;
            const left = await db`SELECT 1 FROM download_events WHERE user_id = ${userId}`;
            expect(left.length).toBe(0);
        } finally {
            await db`DELETE FROM users WHERE id = ${userId}`;
        }
    });

    it('is idempotent', async () => {
        const db = getTestDb();
        await db.begin(async (tx) => migration!.up(tx));
        await db.begin(async (tx) => migration!.up(tx));
    });
});
