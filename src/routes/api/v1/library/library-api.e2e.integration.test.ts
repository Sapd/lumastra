// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * E2E integration test: route → orchestrator → BullMQ → TaskRunner →
 * file-delta-ingest / file-library-scan → media_files.
 *
 * Requires:
 *   - TEST_DATABASE_URL pointing at lumastra_tests (migrated).
 *   - CACHE_URL pointing at a Valkey instance.
 *
 * Skipped automatically when either env var is absent.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { Queue } from 'bullmq';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';

// ── Hoisted mock helpers ──────────────────────────────────────────────────────
// vi.mock() factories run before imports. We need testSqlRef to be available
// via closure when the mocked modules are called later (after beforeAll sets it).

let testSqlRef: postgres.Sql | null = null;

// ── Module mocks ──────────────────────────────────────────────────────────────

// Mock authenticate to bypass PAT/svc-token validation in every route.
vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return {
        ...real,
        authenticate: vi.fn().mockResolvedValue({
            tokenKind: 'pat',
            tokenId: 'e2e-test-token',
            userId: 'e2e-testuser',
            scopes: ['admin'],
        }),
    };
});

// Mock aiDbService.getSql() — used by /paths and /ingest routes to obtain a
// database connection. Closure over testSqlRef: by the time any route handler
// calls getSql(), beforeAll has set testSqlRef to the live test DB handle.
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => testSqlRef },
}));

// Mock database/connection.js so the module-level orchestrator singleton uses
// the test DB when getOrchestrator() lazily initialises (via getTaskDb()).
vi.mock('$lib/server/database/connection.js', () => ({
    getTaskDb: () => testSqlRef,
    getDb: () => testSqlRef,
    testDbConnection: async () => true,
    Database: class {},
}));

// Mock $lib/server/config.js — set dev=false so auditTriggerCoverage() logs
// rather than throws when it finds tasks without a trigger declaration. In a
// real production boot the same audit only logs, never crashes.
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...real, dev: false };
});

// ── Route handler imports (after mocks are registered) ────────────────────────
// NOTE: imports the canonical `/api/v1/libraries/*` route handlers. The legacy
// singular `/api/v1/library/paths|scan|ingest` routes were deleted (zero
// callers across tvOS/SPA/internal repo) — they hand-mounted the exact same
// `defs/library/*` defs as these canonical routes, so this test's coverage of
// the underlying pipeline (orchestrator → BullMQ → TaskRunner → file-delta-
// ingest / file-library-scan → media_files) is unaffected.
import { GET as pathsGET } from '../libraries/paths/+server.js';
import { POST as ingestPOST } from '../libraries/ingest/+server.js';
import { POST as scanPOST } from '../libraries/scan/+server.js';

// ── Task system imports ───────────────────────────────────────────────────────
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey.js';
import { requireClient } from '$lib/server/tasks/valkey-types.js';
import { TaskRunner } from '$lib/server/tasks/runner.js';
import { RESOURCE_CLASSES } from '@sapd/lumastra-plugin-sdk';
import { getQueueConnectionOptions } from '$lib/server/tasks/connection.js';
import { PER_TASK_QUEUE_PREFIX, QUEUE_PREFIX } from '$lib/server/tasks/queue-naming.js';
import { registry } from '$lib/server/tasks/registry.js';
import { loadBuiltins, _resetLoadedForTests } from '$lib/server/tasks/builtin/index.js';
import {
    createLibraryPath,
    deleteLibraryPath,
    updateLibraryPath,
} from '$lib/server/database/queries/library-paths.queries.js';

// ── Constants ─────────────────────────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? '';
const CACHE_URL = process.env.CACHE_URL ?? '';
const RUN = TEST_DATABASE_URL && CACHE_URL;

const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000088';

// ── Helpers ───────────────────────────────────────────────────────────────────

