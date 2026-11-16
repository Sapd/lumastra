// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrate-schema.js';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';

describe('download_events archive kind', () => {
    const migration = MIGRATIONS.find((m) => m.version === '16.471.0');

    it('is registered', () => {
        expect(migration?.name).toBe('download_events_archive_kind');
    });

    it('kind defaults to file and is checked', async () => {
        const db = getTestDb();
        const [user] = await db<{ id: string }[]>`
            INSERT INTO users (username, email, password_hash)
            VALUES (${'dl-' + crypto.randomUUID()}, ${crypto.randomUUID() + '@example.test'}, 'x')
            RETURNING id`;
        const userId = user!.id;
        try {
            const item = crypto.randomUUID();
            const [row] = await db<{ kind: string }[]>`
                INSERT INTO download_events (user_id, media_item_id, file_id, surface, device_key)
                VALUES (${userId}, ${item}, ${crypto.randomUUID()}, 'web', 'dev-1') RETURNING kind`;
            expect(row?.kind).toBe('file');
            await expect(
                db`INSERT INTO download_events (user_id, media_item_id, surface, device_key, kind)
                   VALUES (${userId}, ${item}, 'web', 'dev-1', 'bogus')`,
            ).rejects.toThrow(/download_events_kind_check/);
            // archives (NULL file and rendition) never collide: two open ones, same item and device
            for (let i = 0; i < 2; i++) {
                await db`INSERT INTO download_events (user_id, media_item_id, surface, device_key, kind)
                         VALUES (${userId}, ${item}, 'web', 'dev-1', 'archive')`;
            }
        } finally {
            await db`DELETE FROM users WHERE id = ${userId}`;
        }
    });

    it('leaves the 16.470.0 open-transfer index alone: its ON CONFLICT statement still works', async () => {
        const db = getTestDb();
        const [idx] = await db<{ indexdef: string }[]>`
            SELECT indexdef FROM pg_indexes
            WHERE tablename = 'download_events' AND indexname = 'idx_download_events_open_transfer'`;
        expect(idx?.indexdef).toMatch(/COALESCE\(file_id, rendition_id\)/);
        expect(idx?.indexdef).not.toMatch(/kind/);

        const [user] = await db<{ id: string }[]>`
            INSERT INTO users (username, email, password_hash)
            VALUES (${'dl-' + crypto.randomUUID()}, ${crypto.randomUUID() + '@example.test'}, 'x')
            RETURNING id`;
        const userId = user!.id;
        try {
            const item = crypto.randomUUID();
            const fileId = crypto.randomUUID();
            // the exact insert of the 16.470.0 code (no kind column named)
            const legacy = () => db<{ id: string }[]>`
                INSERT INTO download_events
                    (user_id, media_item_id, file_id, rendition_id, surface, device_key,
                     client_name, bytes_total, range_start, open_streams)
                VALUES (${userId}, ${item}, ${fileId}, ${null}, 'web', 'dev-1', 'x', ${100}, ${null}, 1)
                ON CONFLICT (user_id, device_key, (COALESCE(file_id, rendition_id)))
                    WHERE ended_at IS NULL
                DO UPDATE SET open_streams = download_events.open_streams + 1,
                              last_activity_at = now()
                RETURNING id`;
            const first = await legacy();
            const second = await legacy();
            expect(second[0]!.id).toBe(first[0]!.id);
            const [r] = await db<{ open_streams: number; kind: string }[]>`
                SELECT open_streams, kind FROM download_events WHERE id = ${first[0]!.id}`;
            expect(r).toMatchObject({ open_streams: 2, kind: 'file' });
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
