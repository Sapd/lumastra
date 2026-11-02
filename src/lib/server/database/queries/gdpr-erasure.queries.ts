// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GDPR Erasure Query Module
 *
 * Implements GDPR Art. 17 (right to erasure) for one data subject.
 *
 * Strategy (resolved decision, 2026-06-22):
 * - Single `sql.begin()` transaction. Partial erasure is worse than none.
 * - Order:
 *     1. explicit-DELETE the genuine orphan tables (no FK to users, so a bare
 *        `DELETE FROM users` would leave them behind), with the RIGHT key/cast.
 *     2. ANONYMIZE audit-attribution rows (username/actor → `deleted-user:<uuid8>`
 *        tombstone) — kept under GDPR legitimate-interest (Recital 49); deleting
 *        them would corrupt operational/audit trails.
 *     3. `DELETE FROM users` last — fires the ~41 ON DELETE CASCADE FKs.
 * - HARD-delete: the users row itself is deleted (NOT soft-anonymized).
 *   `users.deleted_at` stays reserved for suspension, not erasure.
 *
 * Key-correctness (mirrors gdpr-export.queries.ts EXACTLY — it gets these right):
 * - `user_stream_policies` is keyed by **lowercase USERNAME**, never the UUID, and
 *   the `__default__` sentinel row MUST survive.
 * - `hls_playback_tokens` is keyed by the `username` column.
 * - `user_feed_preferences` stores the UUID as TEXT → `::text` (not yet migrated).
 * - `playlist_view_state` was migrated to UUID in 16.102.0; now uses `::uuid` (has
 *   ON DELETE CASCADE FK so rows are also cleaned up automatically on user deletion).
 * - `user_ratings` / `user_suggestions` are UUID-keyed (they also cascade
 *   transitively via user_profiles, but we DELETE them explicitly so the
 *   per-table count is meaningful and erasure is order-independent of profile rows).
 * - `user_watchlist` no longer holds live data as of migration 16.259.0 — watchlist
 *   contents moved to `playlist_items` under the subject's `playlist_type = 'watchlist'`
 *   playlist row. `playlists` is registered `strategy: 'cascade'` below, and
 *   `playlist_items.playlist_id` FKs `playlists(id) ON DELETE CASCADE`, so erasing the
 *   subject's `playlists` row (which the `DELETE FROM users` cascade does) takes the
 *   watchlist contents with it. No explicit DELETE needed.
 *
 * Maintainability: ERASURE_TABLE_REGISTRY (parallel to EXPORT_TABLE_ALLOWLIST) is a
 * typed catalogue of every per-user table and how erasure handles it. The integration
 * test asserts it covers every table with a direct FK → users(id) plus the known
 * orphans, so a NEW per-user table fails CI until it is registered here.
 */

import type postgres from 'postgres';
import { deleteSyncChangesForUser } from './sync-changes.queries.js';
import type { UserId } from '$lib/shared/user-id.js';
import { DIAGNOSTIC_KINDS, type DiagnosticKind } from '$lib/schemas/client-diagnostics.js';

/** client_diagnostics kinds erasure DELETES outright (the user's own logs). Typed against
 *  the canonical kind list so a rename cannot silently stop matching. */
const ERASED_DIAGNOSTIC_KINDS: readonly DiagnosticKind[] = ['log_bundle'];
/** Every other kind is kept anonymized — derived from DIAGNOSTIC_KINDS, so a new kind is
 *  scrubbed without editing this module. */
const SCRUBBED_DIAGNOSTIC_KINDS: readonly DiagnosticKind[] = DIAGNOSTIC_KINDS.filter(
    (k) => !ERASED_DIAGNOSTIC_KINDS.includes(k),
);
/** Kinds whose payload.route is user-derived (a free-form app route) and is stripped;
 *  api_failures.route is a normalized operationId and is kept. */
const ROUTE_SCRUBBED_DIAGNOSTIC_KINDS: readonly DiagnosticKind[] = ['js_error'];
/** User-derived payload keys removed from every scrubbed row. */
const ERASED_DIAGNOSTIC_PAYLOAD_KEYS = [
    'logTail',
    'clientInfo',
    'note',
    'message',
    'stack',
    'timeline',
    'errorId',
    'exceptionReason',
    'terminationReason',
    'exceptionName',
    'deviceName',
    'misses',
] as const;

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

/**
 * How a per-user table participates in erasure.
 * - `delete`       — explicit `DELETE` issued by this module (orphans with no FK to users).
 * - `anonymize`    — row survives; the attribution column is overwritten with a tombstone.
 * - `cascade`      — removed automatically by an `ON DELETE CASCADE` FK when the users
 *                    row is deleted (directly, or transitively via user_profiles). Listed
 *                    for transparency / coverage — this module issues no statement for it.
 * - `null-columns` — row survives; `columns` are explicitly nulled by this module (in
 *                    addition to whatever the users FK itself does on delete). Same
 *                    "row survives, identity gone" outcome as `anonymize`, but nulls
 *                    columns outright instead of writing a tombstone string.
 */
