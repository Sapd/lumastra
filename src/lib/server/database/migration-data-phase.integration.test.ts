// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { expect, it } from 'vitest';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import { MigrationSystem, type Migration } from './migration-system.js';

it('commits resumable repair work before completion, retries failure, and skips success', async () => {
    const sql = getTestDb();
    const observer = postgres(process.env.TEST_DATABASE_URL!, { max: 1 });
    const table = `artist_credit_repair_probe_${randomUUID().replaceAll('-', '')}`;
    const version = `0.0.${Date.now()}`;
    let attempts = 0;
    let finalized = 0;
    await sql`CREATE TABLE ${sql(table)} (id integer PRIMARY KEY)`;
    const migration: Migration = {
        version,
        name: 'resumable_data_probe',
        description: 'Transaction boundary probe',
        checksum: 'probe',
        async nonTransactionalUp(handle) {
            attempts++;
            await handle`INSERT INTO ${handle(table)} (id) VALUES (1) ON CONFLICT DO NOTHING`;
            // A distinct connection must observe committed work before up() and
            // schema_migrations success. An outer transaction would hide it.
            const [row] = await observer<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM ${observer(table)}`;
            expect(row.count).toBe(1);
            if (attempts === 1) throw new Error('interrupt repair');
        },
        async up() {
            finalized++;
        },
    };
    try {
        const system = new MigrationSystem(sql);
        await expect(system.applyMigration(migration)).rejects.toThrow('interrupt repair');
        expect(finalized).toBe(0);
        expect(await system.isMigrationApplied(version)).toBe(false);
        await system.applyMigration(migration);
        expect(await system.isMigrationApplied(version)).toBe(true);
        await system.applyMigration(migration);
        expect(attempts).toBe(2);
        expect(finalized).toBe(1);
    } finally {
        await sql`DELETE FROM schema_migrations WHERE version = ${version}`;
        await sql`DROP TABLE IF EXISTS ${sql(table)}`;
        await observer.end();
    }
});
