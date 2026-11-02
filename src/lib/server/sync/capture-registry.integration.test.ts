// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    SYNC_CAPTURED_TABLES,
    SYNC_IGNORED_TABLES,
    SYNC_NOISE_COLUMNS,
    SYNC_INHERITED_COLUMNS,
} from './capture-registry.js';

describe('sync schema coverage', () => {
    it('classifies every FK to media, users, or playlists and installs both trigger levels', async () => {
        const sql = getTestDb();
        const rows = await sql`
            SELECT DISTINCT c.conrelid::regclass::text AS name FROM pg_constraint c
            WHERE c.contype = 'f' AND c.confrelid IN ('media_items'::regclass,'users'::regclass,'playlists'::regclass)
        `;
        const captured = new Set<string>(SYNC_CAPTURED_TABLES);
        expect(
            rows.map((r) => r.name).filter((t) => !captured.has(t) && !SYNC_IGNORED_TABLES[t]),
        ).toEqual([]);
        for (const table of SYNC_CAPTURED_TABLES) {
            const triggers = await sql`
                SELECT tgtype::int AS type FROM pg_trigger
                WHERE tgrelid = ${table}::regclass AND starts_with(tgname, 'sync_') AND NOT tgisinternal
            `;
            expect(
                triggers.some((t) => (t.type & 1) === 1),
                table,
            ).toBe(true);
            expect(
                triggers.some((t) => (t.type & 32) === 32 && (t.type & 1) === 0),
                table,
            ).toBe(true);
        }
    });
    it('uses real columns for noise and inheritance', async () => {
        const rows =
            await getTestDb()`SELECT attname FROM pg_attribute WHERE attrelid = 'media_items'::regclass AND NOT attisdropped`;
        const names = new Set(rows.map((r) => r.attname));
        expect(
            [...SYNC_NOISE_COLUMNS, ...SYNC_INHERITED_COLUMNS].filter((c) => !names.has(c)),
        ).toEqual([]);
    });
});
