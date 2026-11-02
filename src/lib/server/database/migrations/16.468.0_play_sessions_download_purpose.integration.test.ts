// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../migrate-schema.js';
import {
    getTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';

describe('play_sessions download purpose', () => {
    const migration = MIGRATIONS.find((m) => m.version === '16.468.0')!;

    it('is registered', () => {
        expect(migration.name).toBe('play_sessions_download_purpose');
    });

    it('widens the purpose CHECK to download, validated, and can run twice', async () => {
        const db = getTestDb();
        const schema = `purpose_${crypto.randomUUID().replaceAll('-', '')}`;
        await db`CREATE SCHEMA ${db(schema)}`;
        const sql = postgres(getTestDatabaseUrl(), {
            max: 1,
            connection: { search_path: schema, lock_timeout: 2000 },
        });
        try {
            await sql`CREATE TABLE play_sessions (
                id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
                purpose text DEFAULT 'play' NOT NULL,
                CONSTRAINT play_sessions_purpose_check
                    CHECK ((purpose = ANY (ARRAY['play'::text, 'prefetch'::text]))))`;
            await expect(
                sql`INSERT INTO play_sessions (purpose) VALUES ('download')`,
            ).rejects.toThrow(/play_sessions_purpose_check/);

            await migration.nonTransactionalUp!(sql);
            await migration.nonTransactionalUp!(sql);

            await sql`INSERT INTO play_sessions (purpose) VALUES ('play'), ('prefetch'), ('download')`;
            await expect(sql`INSERT INTO play_sessions (purpose) VALUES ('bogus')`).rejects.toThrow(
                /play_sessions_purpose_check/,
            );
            const [constraint] = await sql<{ convalidated: boolean }[]>`
                SELECT convalidated FROM pg_constraint
                 WHERE conname = 'play_sessions_purpose_check'
                   AND conrelid = 'play_sessions'::regclass`;
            expect(constraint?.convalidated).toBe(true);
        } finally {
            await sql.end({ timeout: 1 });
            await db`DROP SCHEMA ${db(schema)} CASCADE`;
        }
    });

    it('is applied to the real table', async () => {
        const db = getTestDb();
        const [row] = await db<{ def: string; convalidated: boolean }[]>`
            SELECT pg_get_constraintdef(oid) AS def, convalidated FROM pg_constraint
             WHERE conname = 'play_sessions_purpose_check' AND conrelid = 'play_sessions'::regclass`;
        expect(row?.def).toContain('download');
        expect(row?.convalidated).toBe(true);
    });
});