export type ErasureStrategy =
    | 'delete'
    | 'anonymize'
    | 'cascade'
    | 'blocks-on-actor-fk' // NOT NULL actor FK (NO ACTION/RESTRICT) → pre-flight abort.
    | 'null-columns';

/** How the user-key column is typed, so the SQL casts/compares correctly. */
export type ErasureKeyType =
    | 'uuid' // user_id uuid → ${userId}::uuid
    | 'uuid-text' // user_id TEXT holding a UUID → ${userId}::text
    | 'username' // TEXT keyed by the lowercase username
    | 'actor-jsonb'; // jsonb actor blob: actor->>'id' = username

export interface ErasureTableEntry {
    /** Postgres table name. */
    readonly table: string;
    /** The column carrying the user reference (key for delete/cascade, target for anonymize). */
    readonly keyColumn: string;
    /** How that column is typed / matched. */
    readonly keyType: ErasureKeyType;
    /** What erasure does to this table. */
    readonly strategy: ErasureStrategy;
    /** Columns nulled by a `'null-columns'` entry. Unused by other strategies. */
    readonly columns?: readonly string[];
    /** Human note (sentinel guards, transitive cascades, why anonymize, …). */
    readonly note?: string;
}

/**
 * The maintainable source of truth for erasure. Every per-user table appears here.
 * The integration test fails when a FK-to-users table (or known orphan) is missing.
 */
