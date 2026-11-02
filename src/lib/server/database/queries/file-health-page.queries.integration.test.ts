// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
    getTestDatabaseUrl,
} from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { getFileHealthPage } from './file-health-page.queries.js';
import { countFilesWithHealthIssues } from './media-files.queries.js';
import { FileHealthResponseSchema } from '$lib/schemas/admin-file-health.js';

const issue = [{ type: 'truncated_video', detected_at: '2026-10-25T00:00:00Z' }];
describe('coherent physical file-health pages', () => {
    let sql: postgres.Sql;
    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('reaches every file beyond 200 across tied and distinct microsecond timestamps', async () => {
        for (let i = 0; i < 211; i++) {
            const micros = i < 105 ? '000001' : String(i - 104).padStart(6, '0');
            await sql`INSERT INTO media_files (file_path, health_issues, updated_at)
                VALUES (${`/test/health-${i}.mkv`}, ${sql.json(issue)},
                    ${`2026-10-25T12:00:00.${micros}Z`}::timestamptz)`;
        }
        const seen = new Set<string>();
        let cursor: string | undefined;
        let pages = 0;
        do {
            const page = await getFileHealthPage(sql, { scope: 'actionable', cursor });
            expect(page.recorded).toBe(211);
            expect(page.actionable).toBe(211);
            expect(page.matching).toBe(211);
            for (const row of page.files) {
                expect(seen.has(row.file_id)).toBe(false);
                seen.add(row.file_id);
            }
            cursor = page.nextCursor ?? undefined;
            pages++;
        } while (cursor);
        expect(pages).toBe(5);
        expect(seen.size).toBe(211);
        expect(await countFilesWithHealthIssues(sql)).toBe(211);
    });

    it('keeps malformed and mixed unknown evidence actionable and bounds the projection', async () => {
        const payloads: unknown[] = [
            { unexpected: 'raw object' },
            [null, { type: 'new_warning', detail: 'x'.repeat(10000) }],
            [
                { type: 'range_superseded', detected_at: '2026-10-25T00:00:00Z' },
                { type: 'duration_mismatch', detected_at: '2026-10-25T00:00:00Z' },
            ],
        ];
        for (let i = 0; i < payloads.length; i++) {
            await sql`INSERT INTO media_files (file_path, health_issues)
                VALUES (${`/test/malformed-${i}.mkv`}, ${sql.json(payloads[i] as postgres.JSONValue)})`;
        }
        const page = await getFileHealthPage(sql, { scope: 'actionable' });
        expect(page.recorded).toBe(3);
        expect(page.actionable).toBe(3);
        expect(page.informational).toBe(0);
        expect(page.files).toHaveLength(3);
        expect(
            page.files.some((row) =>
                row.health_issues.some((entry) => entry.type === 'unknown_recorded_evidence'),
            ),
        ).toBe(true);
        expect(JSON.stringify(page).length).toBeLessThan(10000);
    });

    it('omits non-finite duration metadata and bounds a large recorded array before transfer', async () => {
        const [file] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path, health_issues)
            VALUES ('/test/huge-health-array.mkv', (
                SELECT jsonb_build_array(jsonb_build_object(
                    'type', 'truncated_video', 'expected_duration', 1e400::numeric,
                    'actual_duration', repeat('9', 400)))
                    || jsonb_agg(jsonb_build_object('type', 'other_warning', 'detail', repeat('x', 10000)))
                FROM generate_series(1, 5000)
            )) RETURNING id`;
        const page = FileHealthResponseSchema.parse(
            await getFileHealthPage(sql, { scope: 'actionable' }),
        );
        expect(page.recorded).toBe(1);
        expect(page.files[0]?.health_issues[0]?.type).toBe('truncated_video');
        expect(page.files[0]?.health_issues[0]?.expected_duration).toBeUndefined();
        expect(page.files[0]?.health_issues[0]?.actual_duration).toBeUndefined();
        expect(page.files[0]?.health_issues.at(-1)?.type).toBe('additional_recorded_evidence');
        expect(page.files[0]?.health_issues).toHaveLength(21);
        expect(JSON.stringify(page).length).toBeLessThan(50000);
        const [stored] = await sql<
            { count: number }[]
        >`SELECT jsonb_array_length(health_issues) AS count
            FROM media_files WHERE id = ${file.id}::uuid`;
        expect(stored.count).toBe(5001);
    });

    it('reports replacement and reclassification in the next snapshot without a long-lived transaction', async () => {
        const [file] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path, health_issues)
            VALUES ('/test/replaced.mkv', ${sql.json(issue)}) RETURNING id`;
        const first = await getFileHealthPage(sql, { scope: 'actionable' });
        expect(first.files[0]?.file_id).toBe(file.id);
        await sql`UPDATE media_files SET health_issues = '[]'::jsonb, updated_at = NOW()
            WHERE id = ${file.id}::uuid`;
        const next = await getFileHealthPage(sql, { scope: 'actionable' });
        expect(next.recorded).toBe(0);
        expect(next.matching).toBe(0);
        expect(next.files).toEqual([]);
    });

    it('keeps counts and rows in the old snapshot when replacement commits between their reads', async () => {
        const [oldFile] = await sql<
            { id: string }[]
        >`INSERT INTO media_files (file_path, health_issues)
            VALUES ('/test/old-warning.mkv', ${sql.json(issue)}) RETURNING id`;
        const reader = postgres(getTestDatabaseUrl(), { max: 1 });
        const writer = postgres(getTestDatabaseUrl(), { max: 1 });
        let countRead = false;
        try {
            // Intercept only the transaction's real count result. Every SELECT below still
            // executes against PostgreSQL; the writer commits before the page SELECT starts.
            const atCountBoundary = new Proxy(reader, {
                get(target, property, receiver) {
                    if (property !== 'begin') return Reflect.get(target, property, receiver);
                    return (isolation: string, callback: (tx: postgres.Sql) => Promise<unknown>) =>
                        target.begin(isolation, (rawTx) =>
                            callback(
                                new Proxy(rawTx as unknown as postgres.Sql, {
                                    apply(tx, thisArg, args: unknown[]) {
                                        const query = Reflect.apply(tx, thisArg, args);
                                        const template = args[0];
                                        if (
                                            !Array.isArray(template) ||
                                            !template
                                                .join('')
                                                .includes('COUNT(*)::text AS recorded')
                                        ) {
                                            return query;
                                        }
                                        return Promise.resolve(query).then(
                                            async (counts: unknown) => {
                                                countRead = true;
                                                await writer.begin(async (writeTx) => {
                                                    await writeTx`UPDATE media_files SET health_issues = '[]'::jsonb
                                            WHERE id = ${oldFile.id}::uuid`;
                                                    await writeTx`INSERT INTO media_files (file_path, health_issues)
                                            VALUES ('/test/new-warning-a.mkv', ${writer.json(issue)}),
                                                   ('/test/new-warning-b.mkv', ${writer.json(issue)})`;
                                                });
                                                return counts;
                                            },
                                        );
                                    },
                                }),
                            ),
                        );
                },
            }) as postgres.Sql;

            const duringReplacement = await getFileHealthPage(atCountBoundary, {
                scope: 'actionable',
            });
            expect(countRead).toBe(true);
            expect(duringReplacement.recorded).toBe(1);
            expect(duringReplacement.actionable).toBe(1);
            expect(duringReplacement.matching).toBe(1);
            expect(duringReplacement.files.map((row) => row.file_id)).toEqual([oldFile.id]);
            expect(duringReplacement.files[0]?.health_issues[0]?.type).toBe('truncated_video');

            const afterReplacement = await getFileHealthPage(reader, { scope: 'actionable' });
            expect(afterReplacement.recorded).toBe(2);
            expect(afterReplacement.actionable).toBe(2);
            expect(afterReplacement.matching).toBe(2);
            expect(afterReplacement.files).toHaveLength(2);
            expect(afterReplacement.files.some((row) => row.file_id === oldFile.id)).toBe(false);
        } finally {
            await Promise.all([reader.end(), writer.end()]);
        }
    });
});
