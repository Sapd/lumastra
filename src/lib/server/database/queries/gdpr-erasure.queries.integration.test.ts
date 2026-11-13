// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for GDPR Erasure Query Module
 *
 * Seeds a user with rows across the genuine-orphan tables + audit-attribution
 * tables, runs eraseUserData, then asserts:
 *  1. Every orphan table has zero rows for the subject afterwards.
 *  2. The __default__ stream-policy sentinel SURVIVES.
 *  3. Audit-attribution rows survive but are pseudonymized to deleted-user:<uuid8>.
 *  4. The users row itself is hard-deleted (and its FK-cascade children gone).
 *  5. The per-table report counts match.
 *  6. ERASURE_TABLE_REGISTRY covers every table with a direct FK → users(id) plus
 *     the known orphans — a NEW per-user table fails CI until registered.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
    insertTestRating,
    createTestRating,
    createAndInsertTestMovie,
    derivedUsername,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    eraseUserData,
    erasureTombstone,
    ERASURE_TABLE_REGISTRY,
    STREAM_POLICY_SENTINEL,
} from './gdpr-erasure.queries.js';
import { upsertWatchlistItem } from './watchlist.queries.js';
// Plugin-owned table (plugins/shoutbox) — read-only import of its own idempotent
// ensureSchema so this test can seed a real shoutbox_ai_invocations row and prove
// the FK cascade erases it. Does not modify the plugin.
import {
    ensureSchema as ensureShoutboxSchema,
    __resetSchemaGuardForTests as __resetShoutboxSchemaGuardForTests,
} from '../../../../../plugins/shoutbox/lib/schema.js';

