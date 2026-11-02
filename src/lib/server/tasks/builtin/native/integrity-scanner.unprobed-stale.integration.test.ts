// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for the `unprobed-files-stale` integrity rule against a real
 * `lumastra_tests` database. Runs the real task `execute()` so the scanner's own
 * SQL and reconciliation are what get exercised.
 *
 * Files that already carry a permanent `health_issues` entry (0-byte placeholder,
 * unparsed episode) are explained elsewhere and must not raise this rule.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import { upsertMediaFile } from '../../../database/queries/media-files.queries.js';
import { recordViolation } from '../../../database/queries/integrity-violations.queries.js';
import { integrityScannerTask } from './integrity-scanner.js';

const RULE = 'unprobed-files-stale';

function makeCtx(sql: postgres.Sql) {
    const ac = new AbortController();
    return {
        sql,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn().mockReturnThis(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'unprobed-stale-int-test',
        input: {},
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        secrets: { get: vi.fn(), getOptional: vi.fn(), getUser: vi.fn() },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
    };
}

/**
 * Seed an unprobed file backdated past the 7-day threshold. `healthIssuesJson`
 * is passed as TEXT and cast to jsonb, so it is stored as the array it spells.
 * (A bare `${str}::jsonb` param makes postgres.js JSON-encode the string, which
 * stores a jsonb string scalar, not an array.)
 */
async function seedOldUnprobedFile(
    sql: postgres.Sql,
    name: string,
    healthIssuesJson: string | null,
): Promise<string> {
    const { id } = await upsertMediaFile(sql, {
        filePath: `/test-files/unprobed-stale-${name}.mkv`,
    });
    await sql`
        UPDATE media_files
           SET created_at = NOW() - INTERVAL '10 days',
               probed_at = NULL,
               is_missing = FALSE,
               health_issues = ${healthIssuesJson}::text::jsonb
         WHERE id = ${id}::uuid
    `;
    return id;
}

describe('integrity-scanner unprobed-files-stale rule', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, ['media_files', 'integrity_violations']);
        vi.clearAllMocks();
    });

    it('skips old unprobed files that already carry a health_issues entry, and resolves their open violation', async () => {
        const explainedId = await seedOldUnprobedFile(
            sql,
            'explained',
            '[{"type":"container_unreadable"}]',
        );
        const plainId = await seedOldUnprobedFile(sql, 'plain', null);

        // Pre-existing open violation for the explained file, from an earlier scan
        // that did not yet know about its health_issues entry.
        const staleViolationId = await recordViolation(sql, {
            rule: RULE,
            severity: 'medium',
            mediaId: explainedId,
            details: { filePath: '/test-files/unprobed-stale-explained.mkv', ageDays: 10 },
        });

        const result = await integrityScannerTask.execute(
            makeCtx(sql) as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(result.result?.errors).toEqual([]);

        const openRows = await sql<Array<{ media_id: string }>>`
            SELECT media_id FROM integrity_violations
             WHERE rule = ${RULE} AND resolved_at IS NULL
        `;
        const openMediaIds = openRows.map((r) => r.media_id);
        expect(openMediaIds).toEqual([plainId]);
        expect(openMediaIds).not.toContain(explainedId);

        const [staleRow] = await sql<Array<{ resolved_at: Date | null }>>`
            SELECT resolved_at FROM integrity_violations WHERE id = ${staleViolationId}::uuid
        `;
        expect(staleRow.resolved_at).toBeInstanceOf(Date);
    });
});
