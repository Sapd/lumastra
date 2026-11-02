// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { mockContext } from '@sapd/lumastra-plugin-sdk-testing';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { integrityScannerTask } from './integrity-scanner.js';
import { countDistinctSeriesWithUnresolvedQuarantine } from '../../../database/queries/sync-quarantine.queries.js';
import {
    recordViolation,
    summarizeOpenViolationsByRule,
} from '../../../database/queries/integrity-violations.queries.js';

import { adaptIntegrity } from '../../../services/attention/adapters.js';

const RULE = 'quarantine-backlog-large';

interface BacklogFindingRow {
    severity: string;
    details: Record<string, number>;
}

describe('actionable quarantine backlog', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE sync_quarantine, quarantine_dispositions, integrity_violations`;
    });

    async function seed(
        count: number,
        ageDays: number,
        payload: Record<string, string | number | null> = { proposedTitle: 'Candidate' },
        reason = 'reconcile-backfill:below-threshold',
    ): Promise<void> {
        for (let i = 0; i < count; i++) {
            await sql`INSERT INTO sync_quarantine (provider, external_id, media_type, parent_tmdb_id, reason, source, payload, created_at)
                VALUES ('lumastra-reconcile', ${crypto.randomUUID()}, 'episode', ${String(i)}, ${reason}, 'test', ${sql.json(payload)}, NOW() - ${ageDays} * INTERVAL '1 day')`;
        }
    }

    async function scan(): Promise<BacklogFindingRow[]> {
        const result = await integrityScannerTask.execute(mockContext({ sql, input: {} }));
        expect(result.success).toBe(true);
        expect(result.result?.errors).toEqual([]);
        const { counts, severities } = await summarizeOpenViolationsByRule(sql);
        if (counts[RULE]) {
            const [alert] = adaptIntegrity({ [RULE]: counts[RULE] }, severities);
            expect(alert.severity).toBe(severities[RULE] === 'low' ? 'info' : 'warning');
        }
        return sql<
            BacklogFindingRow[]
        >`SELECT severity, details FROM integrity_violations WHERE rule = ${RULE} AND resolved_at IS NULL`;
    }

    it('ignores historic null/missing/empty proposals and clears the old alert without changing quarantine data', async () => {
        await recordViolation(sql, { rule: RULE, severity: 'medium' });
        await seed(11, 30, { confidence: 0, proposedTitle: null, matchedTmdbEpisodeId: null });
        await seed(11, 30, {});
        await seed(11, 30, { proposedTitle: '', matchedTmdbEpisodeId: '' });
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(0);
        expect(await scan()).toEqual([]);
        const [row] =
            await sql`SELECT COUNT(*)::int AS count FROM sync_quarantine WHERE resolved_at IS NULL`;
        expect(row.count).toBe(33);
    });

    it('keeps a young actionable backlog informational', async () => {
        await seed(11, 1);
        const [row] = await scan();
        expect(row.severity).toBe('low');
        expect(row.details).toMatchObject({
            seriesCount: 11,
            agedSeriesCount: 0,
            warningAgeDays: 14,
        });
    });

    it('warns only when older actionable rows exceed ten distinct series and downgrades after resolution', async () => {
        await seed(11, 15, { matchedTmdbEpisodeId: '123', proposedTitle: null });
        expect((await scan())[0].severity).toBe('medium');
        await sql`UPDATE sync_quarantine SET resolved_at = NOW(), resolution = 'dismissed' WHERE parent_tmdb_id = '10'`;
        await seed(11, 1);
        expect((await scan())[0].severity).toBe('low');
    });

    it('does not use old noise or the oldest row alone to escalate a young backlog', async () => {
        await seed(11, 30, {});
        await seed(1, 15);
        await seed(11, 1);
        expect((await scan())[0].severity).toBe('low');
    });

    it('keeps exactly ten actionable series below the threshold, and counts series rather than rows', async () => {
        await seed(10, 30);
        await seed(10, 30);
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(10);
        expect(await scan()).toEqual([]);
    });

    it('uses a strict age cutoff rather than including rows exactly at the cutoff', async () => {
        await seed(11, 1);
        const cutoff = new Date('2026-10-01T12:00:00.000Z');
        await sql`UPDATE sync_quarantine SET created_at = ${cutoff}`;
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql, cutoff)).toBe(0);
        expect(
            await countDistinctSeriesWithUnresolvedQuarantine(sql, new Date(cutoff.getTime() + 1)),
        ).toBe(11);
    });

    it('preserves actionable conflicts from other sync writers without reconciliation proposal fields', async () => {
        await seed(11, 30, {}, 'parent series TMDB id mismatch');
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(11);
        expect((await scan())[0].severity).toBe('medium');
    });
    it('retains real collisions without proposed metadata as actionable attention', async () => {
        await seed(11, 30, {}, 'reconcile-backfill:duplicate-match');
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(11);
        expect((await scan())[0].severity).toBe('medium');
    });
    it('archived exact warnings no longer light attention and their evidence stays in history', async () => {
        await seed(11, 30);
        const {
            listQuarantineSnapshots,
            archiveQuarantineSnapshot,
            listQuarantineDispositionHistory,
        } = await import('../../../database/queries/sync-quarantine.queries.js');
        const entries = await listQuarantineSnapshots(sql, { limit: 100 });
        for (const e of entries) await archiveQuarantineSnapshot(sql, e, 'fixture', 'hidden');
        expect(await countDistinctSeriesWithUnresolvedQuarantine(sql)).toBe(0);
        expect(await scan()).toEqual([]);
        expect((await listQuarantineDispositionHistory(sql)).items).toHaveLength(11);
    });
});