describe('GDPR Erasure Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // CASCADE off users cleans the FK children; media cleared because
        // user_ratings FK → media_items. Audit tables cleared explicitly.
        // The private-module training parents (courses/quizzes/training_assignments)
        // do NOT cascade from users (courses.created_by is RESTRICT), so list them
        // explicitly; TRUNCATE … CASCADE then clears their FK children
        // (course_enrollments/quiz_attempts/certificates/training_acknowledgements).
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'users',
            'user_stream_policies',
            'user_feed_preferences',
            'playlist_view_state',
            'hls_playback_tokens',
            'service_tokens',
            'task_webhook_hooks',
            'task_history',
            'task_history_archive',
            'courses',
            'quizzes',
            'training_assignments',
            'user_access_groups',
        ]);
    });

    /** Whether the private-module training migrations have been applied to this DB. */
    async function privateTablesPresent(): Promise<boolean> {
        const reg = await sql<{ exists: string | null }[]>`
            SELECT to_regclass('public.courses') AS exists
        `;
        return Boolean(reg[0]?.exists);
    }

    // -------------------------------------------------------------------------
    // Unknown user → null
    // -------------------------------------------------------------------------
    it('returns null when the user does not exist', async () => {
        const fakeId = generateTestUserId();
        const result = await eraseUserData(sql, fakeId, derivedUsername(fakeId));
        expect(result).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Full erasure happy path
    // -------------------------------------------------------------------------
    it('hard-deletes orphans + the user, anonymizes audit rows, keeps __default__', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // A SECOND, unrelated user whose data MUST survive erasure of the subject.
        // This guards the username/uuid scoping of every anonymize UPDATE + orphan
        // DELETE: a broadened WHERE clause would wrongly touch this user's rows.
        const otherId = generateTestUserId();
        await ensureTestUser(sql, otherId);
        const otherUsername = derivedUsername(otherId);

        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 88881 });

        // ── Orphan rows ──────────────────────────────────────────────────────
        await insertTestRating(sql, createTestRating(userId, mediaId, 7));

        // Watchlist contents (playlist_items under playlist_type = 'watchlist')
        // are covered separately by "cascade via playlists removes watchlist
        // contents (playlist_items) on user erasure" below, which seeds via
        // the real upsertWatchlistItem write path and captures the
        // playlist_id before erasure — a stronger proof than a COUNT(*) here
        // would be, so this test doesn't duplicate it.

        // playlist_view_state — orphan (user_id is TEXT, no FK to users).
        // Requires a parent playlists row first (FK to playlists.id).
        const pvPlaylist = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name, description)
            VALUES (${userId}::uuid, 'Test Playlist', '')
            RETURNING id
        `;
        const pvPlaylistId = pvPlaylist[0]!.id; // playlists.id is an integer serial
        await sql`
            INSERT INTO playlist_view_state (playlist_id, user_id, collapsed_groups, updated_at)
            VALUES (${pvPlaylistId}, ${userId}::uuid, '{}', NOW())
            ON CONFLICT (playlist_id, user_id) DO NOTHING
        `;

        // user_suggestions — orphan (user_id uuid, no FK to users).
        await sql`
            INSERT INTO user_suggestions
                (user_id, media_id, combined_score, cache_context, expires_at)
            VALUES (${userId}::uuid, ${mediaId}::uuid, 0.9, 'general', NOW() + INTERVAL '1 day')
            ON CONFLICT (user_id, media_id, cache_context) DO NOTHING
        `;

        await sql`
            INSERT INTO user_feed_preferences (user_id, feed_mode)
            VALUES (${userId}::uuid, 'minimal')
            ON CONFLICT (user_id) DO NOTHING
        `;

        await sql`
            INSERT INTO user_stream_policies (user_id, updated_by, updated_at)
            VALUES (${username}, ${username}, NOW())
            ON CONFLICT (user_id) DO NOTHING
        `;
        // The global sentinel — last-edited by this user — must survive but be tombstoned.
        await sql`
            INSERT INTO user_stream_policies (user_id, updated_by, updated_at)
            VALUES (${STREAM_POLICY_SENTINEL}, ${username}, NOW())
            ON CONFLICT (user_id) DO NOTHING
        `;

        await sql`
            INSERT INTO hls_playback_tokens
                (token_hash, username, user_id, client_ip, expires_at)
            VALUES ('hash-1', ${username}, ${userId}::uuid, '127.0.0.1', NOW() + INTERVAL '1 hour')
        `;

        // ── Audit-attribution rows ───────────────────────────────────────────
        await sql`
            INSERT INTO service_tokens (token_hash, token_prefix, name, created_by)
            VALUES ('svc-hash', 'svc_', 'test token', ${username})
        `;
        await sql`
            INSERT INTO task_webhook_hooks (url, secret_encrypted, event_filter, created_by)
            VALUES ('https://example.test/hook', '\\x00'::bytea, '{}'::jsonb, ${username})
        `;
        await sql`
            INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version)
            VALUES ('run-1', 'task-1', 'lbl', 'completed', '{}'::jsonb, '{}'::jsonb,
                    ${sql.json({ type: 'user', id: username, via: 'ui' })}, '1')
        `;
        await sql`
            INSERT INTO task_history_archive
                (id, task_id, label, state, input, trigger, actor, processing_version)
            VALUES ('run-arch-1', 'task-1', 'lbl', 'completed', '{}'::jsonb, '{}'::jsonb,
                    ${sql.json({ type: 'user', id: username, via: 'ui' })}, '1')
        `;

        // ── SECOND user's rows (orphan + audit) — MUST survive erasure ────────
        await insertTestRating(sql, createTestRating(otherId, mediaId, 9));
        await sql`
            INSERT INTO user_feed_preferences (user_id, feed_mode)
            VALUES (${otherId}::uuid, 'full')
            ON CONFLICT (user_id) DO NOTHING
        `;
        await sql`
            INSERT INTO user_stream_policies (user_id, updated_by, updated_at)
            VALUES (${otherUsername}, ${otherUsername}, NOW())
            ON CONFLICT (user_id) DO NOTHING
        `;
        await sql`
            INSERT INTO hls_playback_tokens
                (token_hash, username, user_id, client_ip, expires_at)
            VALUES ('hash-other', ${otherUsername}, ${otherId}::uuid, '127.0.0.1', NOW() + INTERVAL '1 hour')
        `;
        await sql`
            INSERT INTO service_tokens (token_hash, token_prefix, name, created_by)
            VALUES ('svc-hash-other', 'svo_', 'other token', ${otherUsername})
        `;
        await sql`
            INSERT INTO task_history
                (id, task_id, label, state, input, trigger, actor, processing_version)
            VALUES ('run-other', 'task-1', 'lbl', 'completed', '{}'::jsonb, '{}'::jsonb,
                    ${sql.json({ type: 'user', id: otherUsername, via: 'ui' })}, '1')
        `;

        // ── Heavy-wave private-module cascade tables ─────────────────────────────
        // These have a direct FK → users(id) ON DELETE CASCADE, so the final
        // `DELETE FROM users` is what removes the subject's rows. Seed them here so
        // the test ACTUALLY proves cascade-removal (not just registry presence) and
        // would fail if a future migration weakened one of those FKs to NO ACTION.
        // The subject is the LEARNER; the SECOND user owns the course (created_by is
        // a RESTRICT FK, so it must be a surviving user, not the subject).
        const privateModuleTables = await privateTablesPresent();
        if (privateModuleTables) {
            const course = await sql<{ id: string }[]>`
                INSERT INTO courses (title, slug, status, created_by)
                VALUES ('Compliance 101', ${'c-' + userId.slice(0, 8)}, 'published', ${otherId}::uuid)
                RETURNING id
            `;
            const courseId = course[0]!.id;
            const quiz = await sql<{ id: string }[]>`
                INSERT INTO quizzes (title) VALUES ('Q1') RETURNING id
            `;
            const quizId = quiz[0]!.id;

            // course_enrollments — subject + the owner (owner's enrollment survives).
            await sql`
                INSERT INTO course_enrollments (course_id, user_id, status)
                VALUES (${courseId}::uuid, ${userId}::uuid, 'in_progress'),
                       (${courseId}::uuid, ${otherId}::uuid, 'enrolled')
            `;
            // quiz_attempts — subject takes the quiz.
            await sql`
                INSERT INTO quiz_attempts (quiz_id, user_id, score, passed, attempt_number)
                VALUES (${quizId}::uuid, ${userId}::uuid, 80, TRUE, 1)
            `;
            // certificates — subject earns one (serial UNIQUE NOT NULL).
            await sql`
                INSERT INTO certificates (course_id, user_id, serial)
                VALUES (${courseId}::uuid, ${userId}::uuid, ${'cert-' + userId.slice(0, 8)})
            `;

            // user_access_groups — subject joined a group.
            const grp = await sql<{ id: string }[]>`
                INSERT INTO access_groups (name, display_name)
                VALUES (${'grp-' + userId.slice(0, 8)}, 'Test Group')
                RETURNING id
            `;
            const groupId = grp[0]!.id;
            await sql`
                INSERT INTO user_access_groups (user_id, group_id)
                VALUES (${userId}::uuid, ${groupId}::uuid)
            `;

            // training_acknowledgements — subject acknowledged an assignment created
            // by the SECOND user (assigned_by NOT NULL FK → users must be a survivor).
            const assignment = await sql<{ id: string }[]>`
                INSERT INTO training_assignments
                    (title, item_kind, media_id, target_kind, target_user_id, assigned_by)
                VALUES ('Read me', 'media', ${mediaId}::uuid, 'user', ${userId}::uuid, ${otherId}::uuid)
                RETURNING id
            `;
            await sql`
                INSERT INTO training_acknowledgements (assignment_id, user_id)
                VALUES (${assignment[0]!.id}::uuid, ${userId}::uuid)
            `;
        }

        // ── Erase ────────────────────────────────────────────────────────────
        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('erasure returned null');

        expect(result.userDeleted).toBe(true);
        expect(result.username).toBe(username);

        // ── Orphans gone ─────────────────────────────────────────────────────
        const count = async (q: postgres.PendingQuery<{ n: number }[]>) => (await q)[0]?.n ?? -1;
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM user_ratings WHERE user_id = ${userId}::uuid`,
            ),
        ).toBe(0);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM user_feed_preferences WHERE user_id = ${userId}::uuid`,
            ),
        ).toBe(0);
        expect(
            await count(
                // user_stream_policies.user_id is keyed by USERNAME, not the UUID — intentional.
                // eslint-disable-next-line callback-safety/no-username-in-user-id-sql
                sql`SELECT COUNT(*)::int n FROM user_stream_policies WHERE user_id = ${username}`,
            ),
        ).toBe(0);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM hls_playback_tokens WHERE username = ${username}`,
            ),
        ).toBe(0);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM playlist_view_state WHERE user_id = ${userId}::uuid`,
            ),
        ).toBe(0);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM user_suggestions WHERE user_id = ${userId}::uuid`,
            ),
        ).toBe(0);

        // ── Sentinel survives, but its updated_by is tombstoned ──────────────
        const sentinel = await sql<{ updated_by: string | null }[]>`
            SELECT updated_by FROM user_stream_policies WHERE user_id = ${STREAM_POLICY_SENTINEL}
        `;
        expect(sentinel.length).toBe(1);
        expect(sentinel[0]?.updated_by).toBe(erasureTombstone(userId));

        // ── Audit rows survive, pseudonymized ─────────────────────────────────
        // Scoped to the subject's own seeded rows (the second user has its own
        // service_tokens/task_history rows that must NOT be tombstoned — asserted
        // separately below), so the count is deterministic.
        const tombstone = erasureTombstone(userId);
        const svc = await sql<{ created_by: string }[]>`
            SELECT created_by FROM service_tokens WHERE token_hash = 'svc-hash'
        `;
        expect(svc[0]?.created_by).toBe(tombstone);

        const hook = await sql<{ created_by: string }[]>`SELECT created_by FROM task_webhook_hooks`;
        expect(hook[0]?.created_by).toBe(tombstone);

        const hist = await sql<{ id: string }[]>`
            SELECT actor->>'id' AS id FROM task_history WHERE id = 'run-1'
        `;
        expect(hist[0]?.id).toBe(tombstone);
        const histArch = await sql<
            { id: string }[]
        >`SELECT actor->>'id' AS id FROM task_history_archive`;
        expect(histArch[0]?.id).toBe(tombstone);

        // ── users row hard-deleted + cascade child gone ──────────────────────
        const userRow = await sql`SELECT id FROM users WHERE id = ${userId}::uuid`;
        expect(userRow.length).toBe(0);
        const profileRow =
            await sql`SELECT user_id FROM user_profiles WHERE user_id = ${userId}::uuid`;
        expect(profileRow.length).toBe(0);

        // ── Heavy-wave cascade tables: ZERO rows for the subject afterwards ───
        // Proves the ON DELETE CASCADE FKs actually fired (not just registry entry).
        if (privateModuleTables) {
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM course_enrollments WHERE user_id = ${userId}::uuid`,
                ),
            ).toBe(0);
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM quiz_attempts WHERE user_id = ${userId}::uuid`,
                ),
            ).toBe(0);
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM certificates WHERE user_id = ${userId}::uuid`,
                ),
            ).toBe(0);
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM user_access_groups WHERE user_id = ${userId}::uuid`,
                ),
            ).toBe(0);
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM training_acknowledgements WHERE user_id = ${userId}::uuid`,
                ),
            ).toBe(0);
        }

        // ── SECOND user untouched: every orphan + audit + cascade row survives ─
        const otherTombstone = erasureTombstone(otherId);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM user_ratings WHERE user_id = ${otherId}::uuid`,
            ),
        ).toBe(1);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM user_feed_preferences WHERE user_id = ${otherId}::uuid`,
            ),
        ).toBe(1);
        expect(
            await count(
                // user_stream_policies keyed by USERNAME — intentional.
                sql`SELECT COUNT(*)::int n FROM user_stream_policies WHERE user_id = ${otherUsername}`,
            ),
        ).toBe(1);
        expect(
            await count(
                sql`SELECT COUNT(*)::int n FROM hls_playback_tokens WHERE username = ${otherUsername}`,
            ),
        ).toBe(1);
        // Audit rows: the second user's created_by/actor must NOT be tombstoned.
        const otherSvc = await sql<{ created_by: string }[]>`
            SELECT created_by FROM service_tokens WHERE created_by = ${otherUsername}
        `;
        expect(otherSvc.length).toBe(1);
        expect(otherSvc[0]?.created_by).not.toBe(tombstone);
        expect(otherSvc[0]?.created_by).not.toBe(otherTombstone);
        const otherHist = await sql<{ id: string }[]>`
            SELECT actor->>'id' AS id FROM task_history WHERE actor->>'id' = ${otherUsername}
        `;
        expect(otherHist.length).toBe(1);
        // The second user's own users row + profile survive.
        expect(
            await count(sql`SELECT COUNT(*)::int n FROM users WHERE id = ${otherId}::uuid`),
        ).toBe(1);
        if (privateModuleTables) {
            // The owner's course, quiz, course_enrollment all survive.
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM course_enrollments WHERE user_id = ${otherId}::uuid`,
                ),
            ).toBe(1);
            expect(
                await count(
                    sql`SELECT COUNT(*)::int n FROM courses WHERE created_by = ${otherId}::uuid`,
                ),
            ).toBe(1);
        }

        // ── Report sanity ────────────────────────────────────────────────────
        const ratingReport = result.tables.find((t) => t.table === 'user_ratings');
        expect(ratingReport?.deleted).toBe(1);
        const svcReport = result.tables.find((t) => t.table === 'service_tokens');
        expect(svcReport?.anonymized).toBe(1);
        expect(result.totalDeleted).toBeGreaterThanOrEqual(5);
        expect(result.totalAnonymized).toBeGreaterThanOrEqual(4);
    });

    // -------------------------------------------------------------------------
    // 'null-columns' strategy: playback_incident_events survives with device_id/
    // client_info explicitly scrubbed, and user_id nulled by the FK's own
    // ON DELETE SET NULL when the final DELETE FROM users fires.
    // -------------------------------------------------------------------------
    it('null-columns strategy clears user_id, device_id, client_info and message, and resets timeline', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        await sql`
            INSERT INTO playback_incident_events
                (attempt_id, play_session_id, incident_at, trigger_type, timeline, user_id, device_id, client_info, message)
            VALUES ('test-erasure-1', 'test-session-erasure-1', now(), 'terminal',
                    '[{"t":1,"event":"seek","url":"/Users/alice/Movies/x.mkv"}]'::jsonb,
                    ${userId}::uuid, 'device-abc', '{"ua":"test-agent"}'::jsonb, 'alice stalled at 00:12')
        `;

        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('null result');
        expect(result.userDeleted).toBe(true);

        const [row] = await sql`
            SELECT user_id, device_id, client_info, message, timeline FROM playback_incident_events WHERE attempt_id = 'test-erasure-1'
        `;
        expect(row.user_id).toBeNull();
        expect(row.device_id).toBeNull();
        expect(row.client_info).toBeNull();
        expect(row.message).toBeNull();
        expect(row.timeline).toEqual([]);

        const report = result.tables.find((t) => t.table === 'playback_incident_events');
        expect(report?.strategy).toBe('null-columns');
        expect(report?.anonymized).toBe(1);

        await sql`DELETE FROM playback_incident_events WHERE attempt_id = 'test-erasure-1'`;
    });

    // -------------------------------------------------------------------------
    // The registry-driven loop must cover EVERY 'null-columns' entry, not just
    // the one it was originally written for. network_speed_tests (migration
    // 16.248.0) is the second such entry — and a measured line speed tied to a
    // device id is a household fingerprint, so proving it is actually scrubbed
    // (rather than merely listed in the registry) is the point of this test.
    // -------------------------------------------------------------------------
    it('null-columns strategy also scrubs network_speed_tests', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        const [seeded] = await sql<{ id: number }[]>`
            INSERT INTO network_speed_tests
                (user_id, device_id, client_info, bytes_requested, bytes_received,
                 duration_ms, ttfb_ms, throughput_bps, min_bucket_bps, stall_ms,
                 aborted, buckets)
            VALUES (${userId}::uuid, 'device-speedtest', '{"ua":"test-agent"}'::jsonb,
                    1048576, 1000000, 1500, 500, 8000000, 0, 250, false,
                    '[{"ms":250,"bytes":100000}]'::jsonb)
            RETURNING id
        `;

        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('null result');
        expect(result.userDeleted).toBe(true);

        const [row] = await sql`
            SELECT user_id, device_id, client_info, throughput_bps
            FROM network_speed_tests WHERE id = ${seeded.id}
        `;
        expect(row.user_id).toBeNull();
        expect(row.device_id).toBeNull();
        expect(row.client_info).toBeNull();
        // The measurement itself survives — once detached from any user it is no
        // longer personal data, and the retention sweep owns its lifetime.
        expect(Number(row.throughput_bps)).toBe(8000000);

        const report = result.tables.find((t) => t.table === 'network_speed_tests');
        expect(report?.strategy).toBe('null-columns');
        expect(report?.anonymized).toBe(1);

        await sql`DELETE FROM network_speed_tests WHERE id = ${seeded.id}`;
    });

    // -------------------------------------------------------------------------
    // The 'null-columns' SET list must be BUILT FROM the registry entry, not
    // hardcoded in the UPDATE. Re-asserting the current columns cannot tell
    // the two implementations apart, so this temporarily adds ANOTHER column to
    // the registry entry and proves erasure actually nulls it. With a literal
    // `SET device_id = NULL, client_info = NULL, message = NULL`, `stage`
    // survives and this fails.
    // -------------------------------------------------------------------------
    it("null-columns strategy is driven by the registry entry's columns list", async () => {
        const entry = ERASURE_TABLE_REGISTRY.find((e) => e.table === 'playback_incident_events');
        expect(entry).toBeDefined();
        if (!entry) throw new Error('playback_incident_events not registered');

        // `columns` is readonly by TYPE only; mutate it for the duration of this
        // test and restore in `finally` so the real registry is unchanged.
        const mutable = entry as { columns?: readonly string[] };
        const originalColumns = mutable.columns;
        mutable.columns = [...(originalColumns ?? []), 'stage'];

        try {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const username = derivedUsername(userId);

            await sql`
                INSERT INTO playback_incident_events
                    (attempt_id, play_session_id, incident_at, trigger_type, timeline, user_id, device_id, client_info, stage)
                VALUES ('test-erasure-registry', 'test-session-erasure-registry', now(), 'terminal', '[]'::jsonb, ${userId}::uuid, 'device-abc', '{"ua":"test-agent"}'::jsonb, 'segment_fetch')
            `;

            const result = await eraseUserData(sql, userId, username);
            expect(result).not.toBeNull();

            const [row] = await sql`
                SELECT device_id, client_info, stage FROM playback_incident_events
                WHERE attempt_id = 'test-erasure-registry'
            `;
            expect(row.device_id).toBeNull();
            expect(row.client_info).toBeNull();
            // The column that only exists in the registry for this test.
            expect(row.stage).toBeNull();

            await sql`DELETE FROM playback_incident_events WHERE attempt_id = 'test-erasure-registry'`;
        } finally {
            mutable.columns = originalColumns;
        }
    });

    // -------------------------------------------------------------------------
    // Cascade strategy: jellyfin_display_preferences (migration 16.207.0) has a
    // direct ON DELETE CASCADE FK → users(id) and no anonymize/null-columns
    // handling — prove a real row is actually removed by the final users
    // delete, not just that the registry names the table.
    // -------------------------------------------------------------------------
    it('cascade strategy removes jellyfin_display_preferences on user erasure', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        await sql`
            INSERT INTO jellyfin_display_preferences
                (user_id, display_prefs_id, client, data)
            VALUES (${userId}::uuid, 'usersettings', 'emby', '{"CustomPrefs":{}}'::jsonb)
        `;

        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('null result');
        expect(result.userDeleted).toBe(true);

        const rows = await sql`
            SELECT id FROM jellyfin_display_preferences WHERE user_id = ${userId}::uuid
        `;
        expect(rows.length).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Cascade strategy on a PLUGIN-owned table: shoutbox_ai_invocations is
    // created by the shoutbox plugin's own ensureSchema, not a host migration,
    // so no migration file proves its FK is ON DELETE CASCADE. The registry
    // entry claims erasure needs no statement because the constraint does the
    // work — assert that against a real row, since a plugin that shipped the
    // table without the constraint would leave the subject's invocation history
    // behind while the registry still reported it covered.
    // -------------------------------------------------------------------------
    it('cascade strategy removes plugin-owned shoutbox_ai_invocations on user erasure', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // Idempotent; reset the once-per-process guard so a prior resolved call
        // in this fork does not make it a silent no-op.
        __resetShoutboxSchemaGuardForTests();
        await ensureShoutboxSchema(sql);

        await sql`INSERT INTO shoutbox_ai_invocations (user_id) VALUES (${userId}::uuid)`;
        const before = await sql`
            SELECT id FROM shoutbox_ai_invocations WHERE user_id = ${userId}::uuid
        `;
        expect(before.length).toBe(1);

        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('null result');
        expect(result.userDeleted).toBe(true);

        const rows = await sql`
            SELECT id FROM shoutbox_ai_invocations WHERE user_id = ${userId}::uuid
        `;
        expect(rows.length).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Watchlist contents (migration 16.259.0) no longer have their own
    // explicit-DELETE registry entry — the registry's `playlists` entry notes
    // that `playlist_items` cascades from it. Prove that against a real
    // watchlist row seeded the same way the app writes it (upsertWatchlistItem,
    // not a hand-written INSERT INTO the now-dead user_watchlist table): the
    // registry's note is a claim about the FK graph, not a rule that enforces
    // itself, so a schema change that dropped the CASCADE would leave the
    // registry note wrong and this the only thing to catch it.
    // -------------------------------------------------------------------------
    it('cascade via playlists removes watchlist contents (playlist_items) on user erasure', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 88882 });
        await upsertWatchlistItem(sql, userId, mediaId);

        const before = await sql<{ id: number; playlist_id: number }[]>`
            SELECT pi.id, pi.playlist_id
            FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${userId}::uuid AND p.playlist_type = 'watchlist'
        `;
        expect(before.length).toBe(1);
        // Captured before erasure — the post-erasure check below queries
        // playlist_items directly by this id rather than re-joining through
        // playlists (which is itself gone by then), so it actually proves the
        // playlist_items row was cascaded and isn't just vacuously empty
        // because its parent join target disappeared.
        const watchlistPlaylistId = before[0]!.playlist_id;

        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('null result');
        expect(result.userDeleted).toBe(true);

        const afterPlaylists = await sql`SELECT id FROM playlists WHERE user_id = ${userId}::uuid`;
        expect(afterPlaylists.length).toBe(0);

        const afterItems = await sql`
            SELECT id FROM playlist_items WHERE playlist_id = ${watchlistPlaylistId}
        `;
        expect(afterItems.length).toBe(0);
    });

    // -------------------------------------------------------------------------
    // Pre-flight abort: subject is the assigner of admin training content
    // -------------------------------------------------------------------------
    it('aborts (rolls back) when the subject is the assigner of a training assignment', async () => {
        // Skip gracefully on installs without the private-module training migration.
        const reg = await sql<{ exists: string | null }[]>`
            SELECT to_regclass('public.training_assignments') AS exists
        `;
        if (!reg[0]?.exists) return;

        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);
        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 88882 });

        // The subject ASSIGNED a training campaign (assigned_by NOT NULL, NO ACTION FK).
        await sql`
            INSERT INTO training_assignments
                (title, item_kind, media_id, target_kind, target_user_id, assigned_by)
            VALUES ('Onboarding', 'media', ${mediaId}::uuid, 'user', ${userId}::uuid, ${userId}::uuid)
        `;
        // And has a personal rating (would-be-deleted) to prove rollback.
        await insertTestRating(sql, createTestRating(userId, mediaId, 5));

        const result = await eraseUserData(sql, userId, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('null result');

        expect(result.userDeleted).toBe(false);
        expect(result.blocked && result.blocked.length).toBeGreaterThanOrEqual(1);
        expect(result.blocked?.some((b) => b.table === 'training_assignments')).toBe(true);

        // Rollback: the user, the assignment, and the rating all still exist.
        const userRow = await sql`SELECT id FROM users WHERE id = ${userId}::uuid`;
        expect(userRow.length).toBe(1);
        const rating = await sql`SELECT id FROM user_ratings WHERE user_id = ${userId}::uuid`;
        expect(rating.length).toBe(1);

        // Cleanup (FK order: assignment references media + users).
        await sql`DELETE FROM training_assignments WHERE assigned_by = ${userId}::uuid`;
    });

    // -------------------------------------------------------------------------
    // Registry coverage: every FK → users(id) table + known orphans registered
    //
    // Reads pg_constraint, so plugin-created tables count too — but only when
    // something in the suite has materialized them (this file imports the
    // shoutbox plugin's ensureSchema for exactly that). See the longer note on
    // the matching guard in gdpr-export.queries.integration.test.ts for what
    // that does not cover, and why erasure degrades more gracefully than export
    // when a plugin goes unregistered.
    // -------------------------------------------------------------------------
    it('erases preference ordering through both cascade levels without touching another account', async () => {
        const userId = generateTestUserId();
        const otherId = generateTestUserId();
        await ensureTestUser(sql, userId);
        await ensureTestUser(sql, otherId);
        for (const id of [userId, otherId]) {
            await sql`
                INSERT INTO user_playback_preference_devices
                    (user_id, device_id, epoch_generation, epoch_id)
                VALUES (${id}::uuid, 'gdpr-order-browser', 1, 'erasure-epoch')
            `;
            await sql`
                INSERT INTO user_playback_preference_orders
                    (user_id, device_id, field, edit_clock, operation_id)
                VALUES (${id}::uuid, 'gdpr-order-browser', 'subtitleLanguage', 1, 'erasure-edit')
            `;
        }

        const result = await eraseUserData(sql, userId, derivedUsername(userId));
        expect(result?.userDeleted).toBe(true);
        expect(await sql`SELECT user_id FROM user_playback_preference_devices`).toEqual([
            { user_id: otherId },
        ]);
        expect(await sql`SELECT user_id FROM user_playback_preference_orders`).toEqual([
            { user_id: otherId },
        ]);
    });

    it('ERASURE_TABLE_REGISTRY covers every table with a direct FK → users(id)', async () => {
        const fkRows = await sql<{ table_name: string }[]>`
            SELECT DISTINCT src_cls.relname AS table_name
            FROM pg_constraint c
            JOIN pg_class src_cls   ON src_cls.oid  = c.conrelid
            JOIN pg_class ref_cls   ON ref_cls.oid  = c.confrelid
            JOIN pg_namespace ref_ns ON ref_ns.oid  = ref_cls.relnamespace
            WHERE c.contype = 'f'
              AND ref_cls.relname = 'users'
              AND ref_ns.nspname  = 'public'
            ORDER BY src_cls.relname
        `;
        const fkTables = fkRows.map((r) => r.table_name);
        // Registry keys may carry a `.column` suffix (multi-strategy table) or a
        // synthetic FK alias; normalize to the bare table name for the superset check.
        const registered = new Set(
            ERASURE_TABLE_REGISTRY.map((e) => e.table.split('.')[0]).flatMap((t) =>
                t === 'service_tokens_act_as' ? ['service_tokens'] : [t],
            ),
        );

        const missing = fkTables.filter((t) => !registered.has(t));
        expect(
            missing,
            `Tables with FK → users(id) not in ERASURE_TABLE_REGISTRY: ${missing.join(', ')}`,
        ).toHaveLength(0);

        // The genuine orphans (no FK) must be explicitly registered as 'delete'.
        const deletes = new Set(
            ERASURE_TABLE_REGISTRY.filter((e) => e.strategy === 'delete').map((e) => e.table),
        );
        for (const orphan of [
            'user_feed_preferences',
            'playlist_view_state',
            'user_stream_policies',
            'hls_playback_tokens',
        ]) {
            expect(deletes.has(orphan), `${orphan} must be a 'delete' entry`).toBe(true);
        }
    });
});