export const ERASURE_TABLE_REGISTRY: readonly ErasureTableEntry[] = [
    {
        table: 'sync_changes',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'delete',
        note: 'Delete after user cascades, which themselves capture per-user tombstones.',
    },
    // ── Genuine orphans — NO FK to users → MUST be deleted explicitly ──────────
    {
        table: 'user_ratings',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'delete',
        note: 'Also cascades transitively via user_profiles; deleted explicitly for a meaningful count.',
    },
    {
        table: 'user_suggestions',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'delete',
        note: 'Cascades transitively via user_profiles; deleted explicitly.',
    },
    {
        table: 'user_feed_preferences',
        keyColumn: 'user_id',
        keyType: 'uuid-text',
        strategy: 'delete',
        note: 'user_id is TEXT holding the UUID — match with ::text.',
    },
    {
        table: 'playlist_view_state',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'delete',
        note: 'user_id migrated to UUID in 16.102.0; has ON DELETE CASCADE FK so also removed automatically on user deletion.',
    },
    {
        table: 'user_stream_policies',
        keyColumn: 'user_id',
        keyType: 'username',
        strategy: 'delete',
        note: "Keyed by lowercase USERNAME; the '__default__' sentinel row MUST survive.",
    },
    {
        table: 'hls_playback_tokens',
        keyColumn: 'username',
        keyType: 'username',
        strategy: 'delete',
        note: 'Short-TTL stream tokens keyed by the username column (legacy jellyfin id in user_id).',
    },

    // ── Audit-attribution — ANONYMIZE (legitimate-interest record-keeping) ─────
    {
        table: 'audit_log',
        keyColumn: 'actor',
        keyType: 'username',
        strategy: 'anonymize',
        note: "audit_log rows with source='admin' carry the actor username; tombstone it. source='subsystem' rows have no actor and are unaffected.",
    },
    {
        table: 'service_tokens',
        keyColumn: 'created_by',
        keyType: 'username',
        strategy: 'anonymize',
        note: 'created_by is an actor username, not personal data of the subject; tombstone it.',
    },
    {
        table: 'task_webhook_hooks',
        keyColumn: 'created_by',
        keyType: 'username',
        strategy: 'anonymize',
        note: 'created_by is an actor username; tombstone it.',
    },
    {
        table: 'task_history',
        keyColumn: 'actor',
        keyType: 'actor-jsonb',
        strategy: 'anonymize',
        note: "actor jsonb { type:'user', id:<username> }; tombstone the id, keep the audit row.",
    },
    {
        table: 'task_history_archive',
        keyColumn: 'actor',
        keyType: 'actor-jsonb',
        strategy: 'anonymize',
        note: 'Archive twin of task_history; same anonymization.',
    },

    // ── Blocking actor FKs — NOT NULL, ON DELETE NO ACTION/RESTRICT ───────────
    // These name the subject as the CREATOR/ASSIGNER of admin-owned enterprise
    // content (legitimate-interest records, not the subject's personal data). The
    // column is NOT NULL so it can't be nulled, and the FK is NO ACTION/RESTRICT so
    // the final `DELETE FROM users` would FAIL (not silently orphan). Erasure
    // PRE-FLIGHTS these: if the subject owns any such row, abort with guidance to
    // re-attribute first (mirrors the spec's media_files pre-flight pattern).
    {
        table: 'courses',
        keyColumn: 'created_by',
        keyType: 'uuid',
        strategy: 'blocks-on-actor-fk',
        note: 'created_by FK → users(id) RESTRICT, NOT NULL. Re-attribute courses before erasure.',
    },
    {
        table: 'training_assignments',
        keyColumn: 'assigned_by',
        keyType: 'uuid',
        strategy: 'blocks-on-actor-fk',
        note: 'assigned_by FK → users(id) NO ACTION, NOT NULL. Re-attribute assignments before erasure. (target_user_id cascades.)',
    },

    // ── Enterprise training/access tables — direct FK CASCADE ─────────────────
    { table: 'certificates', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'course_enrollments', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'quiz_attempts', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'training_acknowledgements',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    { table: 'user_access_groups', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'user_taste_dampers', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },

    // ── Direct FK → users(id) ON DELETE CASCADE (removed by the final users delete) ─
    {
        table: 'shoutbox_messages',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'delete',
        note: 'Plugin-owned table (plugins/shoutbox); user_id FK → users(id) ON DELETE CASCADE added by ensureSchema in commit 213502df6 (feature plugins have no migration mechanism, so the FK is not in a host migration file). The constraint alone already erases these rows when the final DELETE FROM users fires — strategy is recorded as delete (not cascade) per the owner disposition: hard delete of message content, deliberately not anonymize. user_id is nullable — legacy pre-UUID rows whose username backfill was ambiguous or never resolved stay NULL and are not matched by any user_id equality, so they are untouched by erasure.',
    },
    {
        table: 'shoutbox_ai_invocations',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: "Plugin-owned table (plugins/shoutbox); one row per AI invocation the subject triggered, added by ensureSchema for the 2026-09-13 C25 rate-limit fix (feature plugins have no migration mechanism, so this is not in a host migration file). user_id is NOT NULL with an FK → users(id) ON DELETE CASCADE, so the final DELETE FROM users removes every row — recorded as 'cascade' rather than 'delete' because this module deliberately issues no statement for it: the table is absent on installs that never loaded the shoutbox, and an unguarded DELETE there would raise undefined_table and abort the whole erasure transaction.",
    },
    { table: 'active_transcode_jobs', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'user_notification_webhooks',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: "The subject's own outbound endpoint URL — personal data, so DELETED with them, unlike task_webhook_hooks.created_by which is an actor attribution and is tombstoned. Queued task_webhook_outbox rows cascade from here in turn.",
    },
    { table: 'assistant_messages', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'interaction_reactions',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Per-target emoji reactions — user_id FK → users(id) ON DELETE CASCADE.',
    },
    {
        table: 'interactions',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Polymorphic comment store — user_id FK → users(id) ON DELETE CASCADE.',
    },
    { table: 'assistant_rate_limits', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'collaborative_chat_messages',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'jellyfin_client_passwords',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'jellyfin_display_preferences',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Saved /j DisplayPreferences DTOs (migration 16.207.0) — direct ON DELETE CASCADE FK → users(id).',
    },
    {
        table: 'livetv_channel_favorites',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'livetv_simple_mode',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Live TV simple mode (migration 16.307.0). Direct ON DELETE CASCADE FK → users(id).',
    },
    {
        table: 'livetv_simple_mode',
        keyColumn: 'updated_by',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'ON DELETE SET NULL — a helper or admin who set up another user is cleared by the final users delete (self-anonymizes).',
    },
    {
        table: 'livetv_channel_watch_history',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    { table: 'media_annotations', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'music_listen_events', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'music_play_starts', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'oauth_device_codes', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'oauth_refresh_tokens', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'personal_access_tokens', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'play_sessions', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'playback_session_quality',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    { table: 'playlist_item_watched', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'playlist_members', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    // `playlist_watch_announcements` was here. Dropped by migration 16.203.0 —
    // it was declared in the base schema, never read or written by any code
    // path, and empty in production. Erasure must not query a table that no
    // longer exists.
    {
        table: 'playlists',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'playlist_items cascades from here, which is what erases the subject watchlist contents since 16.259.0.',
    },
    {
        table: 'plugin_user_credentials',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'service_tokens_act_as',
        keyColumn: 'act_as_user',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'service_tokens.act_as_user FK → users(id) CASCADE (distinct from created_by anonymize above).',
    },
    {
        table: 'subsonic_client_passwords',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    // user_excluded_series folded into user_media_flags (migration 16.108.0) — table dropped.
    // Its data is now covered by user_media_flags (cascade, below).
    { table: 'user_identities', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'user_library_permissions',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    { table: 'user_media_events', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'user_media_events_archive',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'user_media_flags',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Generic flag store. Covers dismissed_cw, featured_pick_shown, new_episode_alert_dismissed, request_dismissed (formerly user_notification_dismissals), series_excluded (formerly user_excluded_series). All removed by cascade.',
    },
    { table: 'user_media_state', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'user_music_state', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'user_notifications', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'user_pinned_genres', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'user_playback_preference_devices',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Browser write-order generations cascade directly from users; child field orders cascade from here.',
    },
    {
        table: 'user_playback_preference_orders',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Transitive cascade through user_playback_preference_devices(user_id, device_id).',
    },
    {
        table: 'user_playback_preferences',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'user_profiles',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Parent of the transitive cascade for user_ratings/watchlist/suggestions/playback_quality. (user_notification_dismissals folded into user_media_flags, migration 16.108.0.)',
    },
    {
        table: 'user_provider_device_tokens',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    {
        table: 'user_devices',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Device registry (migration 16.174.0). Direct ON DELETE CASCADE FK → users(id). Holds display names the subject or their client supplied ("Wohnzimmer"), so it is personal data and must go on erasure. watch_history.user_device_id is ON DELETE SET NULL, so archive rows survive with the link cleared.',
    },
    {
        table: 'device_control_grants',
        keyColumn: 'owner_user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Household remote-control grants the subject gave (migration 16.309.0). ON DELETE CASCADE FK → users(id).',
    },
    {
        table: 'device_control_grants',
        keyColumn: 'grantee_user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Household remote-control grants the subject received (migration 16.309.0). ON DELETE CASCADE FK → users(id).',
    },
    {
        table: 'user_push_tokens',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'APNs device tokens (migration 16.199.0). Direct ON DELETE CASCADE FK → users(id). A device token is a stable per-install identifier tied to a person, so it is personal data and must go on erasure — the cascade via user_devices is not sufficient on its own because the FK to users is direct.',
    },
    {
        table: 'user_push_outbox',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Pending push deliveries (migration 16.199.0). Direct ON DELETE CASCADE FK → users(id). Short-lived (~21 minutes) but holds the subject notification ids, so it is erased with them.',
    },
    {
        table: 'user_media_share_opt_out',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Per-book social-sharing suppressions (migration 16.180.0). Direct ON DELETE CASCADE FK → users(id). The set of titles the subject chose to hide from their trust circle is itself a statement about their reading, so it is personal data and goes on erasure.',
    },
    {
        table: 'user_rate_skips',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Durable /rate swipe-trainer skips (migration 16.149.0). Direct ON DELETE CASCADE FK → users(id).',
    },
    {
        table: 'user_search_preferences',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    { table: 'user_section_feedback', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'user_sessions', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'user_widget_order', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'watch_history', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'watch_state_pending_resolution',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
    },
    { table: 'watch_state_pull_log', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'watch_sync_activity', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    {
        table: 'watch_sync_preferences',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Per-provider direction preference + push watermark — user_id FK → users(id) ON DELETE CASCADE.',
    },
    { table: 'watch_state_sync_log', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },
    { table: 'watchlist_activities', keyColumn: 'user_id', keyType: 'uuid', strategy: 'cascade' },

    // ── Transitive cascade via user_profiles(user_id) → users(id) CASCADE ──────
    {
        table: 'user_playback_quality',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'FK → user_profiles(user_id) CASCADE → users CASCADE. Do NOT double-delete.',
    },
    // user_notification_dismissals folded into user_media_flags (migration 16.108.0) — table dropped.
    // Its data is now covered by user_media_flags (cascade entry above).

    // ── ON DELETE SET NULL — self-anonymizing on the final users delete ────────
    {
        table: 'playback_telemetry',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'ON DELETE SET NULL — user_id nulled by the final users delete (self-anonymizes).',
    },
    {
        table: 'playback_incident_events',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'null-columns',
        columns: ['device_id', 'client_info', 'message'],
        note: 'Frozen legacy table (rows copied into client_diagnostics by 16.268.0, dropped by a later migration). user_id nulled + device_id/client_info/message explicitly scrubbed, and the NOT NULL timeline reset to [] by an explicit step in eraseUserData — this table carries a denser behavioral trace (seeks, UA, free-text messages) than playback_telemetry, so it gets real content-level erasure, not just FK cascade.',
    },
    {
        table: 'client_diagnostics',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'null-columns',
        columns: ['device_id', 'play_session_id', 'attempt_id', 'media_id'],
        note: 'Explicit step in eraseUserData: log_bundle rows are DELETED (blobs cascade) — including a device-scoped bundle uploaded by a DIFFERENT account whose payload.accountIds lists this user (spec §7); other kinds get user_id/device_id/play_session_id/attempt_id/media_id/summary nulled and user-derived payload parts (logTail, clientInfo, note, message, stack, timeline, errorId, exceptionReason, terminationReason, exceptionName, deviceName, misses, and route for js_error only — api_failures.route is a normalized operationId, kept) removed — the forensic shape (kind, platform, versions, occurred/received_at, occurrences, fingerprint) stays, the person does not. client_diagnostic_blobs has no user column and cascades from its parent.',
    },
    {
        table: 'network_speed_tests',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'null-columns',
        columns: ['device_id', 'client_info'],
        note: 'user_id nulled + device_id/client_info scrubbed — a measured line speed is a household fingerprint.',
    },
    {
        table: 'plugin_secret_access_log',
        keyColumn: 'user_id',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'ON DELETE SET NULL — self-anonymizes on the final users delete.',
    },
    {
        table: 'setup_lock',
        keyColumn: 'completed_by',
        keyType: 'uuid',
        strategy: 'cascade',
        note: 'Single-row setup lock (migration 16.269.0). completed_by is ON DELETE SET NULL: erasing the admin who completed setup clears the reference and keeps the lock (the row must survive, or erasure would reopen first-run setup).',
    },
];

/** The `__default__` global stream-policy sentinel that must never be erased. */
export const STREAM_POLICY_SENTINEL = '__default__';

// ---------------------------------------------------------------------------
// Report shape
// ---------------------------------------------------------------------------

/** Per-table erasure outcome, surfaced in the erasure-confirmation artifact. */
export interface ErasureTableReport {
    table: string;
    strategy: ErasureStrategy;
    /** Rows hard-deleted by an explicit DELETE (strategy = 'delete'). */
    deleted: number;
    /** Rows pseudonymized in place (strategy = 'anonymize'). */
    anonymized: number;
}

/** One blocking actor-FK reference found during pre-flight. */
export interface ErasureBlocker {
    table: string;
    column: string;
    count: number;
}

/** Full erasure result for the audit record. */
export interface ErasureResult {
    userId: string;
    username: string;
    /** True if the final `DELETE FROM users` removed the row. */
    userDeleted: boolean;
    /** Per-table breakdown for the explicit-delete + anonymize tables. */
    tables: ErasureTableReport[];
    /** Aggregate counts across all explicit operations. */
    totalDeleted: number;
    totalAnonymized: number;
    /**
     * Non-empty ONLY when erasure was aborted by the pre-flight: the subject is the
     * creator/assigner of admin-owned content via a NOT NULL, NO ACTION/RESTRICT FK.
     * When present, `userDeleted` is false and no rows were changed (tx rolled back).
     */
    blocked?: ErasureBlocker[];
}

// ---------------------------------------------------------------------------
// eraseUserData
// ---------------------------------------------------------------------------

/**
 * Tombstone string written into anonymized attribution columns. Stable, not
 * back-linked to users, derived from the first 8 chars of the subject's UUID.
 */
export function erasureTombstone(userId: string): string {
    return `deleted-user:${userId.slice(0, 8)}`;
}

/**
 * Erase one data subject. Runs everything inside a SINGLE transaction:
 *   1. DELETE the genuine orphans (right key/cast, sentinel-guarded).
 *   2. ANONYMIZE the audit-attribution rows.
 *   3. DELETE FROM users (fires the cascades).
 *
 * @param sql      postgres.Sql connection (a fresh transaction is opened here).
 * @param userId   The subject's stable users.id UUID.
 * @param username The subject's login handle (any case; lowercased internally for
 *                 username-keyed tables and actor matching).
 * @returns The per-table erasure report, or null if the user did not exist.
 */
export async function eraseUserData(
    sql: postgres.Sql,
    userId: UserId | string,
    username: string,
): Promise<ErasureResult | null> {
    const lowerUsername = username.toLowerCase();
    const tombstone = erasureTombstone(userId);

    return sql.begin(async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Guard: the user must still exist. Doing this inside the tx avoids a TOCTOU
        // race with a concurrent delete.
        const exists = await tx<{ id: string }[]>`
            SELECT id FROM users WHERE id = ${userId}::uuid LIMIT 1
        `;
        if (!exists[0]) return null;

        // ── 0. PRE-FLIGHT: blocking actor FKs ─────────────────────────────────
        // If the subject is the creator/assigner of admin-owned enterprise content
        // via a NOT NULL, NO ACTION/RESTRICT FK, the final users delete would FAIL.
        // Abort the whole transaction with guidance to re-attribute first, rather
        // than letting the cascade either fail loudly or (worse) destroy content.
        // Each table is existence-guarded via to_regclass so the check is a no-op on
        // installs that haven't run the enterprise-training migrations.
        const blocked: ErasureBlocker[] = [];
        for (const entry of ERASURE_TABLE_REGISTRY) {
            if (entry.strategy !== 'blocks-on-actor-fk') continue;
            const reg = await tx<{ exists: string | null }[]>`
                SELECT to_regclass(${'public.' + entry.table}) AS exists
            `;
            if (!reg[0]?.exists) continue;
            const hit = await tx<{ n: number }[]>`
                SELECT COUNT(*)::int AS n
                FROM ${tx(entry.table)}
                WHERE ${tx(entry.keyColumn)} = ${userId}::uuid
            `;
            const n = hit[0]?.n ?? 0;
            if (n > 0) blocked.push({ table: entry.table, column: entry.keyColumn, count: n });
        }
        if (blocked.length > 0) {
            return {
                userId: String(userId),
                username,
                userDeleted: false,
                tables: [],
                totalDeleted: 0,
                totalAnonymized: 0,
                blocked,
            } satisfies ErasureResult;
        }

        const tables: ErasureTableReport[] = [];

        // ── 1. Explicit DELETE of the genuine orphans ─────────────────────────
        // user_ratings / user_suggestions — UUID-keyed
        const ratingsDel = await tx`DELETE FROM user_ratings WHERE user_id = ${userId}::uuid`;
        tables.push({
            table: 'user_ratings',
            strategy: 'delete',
            deleted: ratingsDel.count,
            anonymized: 0,
        });

        // client_diagnostics — bundles are the user's own logs: delete. Other kinds keep
        // their technical shape (kind, platform, versions, occurred/received_at,
        // occurrences, fingerprint) for fleet statistics but lose everything
        // user-derived and every linkability column. Handled explicitly here
        // (registry entry documents it) rather than by the generic 'null-columns'
        // loop below, which is excluded from processing this table a second time.
        //
        // Bundle deletion also covers spec §7's device-scoped case: a device-scoped
        // bundle (scope: 'device') is attributed to whichever account uploaded it
        // (user_id), but its payload.accountIds lists every SERVER account whose log
        // segments the bundle contains (§10.3 — "another household member's activity
        // out of a bundle attributed to someone else" is exactly what scope:'device'
        // is for). Erasing account B must also remove a bundle account A uploaded
        // if B's id appears in that bundle's accountIds, even though user_id = A —
        // the `?` jsonb operator checks membership in the accountIds array.
        const diagBundlesDel = await tx`
            DELETE FROM client_diagnostics
            WHERE kind = ANY(${[...ERASED_DIAGNOSTIC_KINDS]}::text[])
              AND (user_id = ${userId}::uuid OR payload->'accountIds' ? lower(${String(userId)}))
        `;
        // Every remaining (non-bundle) row of THIS user: null every column that
        // links the row back to a person (user_id, device_id, summary, and the
        // session/attempt/media identifiers that could otherwise re-associate an
        // "anonymous" row with the subject's other activity), and strip every
        // user-derived payload key. `route` is scrubbed only for js_error — an
        // app-error stack's route can carry free-form path segments — while
        // api_failures.route is a normalized operationId/templated path (no user
        // data) and is a load-bearing fleet-health dimension, so it is kept.
        const diagScrubbed = await tx`
            UPDATE client_diagnostics
            SET user_id = NULL,
                device_id = NULL,
                play_session_id = NULL,
                attempt_id = NULL,
                media_id = NULL,
                summary = NULL,
                payload = CASE
                    WHEN kind = ANY(${[...ROUTE_SCRUBBED_DIAGNOSTIC_KINDS]}::text[]) THEN
                        payload - ${[...ERASED_DIAGNOSTIC_PAYLOAD_KEYS, 'route']}::text[]
                    ELSE
                        payload - ${[...ERASED_DIAGNOSTIC_PAYLOAD_KEYS]}::text[]
                END
            WHERE user_id = ${userId}::uuid
              AND kind = ANY(${[...SCRUBBED_DIAGNOSTIC_KINDS]}::text[])
        `;
        tables.push({
            table: 'client_diagnostics',
            strategy: 'null-columns',
            deleted: diagBundlesDel.count,
            anonymized: diagScrubbed.count,
        });

        const suggestionsDel =
            await tx`DELETE FROM user_suggestions WHERE user_id = ${userId}::uuid`;
        tables.push({
            table: 'user_suggestions',
            strategy: 'delete',
            deleted: suggestionsDel.count,
            anonymized: 0,
        });

        // user_feed_preferences — UUID stored as TEXT (not yet migrated)
        const feedDel = await tx`DELETE FROM user_feed_preferences WHERE user_id = ${userId}::uuid`;
        tables.push({
            table: 'user_feed_preferences',
            strategy: 'delete',
            deleted: feedDel.count,
            anonymized: 0,
        });

        // playlist_view_state — user_id is now UUID (migrated in 16.102.0);
        // the ON DELETE CASCADE FK handles deletion automatically, but we also
        // delete explicitly here so the audit log captures the count.
        const viewStateDel =
            await tx`DELETE FROM playlist_view_state WHERE user_id = ${userId}::uuid`;
        tables.push({
            table: 'playlist_view_state',
            strategy: 'delete',
            deleted: viewStateDel.count,
            anonymized: 0,
        });

        // user_stream_policies — keyed by lowercase USERNAME; NEVER touch __default__
        const streamDel = await tx`
            DELETE FROM user_stream_policies
            WHERE user_id = ${lowerUsername} AND user_id <> ${STREAM_POLICY_SENTINEL}
        `;
        tables.push({
            table: 'user_stream_policies',
            strategy: 'delete',
            deleted: streamDel.count,
            anonymized: 0,
        });

        // hls_playback_tokens — keyed by the username column (optional table: only
        // present on installs that have run the HLS streaming migrations).
        {
            const [{ exists }] = await tx<{ exists: boolean }[]>`
                SELECT to_regclass('public.hls_playback_tokens') IS NOT NULL AS exists
            `;
            if (exists) {
                const hlsDel =
                    await tx`DELETE FROM hls_playback_tokens WHERE username = ${lowerUsername}`;
                tables.push({
                    table: 'hls_playback_tokens',
                    strategy: 'delete',
                    deleted: hlsDel.count,
                    anonymized: 0,
                });
            }
        }

        // ── 2. ANONYMIZE audit-attribution rows ───────────────────────────────
        // audit_log.actor (source='admin' rows) — operational audit trail;
        // kept under GDPR legitimate-interest (Recital 49); actor tombstoned.
        // source='subsystem' rows have no actor column set and are unaffected.
        const auditLogAnon = await tx`
            UPDATE audit_log SET actor = ${tombstone}
            WHERE source = 'admin' AND LOWER(actor) = ${lowerUsername}
        `;
        tables.push({
            table: 'audit_log',
            strategy: 'anonymize',
            deleted: 0,
            anonymized: auditLogAnon.count,
        });

        // service_tokens.created_by (username) — keep the token row, tombstone the actor.
        const svcAnon = await tx`
            UPDATE service_tokens SET created_by = ${tombstone}
            WHERE LOWER(created_by) = ${lowerUsername}
        `;
        tables.push({
            table: 'service_tokens',
            strategy: 'anonymize',
            deleted: 0,
            anonymized: svcAnon.count,
        });

        // task_webhook_hooks.created_by (username) — optional table: only present on
        // installs that have run the webhook-hooks migration.
        {
            const [{ exists }] = await tx<{ exists: boolean }[]>`
                SELECT to_regclass('public.task_webhook_hooks') IS NOT NULL AS exists
            `;
            if (exists) {
                const hookAnon = await tx`
                    UPDATE task_webhook_hooks SET created_by = ${tombstone}
                    WHERE LOWER(created_by) = ${lowerUsername}
                `;
                tables.push({
                    table: 'task_webhook_hooks',
                    strategy: 'anonymize',
                    deleted: 0,
                    anonymized: hookAnon.count,
                });
            }
        }

        // user_stream_policies.updated_by — the __default__ sentinel (which survives)
        // may still name the erased user as its last editor; tombstone any such ref.
        const streamUpdatedByAnon = await tx`
            UPDATE user_stream_policies SET updated_by = ${tombstone}
            WHERE LOWER(updated_by) = ${lowerUsername}
        `;
        tables.push({
            table: 'user_stream_policies.updated_by',
            strategy: 'anonymize',
            deleted: 0,
            anonymized: streamUpdatedByAnon.count,
        });

        // task_history.actor jsonb { type:'user', id:<username> } — tombstone the id.
        const histAnon = await tx`
            UPDATE task_history
            SET actor = jsonb_set(actor, '{id}', to_jsonb(${tombstone}::text))
            WHERE actor->>'type' = 'user' AND LOWER(actor->>'id') = ${lowerUsername}
        `;
        tables.push({
            table: 'task_history',
            strategy: 'anonymize',
            deleted: 0,
            anonymized: histAnon.count,
        });

        // task_history_archive — optional table: only present on installs that have
        // run the history-archive migration.
        {
            const [{ exists }] = await tx<{ exists: boolean }[]>`
                SELECT to_regclass('public.task_history_archive') IS NOT NULL AS exists
            `;
            if (exists) {
                const histArchiveAnon = await tx`
                    UPDATE task_history_archive
                    SET actor = jsonb_set(actor, '{id}', to_jsonb(${tombstone}::text))
                    WHERE actor->>'type' = 'user' AND LOWER(actor->>'id') = ${lowerUsername}
                `;
                tables.push({
                    table: 'task_history_archive',
                    strategy: 'anonymize',
                    deleted: 0,
                    anonymized: histArchiveAnon.count,
                });
            }
        }

        // Legacy playback_incident_events: `timeline` (seek/stall trace, free text) is
        // NOT NULL DEFAULT '[]', so the generic SET-NULL loop below cannot scrub it —
        // reset it explicitly while user_id still matches. Existence-guarded like the
        // loop: the table is frozen and a later migration drops it.
        const legacyIncidentReg = await tx<{ exists: string | null }[]>`
            SELECT to_regclass('public.playback_incident_events')::text AS exists
        `;
        if (legacyIncidentReg[0]?.exists) {
            await tx`
                UPDATE playback_incident_events
                SET timeline = '[]'::jsonb
                WHERE user_id = ${userId}::uuid
            `;
        }

        // `null-columns` tables — the registry entry's `columns` are explicitly
        // nulled ahead of the final DELETE below. Must run while user_id still
        // equals the subject's id, or these WHERE clauses would no longer find
        // the rows; each FK's own ON DELETE SET NULL then nulls user_id itself
        // when users is deleted.
        //
        // Both the table list AND the SET list come FROM the registry rather
        // than being hardcoded here: with a literal `SET device_id = NULL,
        // client_info = NULL` per table, adding a column — or a whole table —
        // to the registry would look like it widened erasure while silently
        // changing nothing. Table and column names go through tx(identifier)
        // for escaping — they are developer-authored, never user input.
        for (const entry of ERASURE_TABLE_REGISTRY.filter(
            // client_diagnostics is strategy 'null-columns' in the registry (for
            // documentation/coverage) but is handled EXPLICITLY above — the
            // delete of log_bundle rows must run before any generic column-null
            // pass, and the scrub is a payload-key removal, not a plain SET
            // NULL. Excluded here so it is never processed twice.
            (e) => e.strategy === 'null-columns' && e.table !== 'client_diagnostics',
        )) {
            // Existence-guarded like the pre-flight loop above: a registry entry
            // for a table an install has never migrated (an optional/plugin-owned
            // one, say) must skip quietly. Without this the UPDATE raises
            // undefined_table and aborts the WHOLE erasure transaction — the
            // subject's deletion request fails on a table that holds nothing.
            const reg = await tx<{ exists: string | null }[]>`
                SELECT to_regclass(${'public.' + entry.table}) AS exists
            `;
            if (!reg[0]?.exists) {
                tables.push({
                    table: entry.table,
                    strategy: 'null-columns',
                    deleted: 0,
                    anonymized: 0,
                });
                continue;
            }
            if (!entry.columns?.length) {
                throw new Error(
                    `ERASURE_TABLE_REGISTRY entry for '${entry.table}' is misconfigured: ` +
                        "a 'null-columns' strategy requires a non-empty `columns` list",
                );
            }
            // The ::uuid cast below is only correct for a uuid key column. A
            // future entry keyed by username must extend this, not inherit a
            // silently-wrong comparison.
            if (entry.keyType !== 'uuid') {
                throw new Error(
                    `ERASURE_TABLE_REGISTRY entry for '${entry.table}' is misconfigured: ` +
                        `'null-columns' supports keyType 'uuid' only, got '${entry.keyType}'`,
                );
            }
            const setClause = entry.columns
                .map((column) => tx`${tx(column)} = NULL`)
                .reduce((acc, clause) => tx`${acc}, ${clause}`);
            const scrubbed = await tx`
                UPDATE ${tx(entry.table)}
                SET ${setClause}
                WHERE ${tx(entry.keyColumn)} = ${userId}::uuid
            `;
            tables.push({
                table: entry.table,
                strategy: 'null-columns',
                deleted: 0,
                anonymized: scrubbed.count,
            });
        }

        // ── 3. DELETE FROM users LAST — fires the ~41 ON DELETE CASCADE FKs ────
        const userDel = await tx`DELETE FROM users WHERE id = ${userId}::uuid RETURNING id`;
        const userDeleted = userDel.length > 0;
        const syncDeleted = await deleteSyncChangesForUser(tx, String(userId));
        tables.push({
            table: 'sync_changes',
            strategy: 'delete',
            deleted: syncDeleted,
            anonymized: 0,
        });

        const totalDeleted = tables.reduce((n, t) => n + t.deleted, 0);
        const totalAnonymized = tables.reduce((n, t) => n + t.anonymized, 0);

        return {
            userId: String(userId),
            username,
            userDeleted,
            tables,
            totalDeleted,
            totalAnonymized,
        } satisfies ErasureResult;
    });
}
