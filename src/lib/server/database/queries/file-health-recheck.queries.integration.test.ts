// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import postgres from 'postgres';
import {
    getTestDb,
    getTestDatabaseUrl,
    closeTestDb,
} from '../../../../../tests/integration/setup/test-database.js';
import {
    listDueFileHealthRechecks,
    claimFileHealthRecheck,
    FILE_HEALTH_RULE_VERSION,
    FILE_HEALTH_RECHECK_BATCH,
} from './file-health-recheck.queries.js';
import { recheckChangedFileHealth } from '../../tasks/file-health-auto-recheck.js';
const sql = getTestDb();
const prefix = `/invented-health/${crypto.randomUUID()}/`;
const raw = [
    {
        type: 'duration_mismatch',
        expected_duration: 120,
        actual_duration: 100,
        detected_at: '2026-10-27',
    },
];
async function seed(count = 1): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`INSERT INTO media_files(file_path,health_issues)
        SELECT ${prefix} || n || '.mkv', ${sql.json(raw)} FROM generate_series(1,${count}) n RETURNING id`;
    return rows.map((r) => r.id);
}
async function clean(): Promise<void> {
    await sql`DELETE FROM media_file_health_rechecks WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${prefix + '%'})`;
    await sql`DELETE FROM media_files WHERE file_path LIKE ${prefix + '%'}`;
}
// The scheduled pass is global: preceding suites can leave eligible files behind.
// Count this fixture's real callbacks while still executing the unmodified SQL/worker.
async function recheckFile(
    fileId: string,
    signal: AbortSignal,
    check: (fileId: string) => Promise<boolean>,
): Promise<number> {
    let checked = 0;
    await recheckChangedFileHealth(sql, signal, async (id) => {
        if (id !== fileId) return false;
        checked++;
        return check(id);
    });
    return checked;
}
beforeEach(clean);
afterAll(async () => {
    await clean();
    await closeTestDb();
});

it('backs off unchanged inconclusive input, stops after three attempts, and retains raw observations', async () => {
    // Other eligible files must not count as attempts on the file under test.
    const [fileId] = await seed(3);
    const check = vi.fn().mockResolvedValue(false);
    const signal = new AbortController().signal;
    expect(await recheckFile(fileId, signal, check)).toBe(1);
    expect(await recheckFile(fileId, signal, check)).toBe(0);
    for (let attempt = 2; attempt <= 3; attempt++) {
        await sql`UPDATE media_file_health_rechecks SET next_attempt_at=now()-interval '1 second' WHERE file_id=${fileId}`;
        expect(await recheckFile(fileId, signal, check)).toBe(1);
    }
    await sql`UPDATE media_file_health_rechecks SET next_attempt_at=now()-interval '1 second' WHERE file_id=${fileId}`;
    expect(await recheckFile(fileId, signal, check)).toBe(0);
    const [row] = await sql`SELECT * FROM media_file_health_rechecks WHERE file_id=${fileId}`;
    expect(row.attempts).toBe(3);
    expect(row.observations).toHaveLength(3);
    expect(row.observations[0].issues).toEqual(raw);
    expect(check).toHaveBeenCalledTimes(3);
    expect(
        (await sql`SELECT health_issues FROM media_files WHERE id=${fileId}`)[0].health_issues,
    ).toEqual(raw);
});

it('settled warnings wait for changed file, stream inventory or assessment rules', async () => {
    const [fileId] = await seed();
    const signal = new AbortController().signal;
    const check = vi.fn().mockResolvedValue(true);
    expect(await recheckFile(fileId, signal, check)).toBe(1);
    expect(await recheckFile(fileId, signal, check)).toBe(0);
    // Detection dates and health bookkeeping do not represent new input.
    await sql`UPDATE media_files SET health_issues=${sql.json([{ ...raw[0], detected_at: '2026-10-28', actual_duration: 99, attempt_count: 50 }])} WHERE id=${fileId}`;
    expect(await recheckFile(fileId, signal, check)).toBe(0);
    await sql`UPDATE media_files SET file_size_bytes=123 WHERE id=${fileId}`;
    expect(await recheckFile(fileId, signal, check)).toBe(1);
    await sql`INSERT INTO media_streams(file_id,stream_index,stream_type,codec) VALUES (${fileId},0,'audio','aac')`;
    expect(await recheckFile(fileId, signal, check)).toBe(1);
    const futureRules = FILE_HEALTH_RULE_VERSION + 1;
    const due = await listDueFileHealthRechecks(sql, futureRules);
    expect(due.map((r) => r.fileId)).toContain(fileId);
    expect(
        await claimFileHealthRecheck(
            sql,
            due.find((r) => r.fileId === fileId)!,
            futureRules,
        ),
    ).toBe(true);
});

it('claims across independent connections once and rejects a stale generation', async () => {
    const [fileId] = await seed();
    const candidate = (await listDueFileHealthRechecks(sql)).find((r) => r.fileId === fileId)!;
    const workers = Array.from({ length: 3 }, () => postgres(getTestDatabaseUrl(), { max: 1 }));
    try {
        // Exercise both the initial INSERT and a due retry's ON CONFLICT branch.
        for (const attempts of [1, 2]) {
            if (attempts > 1) {
                await sql`UPDATE media_file_health_rechecks SET next_attempt_at=now()-interval '1 second' WHERE file_id=${fileId}`;
            }
            const results = await Promise.all(
                workers.map((db) => claimFileHealthRecheck(db, candidate)),
            );
            expect(results.filter(Boolean)).toHaveLength(1);
            const [row] =
                await sql`SELECT attempts, observations FROM media_file_health_rechecks WHERE file_id=${fileId} AND input_key=${candidate.inputKey}`;
            expect(row.attempts).toBe(attempts);
            expect(row.observations).toHaveLength(attempts);
        }
        await sql`UPDATE media_files SET file_size_bytes=999 WHERE id=${fileId}`;
        expect(await claimFileHealthRecheck(sql, candidate)).toBe(false);
    } finally {
        await Promise.all(workers.map((db) => db.end()));
    }
});

it('caps each pass and cancellation stops every remaining pending file', async () => {
    await seed(FILE_HEALTH_RECHECK_BATCH + 5);
    expect(await listDueFileHealthRechecks(sql)).toHaveLength(FILE_HEALTH_RECHECK_BATCH);
    const controller = new AbortController();
    const check = vi.fn().mockImplementation(async () => {
        controller.abort();
        return false;
    });
    await expect(recheckChangedFileHealth(sql, controller.signal, check)).rejects.toThrow();
    expect(check).toHaveBeenCalledTimes(1);
    const [row] =
        await sql`SELECT count(*)::int AS n FROM media_file_health_rechecks WHERE file_id IN (SELECT id FROM media_files WHERE file_path LIKE ${prefix + '%'})`;
    expect(row.n).toBe(1);
    expect(
        await recheckChangedFileHealth(sql, new AbortController().signal, async () => true),
    ).toBe(FILE_HEALTH_RECHECK_BATCH);
    expect(
        await recheckChangedFileHealth(sql, new AbortController().signal, async () => true),
    ).toBe(4);
});
