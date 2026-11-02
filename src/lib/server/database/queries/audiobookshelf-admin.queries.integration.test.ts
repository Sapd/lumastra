// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Read models behind the AudiobookShelf admin settings section.
 *
 * Tested against a real database rather than fixtures because every field here
 * is a shape claim about Postgres, and this integration's recurring failure is a
 * correctly-typed read of a shape that never carried the data:
 *
 *  - `task_history.duration_ms` is a GENERATED column and arrives as a string.
 *  - `task_history.result` / `.error` are jsonb, so a run that failed before the
 *    sweep returned has no counters at all — reporting zeros there is
 *    indistinguishable from a clean no-op sync.
 *  - the per-user credential is TWO rows (`api_key` + `api_key_id`), so a naive
 *    select lists every linked user twice, and `BOOL_OR` is what decides whether
 *    the key can actually be revoked upstream.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    getRecentAudiobookshelfSyncRuns,
    getAudiobookshelfLinkedUsers,
    AUDIOBOOKSHELF_SYNC_TASK_ID,
} from './audiobookshelf-admin.queries.js';

const USER_A = '00000000-0000-0000-0000-0000000abc01';
const USER_B = '00000000-0000-0000-0000-0000000abc02';
const RUN_PREFIX = 'run_abs_admin_test_';