async function clearQueues(): Promise<void> {
    const connection = getQueueConnectionOptions();
    if (!connection) throw new Error('Test task store unavailable');
    const queues = [
        ...RESOURCE_CLASSES.map((name) => ({ name, prefix: QUEUE_PREFIX })),
        ...registry.getAllTasks().map((task) => ({ name: task.id, prefix: PER_TASK_QUEUE_PREFIX })),
    ];
    await Promise.all(
        queues.map(async ({ name, prefix }) => {
            const queue = new Queue(name, { connection, prefix });
            try {
                await queue.obliterate({ force: true });
            } finally {
                await queue.close();
            }
        }),
    );
}

async function waitForState(
    sql: postgres.Sql,
    runId: string,
    targetStates: string[],
    timeoutMs = 15_000,
): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const rows = await sql<{ state: string }[]>`
            SELECT state FROM task_history WHERE id = ${runId}
        `;
        const state = rows[0]?.state;
        if (state && targetStates.includes(state)) return state;
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const rows = await sql`SELECT state, error FROM task_history WHERE id = ${runId}`;
    throw new Error(`Run ${runId} did not reach ${targetStates.join('/')}: ${JSON.stringify(rows)}`);
}

// Return type is a generic defaulting to RequestEvent: when the result is
// passed straight into a route handler, TS infers `E` from that handler's
// expected `RequestEvent<RouteParams, "/api/v1/library/...">`, so the generic
// default route id (`string | null`) doesn't clash with the route literal.
function makeEvent<E = RequestEvent>(
    method: string,
    url: string,
    body?: unknown,
    headers?: Record<string, string>,
): E {
    return {
        request: new Request(url, {
            method,
            headers: { 'Content-Type': 'application/json', ...headers },
            body: body !== undefined ? JSON.stringify(body) : undefined,
        }),
        params: {},
        url: new URL(url),
        locals: { user: null },
    } as unknown as E;
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe.runIf(RUN)('Library API e2e (route → orchestrator → runner → DB)', () => {
    let sql: postgres.Sql;
    let runner: TaskRunner;
    let tempDir: string;
    let libraryPathId: string;
    let seededFilePath: string;

    beforeAll(async () => {
        // Establish a direct test-DB connection (separate from the mocked one).
        const pgModule = await import('postgres');
        const pg = pgModule.default;
        sql = pg(TEST_DATABASE_URL, { max: 5 });

        // Store in the module-level ref so mocked modules return this connection.
        testSqlRef = sql;

        await connectValkey();

        // Sanity-check DB schema.
        try {
            await sql`SELECT 1 FROM task_history LIMIT 0`;
        } catch (err) {
            throw new Error(
                `task_history table missing — run db:test:migrate first. ${(err as Error).message}`,
                { cause: err },
            );
        }

        // Seed the library group row.
        await sql`
            INSERT INTO library_groups (id, name)
            VALUES (${TEST_GROUP_ID}, 'Library API E2E Test Group')
            ON CONFLICT DO NOTHING
        `;

        // Create a real temp directory as the library root.
        tempDir = await mkdtemp(join(tmpdir(), 'lumastra-lib-e2e-'));

        // Exercise real successful ingest. A zero-byte stub makes the scanner
        // report a total outage and retry the run across its full backoff budget.
        const movieDir = join(tempDir, 'Movie Test E2E (2020) [imdbid-tt9999999]');
        seededFilePath = join(movieDir, 'm.mkv');
        await mkdir(movieDir, { recursive: true });
        await promisify(execFile)(
            process.env.FFMPEG_PATH ?? 'ffmpeg',
            [
                '-hide_banner',
                '-loglevel',
                'error',
                '-f',
                'lavfi',
                '-i',
                'color=c=black:s=32x32:r=1',
                '-t',
                '2',
                '-c:v',
                'ffv1',
                '-threads',
                '1',
                seededFilePath,
            ],
            { timeout: 10_000 },
        );

        // Seed a library_path pointing at tempDir.
        const lp = await createLibraryPath(sql, {
            path: tempDir,
            media_type: 'movie',
            library_group_id: TEST_GROUP_ID,
        });
        libraryPathId = lp.id;

        // Load builtins into the defaultRegistry BEFORE starting the runner.
        // The runner (per-task-queue mode) iterates registry.getAllTasks() at
        // start time — if loadBuiltins() hasn't run yet, no per-task workers
        // are created and no jobs ever get processed.
        _resetLoadedForTests();
        await loadBuiltins();
        // The runner consumes every registered task. Remove work retained by
        // previous fixtures before it can execute against this file's SQL rows.
        await clearQueues();

        // Start the task runner so it can process jobs enqueued by the orchestrator.
        runner = await TaskRunner.start([...RESOURCE_CLASSES], {
            getSql: () => testSqlRef,
            // Identity renewal and admission must use the same task store as
            // the orchestrator and state machine, not the disposable cache.
            getClient: requireClient,
            instanceId: 'e2e-integration-test',
            bootId: ulid(),
            heartbeatIntervalMs: 1_000,
            // Disable cancel-channel subscription to avoid needing a second
            // Valkey subscriber — tests don't need soft-cancel.
            subscribe: async () => null,
        });
    }, 60_000);

    afterAll(async () => {
        // Stop the runner.
        if (runner) await runner.stop().catch(() => undefined);

        // Stop the orchestrator singleton.
        const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
        await orchestrator.stop().catch(() => undefined);

        // Obliterate all BullMQ queues used by the runner so stale jobs don't
        // bleed into subsequent test files.
        await clearQueues();

        // Clean up test data.
        if (sql) {
            await sql`DELETE FROM media_files WHERE file_path LIKE ${tempDir + '%'}`.catch(
                () => undefined,
            );
            if (libraryPathId) {
                await deleteLibraryPath(sql, libraryPathId).catch(() => undefined);
            }
            await sql`
                DELETE FROM library_groups WHERE id = ${TEST_GROUP_ID}
            `.catch(() => undefined);
            await sql`
                DELETE FROM task_history WHERE id LIKE 'run_%'
                AND input::text LIKE ${'%' + libraryPathId + '%'}
            `.catch(() => undefined);
        }

        await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
        await disconnectValkey().catch(() => undefined);
        await sql?.end().catch(() => undefined);
    }, 30_000);

    beforeEach(async () => {
        // Clean media_files rows from previous tests.
        await sql`DELETE FROM media_files WHERE file_path LIKE ${tempDir + '%'}`;
    });

    // ── Scenario 1: GET /api/v1/libraries/paths ─────────────────────────────────

    it('GET /api/v1/libraries/paths returns 200 and includes the seeded path with sourcePrefix field', async () => {
        const res = await pathsGET!(makeEvent('GET', 'http://localhost/api/v1/libraries/paths'));
        expect(res.status).toBe(200);

        const body = (await res.json()) as {
            paths: Array<{ id: string; sourcePrefix?: string | null }>;
        };
        expect(Array.isArray(body.paths)).toBe(true);

        const seeded = body.paths.find((p) => p.id === libraryPathId);
        expect(seeded).toBeDefined();
        // sourcePrefix field must be present (null is acceptable for a path without a prefix).
        expect('sourcePrefix' in seeded!).toBe(true);
    });

    // ── Scenario 2: POST /api/v1/libraries/ingest upsert ───────────────────────

    it('POST /api/v1/libraries/ingest upsert → 202, run reaches completed state', async () => {
        const relPath = 'Movie Test E2E (2020) [imdbid-tt9999999]/m.mkv';
        const reqBody = {
            libraryPathId,
            changes: [{ path: relPath, op: 'upsert' }],
        };

        const res = await ingestPOST!(
            makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody),
        );
        expect(res.status).toBe(202);

        const resBody = (await res.json()) as {
            runId: string;
            deduped: boolean | undefined;
            accepted: { upsert: number; remove: number };
        };
        expect(resBody.runId).toMatch(/^run_/);
        expect(resBody.accepted.upsert).toBe(1);
        expect(resBody.accepted.remove).toBe(0);

        // Wait for the run to reach a terminal state.
        const finalState = await waitForState(sql, resBody.runId, ['completed', 'failed'], 25_000);
        expect(finalState).toBe('completed');
    }, 35_000);

    // ── Scenario 3: POST /api/v1/libraries/ingest remove ───────────────────────

    it('POST /api/v1/libraries/ingest remove → 202, run completes, row deleted', async () => {
        // Pre-seed a media_files row so the remove has something to delete.
        await sql`
            INSERT INTO media_files (file_path)
            VALUES (${seededFilePath})
            ON CONFLICT (file_path) DO NOTHING
        `;

        const relPath = 'Movie Test E2E (2020) [imdbid-tt9999999]/m.mkv';
        const reqBody = {
            libraryPathId,
            changes: [{ path: relPath, op: 'remove' }],
        };

        const res = await ingestPOST!(
            makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody),
        );
        expect(res.status).toBe(202);

        const resBody = (await res.json()) as {
            runId: string;
            accepted: { upsert: number; remove: number };
        };
        expect(resBody.accepted.remove).toBe(1);

        const finalState = await waitForState(sql, resBody.runId, ['completed', 'failed'], 25_000);
        expect(finalState).toBe('completed');

        // Row must be gone.
        const files = await sql<{ file_path: string }[]>`
            SELECT file_path FROM media_files WHERE file_path = ${seededFilePath}
        `;
        expect(files.length).toBe(0);
    }, 35_000);

    // ── Scenario 4: Traversal escape → 422 validation_failed ─────────────────

    it('POST /api/v1/libraries/ingest with path traversal → 422 validation_failed', async () => {
        const reqBody = {
            libraryPathId,
            changes: [{ path: '../escape.mkv', op: 'upsert' }],
        };

        const res = await ingestPOST!(
            makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody),
        );
        // normalizeDelta detects the '..' segment; the route rejects invalid input with
        // the canonical contract status — 422 application/problem+json validation_failed.
        expect(res.status).toBe(422);
        expect((await res.json()).code).toBe('validation_failed');
    });

    // ── Scenario 5: POST /api/v1/libraries/scan → 202, terminates ──────────────

    it('POST /api/v1/libraries/scan → 202, run reaches a terminal state', async () => {
        const reqBody = { libraryPathId };

        const res = await scanPOST!(
            makeEvent('POST', 'http://localhost/api/v1/libraries/scan', reqBody),
        );
        // A fresh scan (no prior Idempotency-Key) should return 202.
        // If the orchestrator deduped (e.g. file-library-scan identity still in
        // Valkey from a prior test run), it returns 200 — accept both.
        expect([200, 202]).toContain(res.status);

        const resBody = (await res.json()) as {
            runId: string;
            deduped?: boolean;
            statusUrl: string;
        };
        expect(resBody.runId).toMatch(/^run_/);
        // deduped is optional — when false the field is absent from JSON
        // (StartRunResult.deduped?: boolean).

        const finalState = await waitForState(sql, resBody.runId, ['completed', 'failed'], 35_000);
        expect(finalState).toBe('completed');
    }, 45_000);

    // ── Scenario 6: Idempotency-Key deduplication ────────────────────────────

    it('second request with same Idempotency-Key returns deduped:true and same runId', async () => {
        const idempotencyKey = `e2e-idem-${ulid()}`;
        const relPath = 'Movie Test E2E (2020) [imdbid-tt9999999]/m.mkv';
        const reqBody = {
            libraryPathId,
            changes: [{ path: relPath, op: 'upsert' }],
        };

        // Fire BOTH requests in parallel before either has time to complete.
        // Idempotency dedup only matches state IN ('pending','active','cancelling').
        // Sending them concurrently guarantees the second hits while the first
        // run is still in-flight (even for a fast empty-file task).
        const [res1, res2] = await Promise.all([
            ingestPOST!(
                makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody, {
                    'idempotency-key': idempotencyKey,
                }),
            ),
            ingestPOST!(
                makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody, {
                    'idempotency-key': idempotencyKey,
                }),
            ),
        ]);

        // One request should be the original (202, deduped=false/absent)
        // and the other the dedup (200, deduped=true). Because both fire
        // simultaneously we don't know which wins, but together they should
        // yield exactly one 202 and one 200.
        const statuses = [res1.status, res2.status].sort();
        expect(statuses).toEqual([200, 202]);

        const body1 = (await res1.json()) as { runId: string; deduped?: boolean };
        const body2 = (await res2.json()) as { runId: string; deduped?: boolean };

        // Both runIds must be the same (the original run).
        expect(body1.runId).toBe(body2.runId);
        // Exactly one of them must be deduped=true.
        const dedupedCount = [body1.deduped, body2.deduped].filter(Boolean).length;
        expect(dedupedCount).toBe(1);

        // Wait for the run to finish.
        await waitForState(sql, body1.runId, ['completed', 'failed'], 20_000);
    }, 40_000);

    // ── Scenario 7: sourceUri ingest — resolves via source_prefix → media_files ─

    describe('sourceUri ingest (S3-style URI resolved via source_prefix)', () => {
        const S3_PREFIX = 's3://test-bucket/movies/';
        const MOVIE_REL = 'Movie Test E2E (2020) [imdbid-tt9999999]/m.mkv';

        beforeAll(async () => {
            // Attach source_prefix to the shared library path so sourceUri
            // resolution can map the s3:// scheme to the on-disk tempDir root.
            await updateLibraryPath(sql, libraryPathId, { source_prefix: S3_PREFIX });
        });

        afterAll(async () => {
            // Clear source_prefix so it doesn't affect other scenarios if test
            // ordering ever changes.
            await updateLibraryPath(sql, libraryPathId, { source_prefix: null }).catch(
                () => undefined,
            );
        });

        it('POST ingest upsert via sourceUri → 202, accepted.upsert === 1', async () => {
            const sourceUri = S3_PREFIX + MOVIE_REL;
            // No libraryPathId in the body — resolution must come from source_prefix.
            const reqBody = {
                changes: [{ sourceUri, op: 'upsert' }],
            };

            const res = await ingestPOST!(
                makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody),
            );
            expect(res.status).toBe(202);

            const resBody = (await res.json()) as {
                runId: string;
                accepted: { upsert: number; remove: number };
            };
            expect(resBody.runId).toMatch(/^run_/);
            expect(resBody.accepted.upsert).toBe(1);
            expect(resBody.accepted.remove).toBe(0);

            // Run must reach a terminal state.
            const finalState = await waitForState(
                sql,
                resBody.runId,
                ['completed', 'failed'],
                25_000,
            );
            expect(finalState).toBe('completed');
        }, 35_000);

        it('POST ingest remove via sourceUri → run completes, media_files row gone', async () => {
            const resolvedPath = join(tempDir, MOVIE_REL);
            // Pre-seed the row so the remove task has something to delete.
            await sql`
                INSERT INTO media_files (file_path)
                VALUES (${resolvedPath})
                ON CONFLICT (file_path) DO NOTHING
            `;

            const sourceUri = S3_PREFIX + MOVIE_REL;
            const reqBody = {
                changes: [{ sourceUri, op: 'remove' }],
            };

            const res = await ingestPOST!(
                makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody),
            );
            expect(res.status).toBe(202);

            const resBody = (await res.json()) as {
                runId: string;
                accepted: { upsert: number; remove: number };
            };
            expect(resBody.accepted.remove).toBe(1);

            const finalState = await waitForState(
                sql,
                resBody.runId,
                ['completed', 'failed'],
                25_000,
            );
            expect(finalState).toBe('completed');

            // The row must be gone — proves the task resolved the sourceUri to the
            // on-disk path (resolvedPath) rather than storing the s3:// URI.
            const rows = await sql<{ file_path: string }[]>`
                SELECT file_path FROM media_files WHERE file_path = ${resolvedPath}
            `;
            expect(rows.length).toBe(0);
        }, 35_000);

        it('sourceUri whose prefix matches no library path → 422 validation_failed', async () => {
            const reqBody = {
                changes: [{ sourceUri: 's3://unknown-bucket/other/file.mkv', op: 'upsert' }],
            };
            const res = await ingestPOST!(
                makeEvent('POST', 'http://localhost/api/v1/libraries/ingest', reqBody),
            );
            expect(res.status).toBe(422);
            expect((await res.json()).code).toBe('validation_failed');
        });
    });
});
