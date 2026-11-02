// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for GDPR Export Query Module
 *
 * Seeds a user with rows in several tables, then asserts:
 * 1. collectUserExport returns every allowlisted table section.
 * 2. Excluded columns (avatar_data, password_hash, token secrets, vectors) are absent.
 * 3. The __default__ stream-policy sentinel is never included in the subject's export.
 * 4. A non-existent user returns null.
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
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import type { UserDataExport } from '$lib/schemas/gdpr.js';
import { collectUserExport, EXPORT_TABLE_ALLOWLIST } from './gdpr-export.queries.js';
import { upsertWatchlistItem } from './watchlist.queries.js';
import { toUserId } from '$lib/shared/user-id';
// Plugin-owned table (plugins/shoutbox) — read-only import of its own idempotent
// ensureSchema so this test can seed a real shoutbox_messages row. Does not
// modify the plugin.
import {
    ensureSchema as ensureShoutboxSchema,
    __resetSchemaGuardForTests as __resetShoutboxSchemaGuardForTests,
} from '../../../../../plugins/shoutbox/lib/schema.js';

describe('GDPR Export Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        // Truncate users last (CASCADE cleans all FK-linked user data).
        // media must be cleared too because user_ratings FK → media_items.
        await truncateTables(sql, [...TEST_TABLES.media, 'users']);
    });

    // -------------------------------------------------------------------------
    // Smoke: returns null for unknown user
    // -------------------------------------------------------------------------
    it('returns null when user does not exist', async () => {
        const result = await collectUserExport(sql, 'nonexistent-username-xyz-99999');
        expect(result).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Happy path: user with seeded data across several tables
    // -------------------------------------------------------------------------
    it('exports a user with ratings, watchlist and stream policy', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // Seed a media item to attach data to
        const { id: mediaId } = await createAndInsertTestMovie(sql, { tmdbId: 99991 });

        // Rating
        await insertTestRating(sql, createTestRating(userId, mediaId, 8));

        // Watchlist — writes to playlist_items under the user's watchlist
        // playlist row (user_watchlist no longer reflects real state; see
        // watchlist.queries.ts). generateTestUserId() already returns a UserId.
        await upsertWatchlistItem(sql, userId, mediaId);

        // Per-book social-sharing opt-out (migration 16.180.0). Seeded here because
        // being NAMED in EXPORT_TABLE_ALLOWLIST is not the same as being exported:
        // the allowlist is a declaration, and the completeness test below checks
        // only the declaration. Without a row assertion a table could sit on the
        // allowlist forever while its section stayed permanently empty.
        await sql`
            INSERT INTO user_media_share_opt_out (user_id, media_id)
            VALUES (${userId}::uuid, ${mediaId}::uuid)
            ON CONFLICT DO NOTHING
        `;

        // Per-user outbound notification endpoint (migration 16.192.0). Seeded for
        // the same reason as the opt-out above, plus one of its own: the row holds
        // both data that MUST be exported (the URL the subject configured) and data
        // that must NOT be (the HMAC signing key), so the assertions below check
        // both directions.
        await sql`
            INSERT INTO user_notification_webhooks (user_id, url, secret_encrypted)
            VALUES (${userId}::uuid, 'https://ntfy.example.test/lumastra-abc', decode('deadbeef', 'hex'))
            ON CONFLICT (user_id) DO NOTHING
        `;

        // Set the sharing flag EXPLICITLY rather than leaning on the column
        // default. The assertion below is about the export SELECT naming the
        // column, not about what the default happens to be — and migration
        // 16.187.0 moved that default from false to true, which silently broke
        // this test when it relied on it.
        await sql`
            UPDATE users SET share_listening_activity = false WHERE id = ${userId}::uuid
        `;

        // Stream policy (TEXT key = username)
        await sql`
            INSERT INTO user_stream_policies (user_id, updated_at)
            VALUES (${username}, NOW())
            ON CONFLICT (user_id) DO NOTHING
        `;

        // Ensure the __default__ sentinel exists (mirrors prod)
        await sql`
            INSERT INTO user_stream_policies (user_id, updated_at)
            VALUES ('__default__', NOW())
            ON CONFLICT (user_id) DO NOTHING
        `;

        const result = await collectUserExport(sql, username);
        expect(result).not.toBeNull();

        if (!result) throw new Error('export was null');

        // Version + subject
        expect(result.version).toBe(1);
        expect(result.subject_username).toBe(username);

        // Ratings section
        expect(result.ratings.rows.length).toBeGreaterThanOrEqual(1);

        // Watchlist section
        expect(result.watchlist.rows.length).toBeGreaterThanOrEqual(1);

        // playlist_items section — being NAMED in EXPORT_TABLE_ALLOWLIST is not
        // the same as being exported (see the opt-out comment below); the
        // watchlist item seeded above lives in playlist_items too, so this
        // section must actually carry it rather than sit permanently empty.
        expect(result.playlist_items.rows.length).toBeGreaterThanOrEqual(1);
        expect(result.playlist_items.total_count).toBeGreaterThanOrEqual(1);

        // Social-sharing opt-out section actually carries the row
        expect(result.media_share_opt_out.rows.length).toBe(1);
        expect((result.media_share_opt_out.rows[0] as Record<string, unknown>).media_id).toBe(
            mediaId,
        );
        expect(result.media_share_opt_out.total_count).toBe(1);

        // Notification-webhook section carries the URL but never the signing secret
        expect(result.notification_webhooks.rows.length).toBe(1);
        const hookRow = result.notification_webhooks.rows[0] as Record<string, unknown>;
        expect(hookRow.url).toBe('https://ntfy.example.test/lumastra-abc');
        expect(hookRow.secret_encrypted).toBeUndefined();
        expect(result.notification_webhooks.total_count).toBe(1);

        // The account row carries the sharing tier flag (a users column added with
        // that table — a new column is silently absent unless the SELECT names it).
        expect(
            (result.account as Record<string, unknown> | undefined)?.share_listening_activity,
        ).toBe(false);

        // Stream policy — subject row present, __default__ absent
        expect(result.stream_policy.rows.length).toBeGreaterThanOrEqual(1);
        const policyUserIds = result.stream_policy.rows.map(
            (r) => (r as Record<string, unknown>).user_id,
        );
        expect(policyUserIds).toContain(username);
        expect(policyUserIds).not.toContain('__default__');
    });

    // -------------------------------------------------------------------------
    // Shoutbox: a user's own chat messages must actually appear in the export,
    // not just be named in EXPORT_TABLE_ALLOWLIST (commit 1e50bfb61 added the
    // allowlist entry without wiring up the SELECT — this asserts the real fix).
    // -------------------------------------------------------------------------
    it("exports a user's shoutbox messages", async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // Plugin-owned table; idempotent (CREATE TABLE IF NOT EXISTS under the
        // hood). Reset the module's once-per-process guard first — a prior test
        // in this file (or a prior run) may have already resolved it, which
        // would otherwise make this call a silent no-op.
        __resetShoutboxSchemaGuardForTests();
        await ensureShoutboxSchema(sql);

        await sql`
            INSERT INTO shoutbox_messages (username, user_group, author_kind, body, user_id)
            VALUES (${username}, 'members', 'user', 'hello from the export test', ${userId}::uuid)
        `;

        // A message NOT authored by this user must never leak into their export.
        await sql`
            INSERT INTO shoutbox_messages (username, author_kind, body)
            VALUES ('someone-else', 'user', 'not the subject''s message')
        `;

        const result = await collectUserExport(sql, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('export was null');

        expect(result.shoutbox_messages.rows.length).toBe(1);
        expect(result.shoutbox_messages.total_count).toBe(1);
        const row = result.shoutbox_messages.rows[0] as Record<string, unknown>;
        expect(row.body).toBe('hello from the export test');
        expect(row.username).toBe(username);
        expect(row.user_group).toBe('members');
        expect(row.author_kind).toBe('user');
        expect(row.id).toBeDefined();
        expect(row.created_at).toBeDefined();
    });

    // -------------------------------------------------------------------------
    // Shoutbox: plugin-owned table may not exist on installs that never loaded
    // the shoutbox plugin. The export must degrade to an empty section rather
    // than throwing.
    //
    // Drops the real shared shoutbox_messages table OUTSIDE any explicit
    // transaction (matching how collectUserExport is actually called in
    // production — autocommit, one implicit transaction per statement) and
    // ALWAYS recreates it in a `finally`, via the plugin's own idempotent
    // ensureSchema, regardless of the assertion outcome. A `sql.begin(...)`
    // rollback trick was tried first and rejected: dropping the table inside
    // an explicit transaction aborts that whole transaction server-side, which
    // then poisons every other concurrently-issued query in
    // collectUserExport's Promise.all — not a faithful simulation of the real
    // (non-transactional) call path.
    // -------------------------------------------------------------------------
    it('does not throw when shoutbox_messages does not exist', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        await sql`DROP TABLE IF EXISTS shoutbox_messages CASCADE`;
        let result: UserDataExport | null;
        try {
            result = await collectUserExport(sql, username);
        } finally {
            // Restore for every other test in this file and for
            // plugins/shoutbox's own integration suite, which shares this DB.
            // The guard MUST be reset first — without it, ensureSchema() sees
            // its cached "already ensured" promise from the earlier test above
            // and skips re-issuing the CREATE TABLE, leaving the table dropped.
            __resetShoutboxSchemaGuardForTests();
            await ensureShoutboxSchema(sql);
        }

        expect(result).not.toBeNull();
        expect(result?.shoutbox_messages).toEqual({ rows: [], truncated: false, total_count: 0 });
    });

    // -------------------------------------------------------------------------
    // Shoutbox AI invocations: the per-user hourly AI rate-limit ledger. One row
    // per invocation with an exact timestamp, never pruned — personal data, so
    // it is exported (Art. 15) rather than excluded the way the aggregated,
    // self-resetting assistant_rate_limits counter is.
    // -------------------------------------------------------------------------
    it("exports a user's shoutbox AI invocations", async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // A SECOND user whose invocations must never appear in the subject's
        // export — user_id is NOT NULL here, so this needs a real users row.
        const otherId = generateTestUserId();
        await ensureTestUser(sql, otherId);

        __resetShoutboxSchemaGuardForTests();
        await ensureShoutboxSchema(sql);

        await sql`
            INSERT INTO shoutbox_ai_invocations (user_id) VALUES (${userId}::uuid), (${userId}::uuid)
        `;
        await sql`INSERT INTO shoutbox_ai_invocations (user_id) VALUES (${otherId}::uuid)`;

        const result = await collectUserExport(sql, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('export was null');

        expect(result.shoutbox_ai_invocations.rows.length).toBe(2);
        expect(result.shoutbox_ai_invocations.total_count).toBe(2);
        const row = result.shoutbox_ai_invocations.rows[0] as Record<string, unknown>;
        expect(row.id).toBeDefined();
        expect(row.created_at).toBeDefined();
        // user_id is pure linkage back to the subject and is deliberately not
        // disclosed — asserting its ABSENCE is what separates the real column
        // list from a `SELECT *` that would re-emit it.
        expect(row).not.toHaveProperty('user_id');
    });

    // -------------------------------------------------------------------------
    // Same optional-table degradation as shoutbox_messages above, asserted
    // separately: shoutbox_ai_invocations has its own .catch guard, and the
    // existing DROP test only covers shoutbox_messages.
    // -------------------------------------------------------------------------
    it('does not throw when shoutbox_ai_invocations does not exist', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        await sql`DROP TABLE IF EXISTS shoutbox_ai_invocations CASCADE`;
        let result: UserDataExport | null;
        try {
            result = await collectUserExport(sql, username);
        } finally {
            __resetShoutboxSchemaGuardForTests();
            await ensureShoutboxSchema(sql);
        }

        expect(result).not.toBeNull();
        expect(result?.shoutbox_ai_invocations).toEqual({
            rows: [],
            truncated: false,
            total_count: 0,
        });
    });

    // -------------------------------------------------------------------------
    // Playback incidents: a user's own incident row must actually appear in the
    // export, not just be named in EXPORT_TABLE_ALLOWLIST — a naming-only parity
    // test proves nothing about actual coverage (see the design doc's own
    // warning, echoed in the shoutbox test above).
    // -------------------------------------------------------------------------
    it("exports a user's playback incident events", async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        await sql`
            INSERT INTO playback_incident_events
                (attempt_id, play_session_id, incident_at, trigger_type, message, device_id, timeline, user_id)
            VALUES ('test-export-attempt-1', 'test-export-session-1', now(), 'terminal',
                    'export test incident', 'device-export-1', '[]'::jsonb, ${userId}::uuid)
        `;

        // An incident belonging to a different user must never leak into this export.
        await sql`
            INSERT INTO playback_incident_events
                (attempt_id, play_session_id, incident_at, trigger_type, timeline)
            VALUES ('test-export-attempt-other', 'test-export-session-other', now(), 'terminal', '[]'::jsonb)
        `;

        const result = await collectUserExport(sql, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('export was null');

        expect(result.playback_incident_events.rows.length).toBe(1);
        expect(result.playback_incident_events.total_count).toBe(1);
        const row = result.playback_incident_events.rows[0] as Record<string, unknown>;
        expect(row.attempt_id).toBe('test-export-attempt-1');
        expect(row.message).toBe('export test incident');
        expect(row.device_id).toBe('device-export-1');

        // The "other" row has no user_id, so the users-table TRUNCATE CASCADE in
        // beforeEach won't reach it — clean it up explicitly.
        await sql`
            DELETE FROM playback_incident_events
            WHERE attempt_id = 'test-export-attempt-other'
        `;
    });

    // -------------------------------------------------------------------------
    // Real content-level coverage (not just allowlist naming) for
    // jellyfin_display_preferences (migration 16.207.0) — see the comment
    // above the playback_incident_events test for why this matters.
    // -------------------------------------------------------------------------
    it("exports a user's jellyfin display preferences", async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        await sql`
            INSERT INTO jellyfin_display_preferences
                (user_id, display_prefs_id, client, data)
            VALUES (${userId}::uuid, 'usersettings', 'emby', '{"CustomPrefs":{"chromecastVersion":"stable"}}'::jsonb)
        `;

        // A preferences row belonging to a different user must never leak into
        // this export.
        const otherUserId = generateTestUserId();
        await ensureTestUser(sql, otherUserId);
        await sql`
            INSERT INTO jellyfin_display_preferences
                (user_id, display_prefs_id, client, data)
            VALUES (${otherUserId}::uuid, 'usersettings', 'emby', '{"CustomPrefs":{}}'::jsonb)
        `;

        const result = await collectUserExport(sql, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('export was null');

        expect(result.jellyfin_display_preferences.rows.length).toBe(1);
        expect(result.jellyfin_display_preferences.total_count).toBe(1);
        const row = result.jellyfin_display_preferences.rows[0] as Record<string, unknown>;
        expect(row.display_prefs_id).toBe('usersettings');
        expect(row.client).toBe('emby');
        expect(row.data).toEqual({ CustomPrefs: { chromecastVersion: 'stable' } });
    });

    // -------------------------------------------------------------------------
    // Security: sensitive columns must not appear in any section
    // -------------------------------------------------------------------------
    it('excludes password_hash, avatar_data, and embedding vectors', async () => {
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const username = derivedUsername(userId);

        // Set a password hash on the user
        await sql`
            UPDATE users
            SET password_hash = crypt('testpassword', gen_salt('bf'))
            WHERE id = ${userId}::uuid
        `;

        const result = await collectUserExport(sql, username);
        expect(result).not.toBeNull();
        if (!result) throw new Error('export was null');

        // account section must not contain sensitive columns
        const account = result.account as Record<string, unknown> | undefined;
        expect(account).toBeDefined();
        expect(account?.password_hash).toBeUndefined();
        expect(account?.avatar_data).toBeUndefined();
        expect(account?.password_updated_at).toBeUndefined();

        // profiles section must not contain embedding vector
        for (const row of result.profiles.rows) {
            const r = row as Record<string, unknown>;
            expect(r.catalog_embedding).toBeUndefined();
            expect(r.request_embedding).toBeUndefined();
        }
    });

    // -------------------------------------------------------------------------
    // Allowlist completeness: EXPORT_TABLE_ALLOWLIST must be a superset of EVERY
    // table that has a direct FK to users(id). This is the full FK-to-users set,
    // not just "core tables" — any per-user table must be exported (Art. 15) or
    // explicitly justified as non-personal-data / operational in INTENTIONALLY_EXCLUDED.
    //
    // This assertion is dynamic — it queries pg_constraint so that adding a new
    // user-scoped table to the schema causes CI to fail until the table is also
    // added to EXPORT_TABLE_ALLOWLIST (or justified in INTENTIONALLY_EXCLUDED).
    //
    // ── Plugin-created tables: what this guard does and does NOT catch ───────
    // The query below reads pg_constraint, so it covers ANY users-FK table that
    // exists in the test database — including ones a plugin's ensureSchema
    // created rather than a host migration (shoutbox_messages and
    // shoutbox_ai_invocations are both here for that reason). But it only sees
    // such a table because THIS suite imports the shoutbox plugin's own
    // ensureSchema to seed its fixtures. A future in-repo plugin that creates a
    // users-FK table and is never materialized by any integration test would
    // pass this guard while being absent from both registries.
    //
    // For THIRD-PARTY plugins no CI guard can close this at all: they are
    // installed at runtime on an operator's box and can create a users-FK table
    // the core registries have never heard of. Making that safe needs the plugin
    // contract to let a plugin DECLARE its per-user tables, with export/erasure
    // consulting that declaration at runtime — a design change, not a registry
    // edit. Until then, erasure still works for a well-behaved plugin (an
    // ON DELETE CASCADE FK erases without any registry entry, which is what
    // plugins/shoutbox/lib/schema.js relies on and documents); Art. 15 export is
    // the half that silently does not.
    // -------------------------------------------------------------------------
    it('EXPORT_TABLE_ALLOWLIST covers the full FK-to-users set (Art. 15 parity)', async () => {
        expect(EXPORT_TABLE_ALLOWLIST.length).toBeGreaterThan(10);

        // Query pg_constraint to find every table with a direct FK to public.users(id).
        // We join through pg_class and pg_attribute to filter on the referenced column
        // being `id` on the `users` table (schema = public).
        const fkRows = await sql<{ table_name: string }[]>`
            SELECT DISTINCT
                src_cls.relname AS table_name
            FROM pg_constraint c
            JOIN pg_class src_cls   ON src_cls.oid  = c.conrelid
            JOIN pg_class ref_cls   ON ref_cls.oid  = c.confrelid
            JOIN pg_namespace ref_ns ON ref_ns.oid  = ref_cls.relnamespace
            WHERE c.contype = 'f'
              AND ref_cls.relname   = 'users'
              AND ref_ns.nspname    = 'public'
            ORDER BY src_cls.relname
        `;

        const fkTables = fkRows.map((r) => r.table_name);

        // Tables explicitly excluded from the export because they do NOT contain
        // personal data belonging to the subject, or because they are operational /
        // transient and including them would not serve the data subject.
        // Every entry here must have a documented justification — a new table MUST
        // be added to EXPORT_TABLE_ALLOWLIST instead of silently excluded here.
        //   - active_transcode_jobs  — transient server-side operational row; no PII
        //   - hls_playback_tokens    — short-TTL stream tokens; already covered as orphan/TEXT-key
        //   - library_availability   — admin resource allocation; no PII
        //   - library_group_permissions — admin permissions record; no PII
        //   - livetv_backup_groups   — admin LiveTV config; no PII
        //   - media_files            — library content; not the subject's personal data
        //   - playback_session_quality — aggregate quality stats; no direct PII
        //   - playback_telemetry     — ON DELETE SET NULL; user_id nulled on delete → already anonymizes
        //   - plugin_secret_access_log — ON DELETE SET NULL; already anonymizes
        //   - sync_quarantine        — operational reconciliation queue; no PII
        //   - service_tokens         — act_as_user SET NULL; token row is not the subject's data
        //   - user_identities        — identity federation rows managed by the IdP; not user content
        //   - watch_state_pending_resolution — operational reconciliation queue; no PII
        //   - assistant_rate_limits  — rate limit counters; transient, no PII
        //   - courses                — created_by FK is the admin actor; not the subject's personal data
        //   - user_push_outbox       — pending push deliveries (migration 16.199.0); ephemeral queue
        //                              state with a ~21-minute retry ladder, then deleted or marked
        //                              dead. Holds only a notification_id FK and delivery bookkeeping
        //                              (attempts, delivered_tokens, dead/dead_reason) — no content of
        //                              its own to disclose, same rationale as sync_quarantine and
        //                              watch_state_pending_resolution above.
        const INTENTIONALLY_EXCLUDED = new Set([
            'active_transcode_jobs',
            'hls_playback_tokens',
            'library_availability',
            'library_group_permissions',
            'livetv_backup_groups',
            'media_files',
            'playback_session_quality',
            'playback_telemetry',
            'plugin_secret_access_log',
            'sync_quarantine',
            'service_tokens',
            'user_identities',
            'watch_state_pending_resolution',
            'assistant_rate_limits',
            // Operational replay protection: opaque browser/context identifiers and
            // logical field-order tokens, not preference values or an activity log.
            // Actual preferences are exported in playback_preferences. Both tables
            // are erased with the account through their registered FK cascades.
            'user_playback_preference_devices',
            'user_playback_preference_orders',
            'courses',
            'user_push_outbox',
            // Single-row install state (migration 16.269.0): whether first-run
            // setup completed, and which account completed it. Nothing about
            // the subject beyond that one id; not a per-user record.
            'setup_lock',
        ]);

        const allowlistSet = new Set(EXPORT_TABLE_ALLOWLIST);
        const missing: string[] = [];
        for (const table of fkTables) {
            if (!allowlistSet.has(table) && !INTENTIONALLY_EXCLUDED.has(table)) {
                missing.push(table);
            }
        }

        expect(
            missing,
            `Tables with FK → users(id) not in EXPORT_TABLE_ALLOWLIST (add them or INTENTIONALLY_EXCLUDED): ${missing.join(', ')}`,
        ).toHaveLength(0);
    });

    it('still exports watchlist contents after the move to playlist_items, scoped to the subject', async () => {
        const user = await createTestUser(sql);
        const [media] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'GDPR Export Probe', 'active')
            RETURNING id::text AS id
        `;
        await upsertWatchlistItem(sql, toUserId(user.id), media.id);

        // A SECOND user with their own watchlist item. beforeEach truncates
        // users CASCADE, so without this the suite would stay green even if a
        // future edit dropped the `p.user_id = ...` predicate from either the
        // watchlist or playlist_items query — there would be no other user's
        // row in the table to leak. Same pattern as the shoutbox
        // (":267-276") and jellyfin_display_preferences (":383") tests above.
        const otherUser = await createTestUser(sql);
        const [otherMedia] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status)
            VALUES ('movie', 'GDPR Export Probe — other user', 'active')
            RETURNING id::text AS id
        `;
        await upsertWatchlistItem(sql, toUserId(otherUser.id), otherMedia.id);

        const exported = await collectUserExport(sql, user.username);

        expect(exported).not.toBeNull();

        // watchlist section — the subject's item only
        expect(exported!.watchlist.total_count).toBe(1);
        expect(exported!.watchlist.rows).toHaveLength(1);

        // playlist_items section — the subject's item present, the other
        // user's item absent. Asserted on a concrete discriminator (title),
        // not merely a count, so a query that returns the right row COUNT for
        // the wrong reason (e.g. LIMIT happening to land on 1 row) still fails.
        expect(exported!.playlist_items.rows.length).toBeGreaterThanOrEqual(1);
        const titles = exported!.playlist_items.rows.map(
            (r) => (r as Record<string, unknown>).title,
        );
        expect(titles).toContain('GDPR Export Probe');
        expect(titles).not.toContain('GDPR Export Probe — other user');
    });

    it('covers tables that reach users only through a parent table', () => {
        // playlist_items FKs playlists(id), not users(id), so the FK-parity
        // query above is structurally blind to it. This list is the manual
        // half of that guard — add to it whenever a user-owned table hangs off
        // a parent rather than off users directly.
        const INDIRECT_USER_TABLES = ['playlist_items'];
        for (const table of INDIRECT_USER_TABLES) {
            expect(EXPORT_TABLE_ALLOWLIST).toContain(table);
        }
    });
});