describe('audiobookshelf admin read models', () => {
    let sql: postgres.Sql;

    /**
     * Insert a run the way the RUNNER does.
     *
     * `counters` is wrapped in the `TaskResult` envelope
     * (`{ success, itemsProcessed, result: counters }`) because that whole
     * wrapper is what `writeTerminalToPostgres` stores in
     * `task_history.result`. Building the fixture from the inner payload alone
     * is what let a one-level-off read pass its tests while reporting "no
     * counters" for every real run.
     */
    async function insertRun(
        suffix: string,
        state: string,
        startedAt: string,
        counters: Record<string, unknown> | null,
        error: unknown = null,
        completedAt: string | null = null,
    ): Promise<void> {
        const result =
            counters === null
                ? null
                : {
                      success: true,
                      itemsProcessed:
                          Number(counters.added ?? 0) +
                          Number(counters.updated ?? 0) +
                          Number(counters.dismissed ?? 0),
                      result: counters,
                  };
        await sql`
            INSERT INTO task_history (
                id, task_id, label, state, input, trigger, actor,
                started_at, completed_at, processing_version, stages, result, error
            ) VALUES (
                ${RUN_PREFIX + suffix}, ${AUDIOBOOKSHELF_SYNC_TASK_ID}, 'AudiobookShelf Sync',
                ${state}, '{}'::jsonb, '{"kind":"manual"}'::jsonb, '{}'::jsonb,
                ${startedAt}, ${completedAt}, '1', '[]'::jsonb,
                ${result === null ? null : sql.json(result as never)},
                ${error === null ? null : sql.json(error as never)}
            )
        `;
    }

    beforeAll(async () => {
        sql = await getTestDb();
    });

    afterAll(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE ${RUN_PREFIX + '%'}`;
        await sql`DELETE FROM plugin_user_credentials WHERE user_id IN (${USER_A}, ${USER_B})`;
        await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM task_history WHERE id LIKE ${RUN_PREFIX + '%'}`;
        // getAudiobookshelfLinkedUsers() is an UNSCOPED read: it returns every
        // user in the database holding an audiobookshelf credential. Clearing
        // only USER_A/USER_B left that read universe open, so any user another
        // integration file created and did not remove showed up in the result —
        // and the assertions here are absolute ("resolves to []", "equals
        // ['alice','Zoe']"), not filtered to this file's fixtures. In CI five
        // foreign users leaked in and took 4 of these 17 tests red, while the
        // file passed in isolation.
        //
        // A test that asserts on a global read has to own the global state it
        // reads. Deleting by plugin_id rather than by user is what makes that
        // true, and it is safe because integration files run sequentially
        // (fileParallelism: false) and each sets up its own fixtures. The
        // afterAll below stays scoped to this file's own rows on purpose.
        // The plugin id is INLINE, not imported. Pulling
        // AUDIOBOOKSHELF_PLUGIN_ID from
        // `$lib/server/services/audiobookshelf-credentials.service.js` here made
        // sonic-taste fail immediately afterwards with an unrelated
        // media_file_items FK violation: the queries module under test already
        // imports that service RELATIVELY, so the alias import resolves to a
        // second module id and instantiates the graph a second time, side
        // effects included. Measured both ways — literal 20/20, imported 17/20.
        // If you want the constant, re-export it from the queries module this
        // file already imports; do not add the alias import back.
        await sql`DELETE FROM plugin_user_credentials WHERE plugin_id = 'audiobookshelf'`;
        await sql`DELETE FROM users WHERE id IN (${USER_A}, ${USER_B})`;
    });

    describe('getRecentAudiobookshelfSyncRuns', () => {
        it('returns nothing when the task has never run', async () => {
            await expect(getRecentAudiobookshelfSyncRuns(sql)).resolves.toEqual([]);
        });

        it('parses the counters out of jsonb as real numbers', async () => {
            await insertRun(
                'ok',
                'completed',
                '2026-07-30T10:00:00Z',
                { added: 7, updated: 2, dismissed: 1, unmatched: 0, skipped: 44, errors: [] },
                null,
                '2026-07-30T10:02:30Z',
            );

            const [run] = await getRecentAudiobookshelfSyncRuns(sql);
            expect(run.counters).toEqual({
                added: 7,
                updated: 2,
                dismissed: 1,
                unmatched: 0,
                skipped: 44,
                errors: [],
            });
            // Arithmetic, not concatenation: a string 7 would make this "72".
            expect(run.counters!.added + run.counters!.updated).toBe(9);
        });

        it('reads the counters from INSIDE the TaskResult envelope, not the top level', async () => {
            // Pins the nesting explicitly. `writeTerminalToPostgres` stores the
            // whole `TaskResult` — `{ success, itemsProcessed, result: {...} }` —
            // so a read of `result.added` finds nothing and the panel reports
            // "this run reported no counters" for every successful sync. Written
            // as raw JSON rather than through the helper so the shape under test
            // cannot drift with the helper.
            await sql`
                INSERT INTO task_history (
                    id, task_id, label, state, input, trigger, actor,
                    started_at, completed_at, processing_version, stages, result
                ) VALUES (
                    ${RUN_PREFIX + 'envelope'}, ${AUDIOBOOKSHELF_SYNC_TASK_ID}, 'AudiobookShelf Sync',
                    'completed', '{}'::jsonb, '{"kind":"manual"}'::jsonb, '{}'::jsonb,
                    '2026-07-30T10:00:00Z', '2026-07-30T10:00:01Z', '1', '[]'::jsonb,
                    ${sql.json({
                        success: true,
                        itemsProcessed: 12,
                        result: {
                            added: 9,
                            updated: 2,
                            dismissed: 1,
                            unmatched: 0,
                            skipped: 3,
                            errors: [],
                        },
                    } as never)}
                )
            `;

            const [run] = await getRecentAudiobookshelfSyncRuns(sql);
            expect(run.counters).not.toBeNull();
            expect(run.counters!.added).toBe(9);
            expect(run.counters!.skipped).toBe(3);
        });

        it('still reports NULL counters when the envelope carries no payload', async () => {
            // A wrapper with `result: undefined` (a task that returned only
            // success/itemsProcessed) must not read as zeroed counters.
            await sql`
                INSERT INTO task_history (
                    id, task_id, label, state, input, trigger, actor,
                    started_at, completed_at, processing_version, stages, result
                ) VALUES (
                    ${RUN_PREFIX + 'nopayload'}, ${AUDIOBOOKSHELF_SYNC_TASK_ID}, 'AudiobookShelf Sync',
                    'completed', '{}'::jsonb, '{"kind":"manual"}'::jsonb, '{}'::jsonb,
                    '2026-07-30T10:00:00Z', '2026-07-30T10:00:01Z', '1', '[]'::jsonb,
                    ${sql.json({ success: true, itemsProcessed: 0 } as never)}
                )
            `;

            const [run] = await getRecentAudiobookshelfSyncRuns(sql);
            expect(run.counters).toBeNull();
        });

        it('reads duration_ms (a GENERATED column) as a number', async () => {
            await insertRun(
                'dur',
                'completed',
                '2026-07-30T10:00:00Z',
                { added: 0, updated: 0, dismissed: 0, unmatched: 0, skipped: 0, errors: [] },
                null,
                '2026-07-30T10:00:02Z',
            );

            const [run] = await getRecentAudiobookshelfSyncRuns(sql);
            expect(typeof run.durationMs).toBe('number');
            expect(run.durationMs).toBe(2000);
        });

        it('reports NULL counters — not zeros — for a run that died before the sweep returned', async () => {
            // The distinction the whole panel hinges on. Zeros here would render
            // as a successful sync that found nothing to do.
            await insertRun('failed', 'failed', '2026-07-30T11:00:00Z', null, {
                message: 'AudiobookShelf sync: no progress across 3 error(s)',
            });

            const [run] = await getRecentAudiobookshelfSyncRuns(sql);
            expect(run.counters).toBeNull();
            expect(run.errorMessage).toContain('no progress');
            expect(run.state).toBe('failed');
        });

        it('surfaces the sweep error strings, which is how a tripped rail is visible', async () => {
            // A tripped dismissal rail SUPPRESSES removals, so it looks like a
            // clean sync (`dismissed: 0`, state `completed`) unless these are read.
            await insertRun(
                'rail',
                'completed',
                '2026-07-30T12:00:00Z',
                {
                    added: 0,
                    updated: 0,
                    dismissed: 0,
                    unmatched: 0,
                    skipped: 120,
                    errors: ['dismissal threshold exceeded for library abs://x; nothing hidden'],
                },
                null,
                '2026-07-30T12:00:05Z',
            );

            const [run] = await getRecentAudiobookshelfSyncRuns(sql);
            expect(run.state).toBe('completed');
            expect(run.counters!.dismissed).toBe(0);
            expect(run.counters!.errors).toHaveLength(1);
            expect(run.counters!.errors[0]).toMatch(/dismissal threshold/);
        });

        it('sorts newest first and puts an in-flight run at the top', async () => {
            const done = {
                added: 1,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 0,
                errors: [],
            };
            await insertRun(
                'old',
                'completed',
                '2026-07-30T08:00:00Z',
                done,
                null,
                '2026-07-30T08:00:01Z',
            );
            await insertRun(
                'mid',
                'completed',
                '2026-07-30T09:00:00Z',
                done,
                null,
                '2026-07-30T09:00:01Z',
            );
            // Running: completed_at IS NULL. Ordering on completed_at would drop
            // it to the bottom (or to the top on some collations) — either way the
            // operator's first question ("is it running now?") gets the wrong answer.
            await insertRun('running', 'active', '2026-07-30T10:00:00Z', null);

            const runs = await getRecentAudiobookshelfSyncRuns(sql);
            expect(runs.map((r) => r.runId)).toEqual([
                RUN_PREFIX + 'running',
                RUN_PREFIX + 'mid',
                RUN_PREFIX + 'old',
            ]);
            expect(runs[0].completedAt).toBeNull();
            expect(runs[0].durationMs).toBeNull();
        });

        it('honours the limit', async () => {
            const done = {
                added: 0,
                updated: 0,
                dismissed: 0,
                unmatched: 0,
                skipped: 0,
                errors: [],
            };
            for (let i = 0; i < 5; i++) {
                await insertRun(
                    `n${i}`,
                    'completed',
                    `2026-07-30T0${i}:00:00Z`,
                    done,
                    null,
                    `2026-07-30T0${i}:00:01Z`,
                );
            }
            expect(await getRecentAudiobookshelfSyncRuns(sql, 2)).toHaveLength(2);
        });

        it('ignores other tasks’ runs', async () => {
            await sql`
                INSERT INTO task_history (
                    id, task_id, label, state, input, trigger, actor,
                    started_at, processing_version, stages
                ) VALUES (
                    ${RUN_PREFIX + 'other'}, 'file-library-scan', 'Scan', 'completed',
                    '{}'::jsonb, '{"kind":"manual"}'::jsonb, '{}'::jsonb,
                    '2026-07-30T10:00:00Z', '1', '[]'::jsonb
                )
            `;
            await expect(getRecentAudiobookshelfSyncRuns(sql)).resolves.toEqual([]);
        });
    });

    describe('getAudiobookshelfLinkedUsers', () => {
        async function insertUser(id: string, username: string, jf: string | null): Promise<void> {
            await sql`
                INSERT INTO users (id, username, jellyfin_username)
                VALUES (${id}, ${username}, ${jf})
            `;
        }

        async function insertCred(
            userId: string,
            key: string,
            createdAt: string,
            used: string | null,
        ): Promise<void> {
            await sql`
                INSERT INTO plugin_user_credentials (plugin_id, user_id, key, value_encrypted, created_at, last_accessed_at)
                VALUES ('audiobookshelf', ${userId}, ${key}, '\\x00'::bytea, ${createdAt}, ${used})
            `;
        }

        it('returns nothing when nobody is linked', async () => {
            await expect(getAudiobookshelfLinkedUsers(sql)).resolves.toEqual([]);
        });

        it('lists a linked user ONCE despite the credential being two rows', async () => {
            await insertUser(USER_A, 'denis', null);
            await insertCred(USER_A, 'api_key', '2026-07-01T00:00:00Z', '2026-07-29T12:00:00Z');
            await insertCred(USER_A, 'api_key_id', '2026-07-01T00:00:00Z', null);

            const rows = await getAudiobookshelfLinkedUsers(sql);
            expect(rows).toHaveLength(1);
            expect(rows[0].username).toBe('denis');
            expect(rows[0].revocable).toBe(true);
        });

        it('marks a user NOT revocable when the upstream key id was never stored', async () => {
            // Without the key id, unlink can only drop the local row; the upstream
            // key stays live. The operator has to see that before clicking revoke.
            await insertUser(USER_A, 'denis', null);
            await insertCred(USER_A, 'api_key', '2026-07-01T00:00:00Z', null);

            const [row] = await getAudiobookshelfLinkedUsers(sql);
            expect(row.revocable).toBe(false);
        });

        it('reports the earliest mint and the latest use', async () => {
            await insertUser(USER_A, 'denis', null);
            await insertCred(USER_A, 'api_key', '2026-07-01T00:00:00Z', '2026-07-20T00:00:00Z');
            await insertCred(USER_A, 'api_key_id', '2026-07-05T00:00:00Z', '2026-07-28T00:00:00Z');

            const [row] = await getAudiobookshelfLinkedUsers(sql);
            expect(row.mintedAt?.toISOString()).toBe('2026-07-01T00:00:00.000Z');
            expect(row.lastUsedAt?.toISOString()).toBe('2026-07-28T00:00:00.000Z');
        });

        it('exposes jellyfin_username, which is the name the connector matches on', async () => {
            await insertUser(USER_A, 'denis', 'denis-abs');
            await insertCred(USER_A, 'api_key', '2026-07-01T00:00:00Z', null);

            const [row] = await getAudiobookshelfLinkedUsers(sql);
            expect(row.jellyfinUsername).toBe('denis-abs');
        });

        it('ignores other plugins’ credentials', async () => {
            await insertUser(USER_A, 'denis', null);
            await sql`
                INSERT INTO plugin_user_credentials (plugin_id, user_id, key, value_encrypted)
                VALUES ('trakt', ${USER_A}, 'api_key', '\\x00'::bytea)
            `;
            await expect(getAudiobookshelfLinkedUsers(sql)).resolves.toEqual([]);
        });

        it('orders case-insensitively by the matched name', async () => {
            await insertUser(USER_A, 'Zoe', null);
            await insertUser(USER_B, 'alice', null);
            await insertCred(USER_A, 'api_key', '2026-07-01T00:00:00Z', null);
            await insertCred(USER_B, 'api_key', '2026-07-01T00:00:00Z', null);

            const rows = await getAudiobookshelfLinkedUsers(sql);
            expect(rows.map((r) => r.username)).toEqual(['alice', 'Zoe']);
        });
    });
});
