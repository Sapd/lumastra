// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { shownGroupMember } from './livetv-channels.queries.js';

it('migration 16.303 already indexes the lineup sibling and shown-member probes', async () => {
    const sql = getTestDb();
    const [index] = await sql`
        SELECT i.indisvalid, pg_get_indexdef(i.indexrelid) AS definition
        FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
        WHERE c.relname = 'idx_livetv_channels_backup_group_id_fk'
          AND c.relnamespace = current_schema()::regnamespace
    `;
    expect(index.indisvalid).toBe(true);
    expect(index.definition).toContain('(backup_group_id, sort_order)');
    expect(index.definition).toContain('WHERE (backup_group_id IS NOT NULL)');
    await sql.begin(async (tx) => {
        // The empty test table favors a seqscan on cost. Check that the existing
        // partial index is eligible for both real correlated lineup predicates.
        await tx`SET LOCAL enable_seqscan = off`;
        const election = await tx`EXPLAIN SELECT lc.id, ${shownGroupMember(tx)}
            FROM livetv_channels lc`;
        const order = await tx`EXPLAIN SELECT lc.id,
            (SELECT MIN(sib.sort_order) FROM livetv_channels sib
             LEFT JOIN livetv_categories sibcat ON sibcat.id = sib.category_id
             WHERE sib.backup_group_id = lc.backup_group_id
               AND sib.is_visible = true
               AND (sibcat.is_visible = true OR sib.category_id IS NULL))
            FROM livetv_channels lc`;
        for (const plan of [election, order]) {
            expect(JSON.stringify(plan)).toContain('idx_livetv_channels_backup_group_id_fk');
            expect(JSON.stringify(plan)).toMatch(/Index Cond:.*backup_group_id/);
        }
    });
});
