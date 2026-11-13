// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GDPR Export Query Module
 *
 * Collects all per-user data for a GDPR Art. 15 (right of access) export.
 *
 * Design notes:
 * - ALLOWLIST: tables are explicitly enumerated — new tables fail CI until added.
 * - EXCLUDE: avatar_data (bytea), password_hash, token/secret columns, raw vectors.
 *   Specifically excluded secret columns:
 *     user_sessions.token_hash (session token hash — cryptographic secret)
 *     user_provider_device_tokens.provider_access_token (Jellyfin bearer token)
 *     oauth_device_codes.device_code, oauth_device_codes.user_code (OAuth secrets)
 *     user_notification_webhooks.secret_encrypted (outbound HMAC signing key)
 *   Note: user_sessions.ip IS included — it is personal data (GDPR Recital 30,
 *   ECJ C-582/14) and the data subject is entitled to it under Art. 15.
 * - CAP: large append-only tables are limited to 10k rows with a `truncated` marker.
 * - TEXT keys: user_stream_policies, user_feed_preferences store user_id as TEXT.
 *   playlist_view_state was migrated to UUID in 16.102.0 and now uses ::uuid.
 * - Optional private-module tables (certificates, course_enrollments, quiz_attempts,
 *   training_acknowledgements) and the plugin-owned shoutbox_messages table
 *   are guarded with a query-level `.catch()` fallback to an empty section;
 *   they degrade gracefully on installs without the assessment migrations, or
 *   without the shoutbox plugin ever having run its own ensureSchema.
 */

import type postgres from 'postgres';
import type { UserId } from '$lib/shared/user-id.js';
import type { UserDataExport, TruncatedSection } from '$lib/schemas/gdpr.js';
import { EVENT_LIMITS } from '$lib/schemas/client-diagnostics.js';
import { inflateBounded } from '$lib/server/services/client-diagnostics/gzip.js';
import {
    withBundleSlot,
    BundleBusyError,
} from '$lib/server/services/client-diagnostics/semaphore.js';

/** Total UTF-8 bytes of bundle log text one export may carry. Every exported row stays
 *  in memory until the export document is serialized, so without a ceiling the export
 *  would hold every bundle's inflated text (up to 16 MiB each) at once. */
const EXPORT_LOG_TEXT_MAX_BYTES = 64 * 1024 * 1024;
let exportLogTextCapOverride: number | null = null;
/** Test seam: ESM const bindings cannot be spied. */
export function setExportLogTextCapOverrideForTests(value: number | null): void {
    exportLogTextCapOverride = value;
}
const exportLogTextCap = (): number => exportLogTextCapOverride ?? EXPORT_LOG_TEXT_MAX_BYTES;
/** Exports queue for a decode slot rather than fail fast like an upload does. */
const EXPORT_SLOT_WAIT_MS = 60_000;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum rows to return from any single table to avoid streaming GBs. */
const PER_TABLE_LIMIT = 10_000;

/**
 * Allowlisted tables — every table that holds per-user data.
 * The integration test asserts this list is non-empty and covers all tables with
 * a direct FK to users(id). When a new user-scoped table is added to the schema,
 * add it here (or to INTENTIONALLY_EXCLUDED in the CI parity test) to pass CI.
 */
export const EXPORT_TABLE_ALLOWLIST: ReadonlyArray<string> = [
    'sync_changes',
    // UUID-keyed (FK → users.id ON DELETE CASCADE)
    'user_ratings',
    // Watchlist contents now live in playlist_items under the user's
    // playlist_type = 'watchlist' row. Listed here rather than relying on the
    // FK-parity test, which only sees tables with a direct FK to users(id) —
    // playlist_items FKs playlists(id), so it is structurally invisible there.
    'playlist_items',
    'user_suggestions',
    'user_media_state',
    'user_media_events',
    'user_media_events_archive',
    'user_media_flags',
    'user_profiles',
    'user_playback_preferences',
    'user_widget_order',
    'user_search_preferences',
    'user_pinned_genres',
    'user_section_feedback',
    'user_rate_skips',
    // Per-book social-sharing suppressions (migration 16.180.0) — the set of
    // titles the subject chose to hide from their trust circle
    'user_media_share_opt_out',
    // user_excluded_series and user_notification_dismissals were folded into
    // user_media_flags in migration 16.108.0 — they no longer exist as tables.
    // user_media_flags (already listed above) covers their data.
    'watch_history',
    'media_annotations',
    'personal_access_tokens',
    'oauth_refresh_tokens',
    'subsonic_client_passwords',
    'jellyfin_client_passwords',
    'assistant_messages',
    'watchlist_activities',
    'music_listen_events',
    'music_play_starts',
    'user_music_state',
    'user_taste_dampers',
    'playlists',
    'playlist_members',
    'playlist_item_watched',
    // Viewing sessions — primary per-user play log (FK → users.id ON DELETE CASCADE)
    'play_sessions',
    // Watch-sync logs (FK → users.id ON DELETE CASCADE)
    'watch_state_sync_log',
    'watch_state_pull_log',
    'watch_sync_activity',
    'watch_sync_preferences',
    // Plugin credentials — metadata only, secret material excluded (FK → users.id ON DELETE CASCADE)
    'plugin_user_credentials',
    // Generic comments + reactions (FK → users.id ON DELETE CASCADE)
    'interactions',
    'interaction_reactions',
    // Collaborative chat messages (FK → users.id ON DELETE CASCADE)
    'collaborative_chat_messages',
    // Public shoutbox chat messages — plugin-owned (plugins/shoutbox); user_id FK →
    // users.id ON DELETE CASCADE added by ensureSchema in commit 213502df6
    'shoutbox_messages',
    // Shoutbox AI invocations — plugin-owned (plugins/shoutbox); user_id NOT NULL
    // FK → users.id ON DELETE CASCADE, added by ensureSchema for the 2026-09-13
    // C25 rate-limit fix. Exported rather than excluded as a rate-limit counter,
    // which is how assistant_rate_limits is treated in the integration test's
    // INTENTIONALLY_EXCLUDED set. This entry originally rested on two
    // differences; only the first is still true, and it is the one that decides
    // it:
    //   1. Granularity — assistant_rate_limits is an AGGREGATE (one row per user
    //      per day carrying a count); this is an EVENT LOG (one row per
    //      invocation carrying an exact timestamptz). The counter discloses
    //      nothing about the subject beyond the linkage to themselves; a
    //      timestamped event is a behavioral trace about them, and the
    //      assistant_rate_limits "transient, no PII" rationale does not reach
    //      it. Same reasoning already applied to network_speed_tests below.
    //   2. Retention — NO LONGER TRUE, and deliberately so. This used to read
    //      "nothing anywhere prunes shoutbox_ai_invocations, so rows outlive the
    //      one-hour window they exist to serve and accumulate for the life of
    //      the account". They no longer do: plugins/shoutbox/lib/queries.js
    //      prunes past AI_INVOCATION_RETENTION_SECONDS (2h) inside
    //      reserveAiInvocation, and pruneAiInvocations runs from the plugin's
    //      onStartup for installs where the bot stopped being used. A section
    //      here now holds hours, not years.
    // That bounded retention is a fair argument for excluding the table as
    // genuinely transient, and it was weighed. It loses to (1): Art. 15 covers
    // what is held when the request arrives, with no de minimis, and the cost of
    // keeping it is a handful of rows in the export against losing coverage of a
    // behavioral trace. If the section is ever moved to INTENTIONALLY_EXCLUDED,
    // the schema section in $lib/schemas/gdpr.ts and the query + assembly below
    // go with it. Erasure registration (gdpr-erasure.queries.ts) stays either
    // way — retention bounds how long a row lives, it does not satisfy Art. 17
    // for the rows that are still there.
    'shoutbox_ai_invocations',
    // LiveTV channel watch history (FK → users.id ON DELETE CASCADE)
    'livetv_channel_watch_history',
    // LiveTV channel favorites (FK → users.id ON DELETE CASCADE)
    'livetv_channel_favorites',
    // LiveTV simple mode (FK → users.id ON DELETE CASCADE); pin_hash is never exported
    'livetv_simple_mode',
    // User library permissions — admin-managed access config (FK → users.id ON DELETE CASCADE)
    'user_library_permissions',
    // Session tokens — metadata only; token_hash and raw ip excluded (FK → users.id ON DELETE CASCADE)
    'user_sessions',
    // Jellyfin/provider device tokens — metadata only; provider_access_token excluded (FK → users.id ON DELETE CASCADE)
    'user_provider_device_tokens',
    // Device registry — display names the subject chose or their client reported
    // ("Wohnzimmer" is a home-layout detail) (FK → users.id ON DELETE CASCADE)
    'user_devices',
    // Household remote-control grants, both directions: who may control the
    // subject's devices and whose devices the subject may control (migration
    // 16.309.0; both FKs → users.id ON DELETE CASCADE)
    'device_control_grants',
    // APNs push-notification device tokens (migration 16.199.0) — a device token is
    // a stable per-install identifier tied to a person, and the row also carries a
    // device association and a locale; treated like user_devices and
    // user_provider_device_tokens above, both of which are exported
    // (FK → users.id ON DELETE CASCADE)
    'user_push_tokens',
    // OAuth device-flow authorization records — metadata only; device_code/user_code excluded (FK → users.id ON DELETE CASCADE)
    'oauth_device_codes',
    // Assessment tables — optional (guarded at query time with to_regclass)
    'certificates',
    'course_enrollments',
    'quiz_attempts',
    'training_acknowledgements',
    // Training assignments — target_user_id is personal data (who was assigned what)
    'training_assignments',
    // Access group memberships — admin-managed, but the subject's group list is personal data
    'user_access_groups',
    // Durable notification inbox (FK → users.id ON DELETE CASCADE)
    'user_notifications',
    // Per-user outbound notification endpoint (migration 16.192.0) — the URL the
    // subject configured is their personal data; secret_encrypted is excluded
    // (FK → users.id ON DELETE CASCADE)
    'user_notification_webhooks',
    // TEXT-keyed (no FK to users) — queried separately
    'user_stream_policies',
    'user_feed_preferences',
    'playlist_view_state',
    // Client-reported playback incident forensic log (migration 16.210.0) —
    // ON DELETE SET NULL like playback_telemetry, but deliberately NOT
    // intentionally-excluded: it carries a denser behavioral trace (seeks,
    // stalls, device_id, client_info) than playback_telemetry, so it gets
    // real Art. 15 export coverage instead of relying on the FK-null
    // anonymization alone.
    'playback_incident_events',
    // client_diagnostics (migration 16.268.0) — everything the subject's apps
    // reported (playback incidents, crashes, hangs, JS errors, API failure
    // counts, log bundles). Payloads are redacted at write time. Kept alongside
    // playback_incident_events (the legacy table, frozen, until the drop
    // migration) rather than replacing it in the allowlist.
    'client_diagnostics',
    // Saved /j DisplayPreferences DTOs (migration 16.207.0) — a subject's
    // homepage/library-view personalization for the Jellyfin-compat layer
    // (FK → users.id ON DELETE CASCADE)
    'jellyfin_display_preferences',
    // Client-timed network speed tests (migration 16.248.0) — ON DELETE SET NULL
    // like playback_telemetry, but exported rather than left to the FK-null
    // anonymization: a measured line speed, repeated over months, is a
    // household fingerprint (when someone is home, which ISP tier they pay for),
    // so the subject gets real Art. 15 visibility into it — the full row, like
    // playback_incident_events.
    'network_speed_tests',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a SELECT, apply a per-table cap, and return a TruncatedSection.
 */
function toSection(rows: Record<string, unknown>[], total: number): TruncatedSection {
    // A table is truncated only when the real row count exceeds the cap.
    // Using `rows.length >= PER_TABLE_LIMIT` would produce a false positive when a user
    // has exactly PER_TABLE_LIMIT rows (all rows returned, nothing omitted).
    const truncated = total > PER_TABLE_LIMIT;
    return { rows, truncated, total_count: total };
}

/**
 * client_diagnostics — everything the subject's apps reported (playback incidents,
 * crashes, errors, API failure counts, log bundles). Payloads are redacted at write
 * time, so the raw row is safe to export as-is. Each `log_bundle` row is additionally
 * exported with its FULL log text (`logText`): the blob decompressed with the same
 * bomb guard used at ingest, as a UTF-8 string (the export is JSON and binary columns
 * stay excluded by convention).
 *
 * Memory: every row — including each `logText` — stays referenced until the whole export
 * document is serialized, so decoding one blob at a time alone does NOT bound peak
 * memory. The total log text is capped at EXPORT_LOG_TEXT_MAX_BYTES (64 MiB); past it a
 * bundle is exported with `logText: null, logTextOmitted: 'size'`. Each decode also runs
 * inside the shared bundle decode slot (the same semaphore as ingest and the admin text
 * view), waiting up to 60 s — a still-busy slot yields `logTextError: 'busy'`.
 */
async function exportClientDiagnostics(
    sql: postgres.Sql,
    userId: string,
): Promise<TruncatedSection> {
    const [rows, countRows] = await Promise.all([
        sql<Record<string, unknown>[]>`
            SELECT cd.*, (b.id IS NOT NULL) AS has_blob
            FROM client_diagnostics cd
            LEFT JOIN client_diagnostic_blobs b ON b.diagnostic_id = cd.id
            WHERE cd.user_id = ${userId}::uuid
            ORDER BY cd.occurred_at DESC
            LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM client_diagnostics WHERE user_id = ${userId}::uuid
        `,
    ]);
    const cap = exportLogTextCap();
    let logTextBytes = 0;
    for (const row of rows) {
        if (!row.has_blob) continue;
        if (logTextBytes >= cap) {
            row.logText = null;
            row.logTextOmitted = 'size';
            continue;
        }
        let text: string | null;
        try {
            text = await withBundleSlot(async () => {
                const [blob] = await sql<{ content: Buffer }[]>`
                    SELECT content FROM client_diagnostic_blobs WHERE diagnostic_id = ${row.id as number}
                `;
                if (!blob) return null;
                const inflated = await inflateBounded(
                    blob.content,
                    EVENT_LIMITS.bundleInflatedBytes,
                    { keepText: true },
                );
                return inflated.text ?? '';
            }, EXPORT_SLOT_WAIT_MS);
        } catch (err) {
            row.logText = null;
            row.logTextError =
                err instanceof BundleBusyError ? 'busy' : 'bundle could not be decompressed';
            continue;
        }
        if (text === null) continue;
        const bytes = Buffer.byteLength(text, 'utf8');
        if (logTextBytes + bytes > cap) {
            row.logText = null;
            row.logTextOmitted = 'size';
            continue;
        }
        logTextBytes += bytes;
        row.logText = text;
    }
    return toSection(rows, parseInt(countRows[0]?.count ?? '0', 10));
}

// ---------------------------------------------------------------------------
// collectUserExport
// ---------------------------------------------------------------------------

/**
 * Collect all per-user data for a GDPR data-subject export.
 *
 * @param sql    - postgres.Sql connection (read-only queries)
 * @param username - The subject's username (login handle, lowercased)
 * @returns UserDataExport document, or null if the user does not exist.
 */
export async function collectUserExport(
    sql: postgres.Sql,
    username: string,
): Promise<UserDataExport | null> {
    const lowerUsername = username.toLowerCase();

    // ── 1. Resolve username → UUID
    const userRows = await sql<{ id: string }[]>`
        SELECT id FROM users WHERE LOWER(username) = ${lowerUsername} LIMIT 1
    `;
    if (!userRows[0]) return null;
    const userId = userRows[0].id as UserId;

    // ── 2. Collect all sections in parallel where possible
    const [
        accountRows,

        ratingRows,
        ratingCount,

        watchlistRows,
        watchlistCount,

        suggestionRows,
        suggestionCount,

        mediaStateRows,
        mediaStateCount,

        mediaEventsRows,
        mediaEventsCount,

        mediaEventsArchiveRows,
        mediaEventsArchiveCount,

        watchHistoryRows,
        watchHistoryCount,

        annotationRows,
        annotationCount,

        mediaFlagsRows,
        mediaFlagsCount,

        profileRows,
        profileCount,

        playbackPrefRows,
        playbackPrefCount,

        widgetOrderRows,
        widgetOrderCount,

        feedPrefRows,
        feedPrefCount,

        searchPrefRows,
        searchPrefCount,

        pinnedGenreRows,
        pinnedGenreCount,

        sectionFeedbackRows,
        sectionFeedbackCount,

        excludedSeriesRows,
        excludedSeriesCount,

        streamPolicyRows,
        streamPolicyCount,

        playlistRows,
        playlistCount,

        playlistViewRows,
        playlistViewCount,

        playlistMemberRows,
        playlistMemberCount,

        playlistItemWatchedRows,
        playlistItemWatchedCount,

        playlistItemsRows,
        playlistItemsCount,

        patRows,
        patCount,

        oauthRows,
        oauthCount,

        subsonicRows,
        subsonicCount,

        jellyfinPwRows,
        jellyfinPwCount,

        assistantRows,
        assistantCount,

        watchlistActivityRows,
        watchlistActivityCount,

        musicListenRows,
        musicListenCount,
        musicPlayStartRows,
        musicPlayStartCount,

        musicStateRows,
        musicStateCount,

        tasteDamperRows,
        tasteDamperCount,

        rateSkipRows,
        rateSkipCount,

        shareOptOutRows,
        shareOptOutCount,

        playSessionRows,
        playSessionCount,

        watchStateSyncRows,
        watchStateSyncCount,

        watchStatePullRows,
        watchStatePullCount,

        watchSyncActivityRows,
        watchSyncActivityCount,

        watchSyncPreferenceRows,
        watchSyncPreferenceCount,

        pluginCredentialRows,
        pluginCredentialCount,

        collabChatRows,
        collabChatCount,

        livetvWatchHistoryRows,
        livetvWatchHistoryCount,

        livetvFavoriteRows,
        livetvFavoriteCount,

        livetvSimpleModeRows,
        livetvSimpleModeCount,

        userLibraryPermRows,
        userLibraryPermCount,

        // Optional private-module tables — null when table does not exist
        userAccessGroupRows,
        userAccessGroupCount,

        trainingAssignmentRows,
        trainingAssignmentCount,

        userSessionRows,
        userSessionCount,

        providerDeviceTokenRows,
        providerDeviceTokenCount,
        userDeviceRows,
        userDeviceCount,
        deviceControlGrantRows,
        deviceControlGrantCount,

        oauthDeviceCodeRows,
        oauthDeviceCodeCount,

        // Optional private-module tables — null when table does not exist
        certificateRows,
        certificateCount,

        courseEnrollmentRows,
        courseEnrollmentCount,

        quizAttemptRows,
        quizAttemptCount,

        trainingAckRows,
        trainingAckCount,

        // user_notifications — durable inbox rows (FK → users.id ON DELETE CASCADE)
        userNotificationRows,
        userNotificationCount,

        // user_notification_webhooks — the subject's outbound endpoint (FK → users.id ON DELETE CASCADE)
        notificationWebhookRows,
        notificationWebhookCount,

        // generic comment/reaction primitive (FK → users.id ON DELETE CASCADE)
        interactionRows,
        interactionCount,

        interactionReactionRows,
        interactionReactionCount,

        // shoutbox_messages — plugin-owned table; null-safe (see below)
        shoutboxMessageRows,
        shoutboxMessageCount,

        // shoutbox_ai_invocations — plugin-owned table; null-safe (see below)
        shoutboxAiInvocationRows,
        shoutboxAiInvocationCount,

        // playback_incident_events — client-reported playback incidents
        playbackIncidentRows,
        playbackIncidentCount,

        // client_diagnostics — everything the subject's apps reported, with
        // log_bundle rows carrying their full decompressed logText. Its own
        // helper streams blobs one at a time rather than pairing with the
        // rows/count queries above; a single promise slot here, not a pair.
        clientDiagnosticsSection,

        // jellyfin_display_preferences — saved /j DisplayPreferences DTOs
        jellyfinDisplayPreferencesRows,
        jellyfinDisplayPreferencesCount,

        // network_speed_tests — client-timed download measurements
        networkSpeedTestRows,
        networkSpeedTestCount,
    ] = await Promise.all([
        // account — exclude avatar_data, password_hash, password_updated_at
        sql<NonNullable<UserDataExport['account']>[]>`
            SELECT id, username, is_admin, admin_pinned, max_age_rating, age_rating_pinned, allow_live_tv,
                   display_name, email, hide_streams, share_listening_activity,
                   share_audiobook_activity,
                   groups, groups_updated_at,
                   created_at, updated_at, last_seen_at, disabled_at
            FROM users
            WHERE id = ${userId}::uuid
            LIMIT 1
        `,

        // ratings
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_ratings WHERE user_id = ${userId}::uuid
            ORDER BY updated_at DESC NULLS LAST LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_ratings WHERE user_id = ${userId}::uuid`,

        // watchlist — the subject's watchlist playlist contents
        sql<Record<string, unknown>[]>`
            SELECT pi.*
            FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${userId}::uuid AND p.playlist_type = 'watchlist'
            ORDER BY pi.added_at DESC NULLS LAST
            LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${userId}::uuid AND p.playlist_type = 'watchlist'
        `,

        // suggestions
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_suggestions WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC NULLS LAST LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_suggestions WHERE user_id = ${userId}::uuid`,

        // media_state
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_media_state WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_media_state WHERE user_id = ${userId}::uuid`,

        // media_events (capped)
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_media_events WHERE user_id = ${userId}::uuid
            ORDER BY occurred_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_media_events WHERE user_id = ${userId}::uuid`,

        // media_events_archive (capped)
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_media_events_archive WHERE user_id = ${userId}::uuid
            ORDER BY occurred_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_media_events_archive WHERE user_id = ${userId}::uuid`,

        // watch_history (capped)
        sql<Record<string, unknown>[]>`
            SELECT * FROM watch_history WHERE user_id = ${userId}::uuid
            ORDER BY session_start_time DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM watch_history WHERE user_id = ${userId}::uuid`,

        // media_annotations
        sql<Record<string, unknown>[]>`
            SELECT * FROM media_annotations WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM media_annotations WHERE user_id = ${userId}::uuid`,

        // media_flags
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_media_flags WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_media_flags WHERE user_id = ${userId}::uuid`,

        // profiles — exclude catalog_embedding, request_embedding (raw vectors)
        sql<Record<string, unknown>[]>`
            SELECT user_id, availability_preference, quality_weight, popularity_weight,
                   recency_weight, preferences, total_ratings, last_activity,
                   created_at, updated_at
            FROM user_profiles WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_profiles WHERE user_id = ${userId}::uuid`,

        // playback_preferences
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_playback_preferences WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_playback_preferences WHERE user_id = ${userId}::uuid`,

        // widget_order
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_widget_order WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_widget_order WHERE user_id = ${userId}::uuid`,

        // feed_preferences (user_id is a UUID column)
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_feed_preferences WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_feed_preferences WHERE user_id = ${userId}::uuid`,

        // search_preferences
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_search_preferences WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_search_preferences WHERE user_id = ${userId}::uuid`,

        // pinned_genres
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_pinned_genres WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_pinned_genres WHERE user_id = ${userId}::uuid`,

        // section_feedback
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_section_feedback WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_section_feedback WHERE user_id = ${userId}::uuid`,

        // excluded_series — folded into user_media_flags (migration 16.108.0).
        // Export the synthetic ExcludedSeriesRow shape for continuity.
        sql<Record<string, unknown>[]>`
            SELECT
                id::text   AS id,
                user_id,
                CASE WHEN target_type = 'series_name' THEN target_id ELSE NULL END AS series_name,
                CASE WHEN target_type = 'series'      THEN target_id ELSE NULL END AS media_id,
                -- TMDB mutes (Sonarr/Radarr-only titles): 'tv:123' / 'movie:456'.
                CASE WHEN target_type IN ('tmdb_tv', 'tmdb_movie')
                     THEN split_part(target_id, ':', 2) ELSE NULL END AS tmdb_id,
                CASE target_type WHEN 'tmdb_tv' THEN 'tv' WHEN 'tmdb_movie' THEN 'movie'
                     ELSE NULL END AS tmdb_media_type,
                created_at AS excluded_at
            FROM user_media_flags
            WHERE user_id = ${userId}::uuid
              AND flag_type = 'series_excluded'
            LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM user_media_flags
            WHERE user_id = ${userId}::uuid
              AND flag_type = 'series_excluded'
        `,

        // stream_policy — TEXT key = username, EXCLUDE __default__ sentinel
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_stream_policies
            WHERE user_id = ${lowerUsername} AND user_id <> '__default__'
            LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM user_stream_policies
            WHERE user_id = ${lowerUsername} AND user_id <> '__default__'
        `,

        // playlists owned by user
        sql<Record<string, unknown>[]>`
            SELECT * FROM playlists WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM playlists WHERE user_id = ${userId}::uuid`,

        // playlist_view_state — user_id is UUID since migration 16.102.0
        sql<Record<string, unknown>[]>`
            SELECT * FROM playlist_view_state WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM playlist_view_state WHERE user_id = ${userId}::uuid`,

        // playlist_members
        sql<Record<string, unknown>[]>`
            SELECT * FROM playlist_members WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM playlist_members WHERE user_id = ${userId}::uuid`,

        // playlist_item_watched
        sql<Record<string, unknown>[]>`
            SELECT * FROM playlist_item_watched WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM playlist_item_watched WHERE user_id = ${userId}::uuid`,

        // playlist_items — every item in every playlist the subject owns
        sql<Record<string, unknown>[]>`
            SELECT pi.*
            FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${userId}::uuid
            ORDER BY pi.added_at DESC NULLS LAST
            LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM playlist_items pi
            JOIN playlists p ON p.id = pi.playlist_id
            WHERE p.user_id = ${userId}::uuid
        `,

        // personal_access_tokens — exclude token_hash; keep metadata only
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, token_prefix, name, description, scopes,
                   expires_at, created_at, last_used_at
            FROM personal_access_tokens WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM personal_access_tokens WHERE user_id = ${userId}::uuid`,

        // oauth_refresh_tokens — exclude token_hash; keep metadata only
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, client_id, scope, device_name, device_id,
                   expires_at, last_used_at, revoked_at
            FROM oauth_refresh_tokens WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM oauth_refresh_tokens WHERE user_id = ${userId}::uuid`,

        // subsonic_client_passwords — exclude token (the secret)
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, created_at, last_used_at
            FROM subsonic_client_passwords WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM subsonic_client_passwords WHERE user_id = ${userId}::uuid`,

        // jellyfin_client_passwords — exclude password_hash
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, created_at, last_used_at
            FROM jellyfin_client_passwords WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM jellyfin_client_passwords WHERE user_id = ${userId}::uuid`,

        // assistant_messages — exclude embedding_query vector (capped)
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, role, content, created_at
            FROM assistant_messages WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM assistant_messages WHERE user_id = ${userId}::uuid`,

        // watchlist_activities
        sql<Record<string, unknown>[]>`
            SELECT * FROM watchlist_activities WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM watchlist_activities WHERE user_id = ${userId}::uuid`,

        // music_listen_events (capped)
        sql<Record<string, unknown>[]>`
            SELECT * FROM music_listen_events WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM music_listen_events WHERE user_id = ${userId}::uuid`,

        // music_play_starts (capped): dedup claims for counted music starts
        sql<Record<string, unknown>[]>`
            SELECT * FROM music_play_starts WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM music_play_starts WHERE user_id = ${userId}::uuid`,

        // user_music_state
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_music_state WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_music_state WHERE user_id = ${userId}::uuid`,

        // user_taste_dampers — exclude raw embedding vector
        sql<Record<string, unknown>[]>`
            SELECT user_id, media_id, media_type, expires_at, created_at
            FROM user_taste_dampers WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_taste_dampers WHERE user_id = ${userId}::uuid`,

        // user_rate_skips — /rate swipe-trainer skips (FK → users.id ON DELETE CASCADE)
        sql<Record<string, unknown>[]>`
            SELECT user_id, media_id, skipped_at
            FROM user_rate_skips WHERE user_id = ${userId}::uuid
            ORDER BY skipped_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_rate_skips WHERE user_id = ${userId}::uuid`,

        // user_media_share_opt_out — titles the subject suppressed from their
        // social trust circle (migration 16.180.0; FK → users.id ON DELETE CASCADE).
        // Which books someone chose NOT to be seen reading is a statement about
        // their reading, so it belongs in an Art. 15 export.
        sql<Record<string, unknown>[]>`
            SELECT user_id, media_id, created_at
            FROM user_media_share_opt_out WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_media_share_opt_out WHERE user_id = ${userId}::uuid`,

        // play_sessions — primary viewing session log (capped); FK → users.id ON DELETE CASCADE
        sql<Record<string, unknown>[]>`
            SELECT id, media_id, user_id, device_id, user_agent, client_name, client_version,
                   play_method, transcode_mode, audio_codec, video_codec, container,
                   bitrate_kbps, resolution, status, stop_reason, position_ms, runtime_ms,
                   started_at, last_heartbeat_at, paused_at, stopped_at,
                   audio_language, subtitle_language, source, last_seen_at
            FROM play_sessions WHERE user_id = ${userId}::uuid
            ORDER BY started_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM play_sessions WHERE user_id = ${userId}::uuid`,

        // watch_state_sync_log — per-user watch-sync history (capped)
        sql<Record<string, unknown>[]>`
            SELECT * FROM watch_state_sync_log WHERE user_id = ${userId}::uuid
            ORDER BY synced_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM watch_state_sync_log WHERE user_id = ${userId}::uuid`,

        // watch_state_pull_log — per-provider pull log
        sql<Record<string, unknown>[]>`
            SELECT * FROM watch_state_pull_log WHERE user_id = ${userId}::uuid
            ORDER BY last_pulled_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM watch_state_pull_log WHERE user_id = ${userId}::uuid`,

        // watch_sync_activity — per-connection sync activity feed (capped)
        sql<Record<string, unknown>[]>`
            SELECT * FROM watch_sync_activity WHERE user_id = ${userId}::uuid
            ORDER BY id DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM watch_sync_activity WHERE user_id = ${userId}::uuid`,

        // watch_sync_preferences — per-provider direction preference + push watermark
        sql<Record<string, unknown>[]>`
            SELECT * FROM watch_sync_preferences WHERE user_id = ${userId}::uuid
            ORDER BY provider LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM watch_sync_preferences WHERE user_id = ${userId}::uuid`,

        // plugin_user_credentials — metadata only; value_encrypted excluded
        sql<Record<string, unknown>[]>`
            SELECT plugin_id, user_id, key, encryption_version, expires_at, created_at, last_accessed_at
            FROM plugin_user_credentials WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM plugin_user_credentials WHERE user_id = ${userId}::uuid`,

        // collaborative_chat_messages (capped)
        sql<Record<string, unknown>[]>`
            SELECT id, context_type, context_id, user_id, message, created_at, deleted_at, message_type
            FROM collaborative_chat_messages WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM collaborative_chat_messages WHERE user_id = ${userId}::uuid`,

        // livetv_channel_watch_history
        sql<Record<string, unknown>[]>`
            SELECT * FROM livetv_channel_watch_history WHERE user_id = ${userId}::uuid
            ORDER BY watched_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM livetv_channel_watch_history WHERE user_id = ${userId}::uuid`,

        // livetv_channel_favorites
        sql<Record<string, unknown>[]>`
            SELECT * FROM livetv_channel_favorites WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM livetv_channel_favorites WHERE user_id = ${userId}::uuid`,

        // livetv_simple_mode — one row; pin_hash left out (a secret, not personal data)
        sql<Record<string, unknown>[]>`
            SELECT user_id, enabled, layout, text_size, start_channel_id, autostart,
                   locked, updated_by, updated_at
              FROM livetv_simple_mode WHERE user_id = ${userId}::uuid
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM livetv_simple_mode WHERE user_id = ${userId}::uuid`,

        // user_library_permissions — library access config
        sql<Record<string, unknown>[]>`
            SELECT * FROM user_library_permissions WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_library_permissions WHERE user_id = ${userId}::uuid`,

        // user_access_groups — access group memberships (optional private-module table)
        sql<Record<string, unknown>[]>`
            SELECT user_id, group_id, assigned_at
            FROM user_access_groups WHERE user_id = ${userId}::uuid LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_access_groups WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // training_assignments — assignments targeting this user as the learner (optional private-module table)
        // assigned_by (the admin actor) is excluded; only the subject's own assignment data is exported.
        sql<Record<string, unknown>[]>`
            SELECT id, title, item_kind, media_id, playlist_id, required, require_ack,
                   due_at, created_at, archived_at
            FROM training_assignments WHERE target_user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM training_assignments WHERE target_user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // user_sessions — session metadata; EXCLUDE token_hash (cryptographic secret).
        // ip IS included: it is personal data under GDPR Recital 30 / ECJ C-582/14
        // and the data subject is entitled to it under Art. 15.
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, created_at, expires_at, last_used_at, revoked_at,
                   ip, user_agent, oidc_iss, oidc_sub, oidc_sid
            FROM user_sessions WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_sessions WHERE user_id = ${userId}::uuid`,

        // user_provider_device_tokens — Jellyfin device token metadata; EXCLUDE provider_access_token
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, provider_user_id, device_session_id,
                   provider_device_binding, device_id, created_at, last_used_at, revoked_at
            FROM user_provider_device_tokens WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_provider_device_tokens WHERE user_id = ${userId}::uuid`,

        // user_devices — the device registry. Display names are personal data:
        // "Wohnzimmer" discloses a room in the subject's home.
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, device_id, reported_name, custom_name,
                   device_type, client_id, first_seen_at, last_seen_at
            FROM user_devices WHERE user_id = ${userId}::uuid
            ORDER BY last_seen_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_devices WHERE user_id = ${userId}::uuid`,

        // device_control_grants — remote-control grants the subject gave or received.
        sql<Record<string, unknown>[]>`
            SELECT owner_user_id, grantee_user_id, created_at
            FROM device_control_grants
            WHERE owner_user_id = ${userId}::uuid OR grantee_user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM device_control_grants
            WHERE owner_user_id = ${userId}::uuid OR grantee_user_id = ${userId}::uuid
        `,

        // oauth_device_codes — device-flow authorization records; EXCLUDE device_code / user_code (OAuth secrets)
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, client_id, device_name, scope, status,
                   device_id, device_session_id, verification_uri,
                   last_poll_at, created_at, expires_at
            FROM oauth_device_codes WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM oauth_device_codes WHERE user_id = ${userId}::uuid`,

        // certificates — optional private-module table; empty section when table absent
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, course_id, enrollment_id, serial, issued_at, revoked_at
            FROM certificates WHERE user_id = ${userId}::uuid
            ORDER BY issued_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM certificates WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // course_enrollments — optional private-module table
        sql<Record<string, unknown>[]>`
            SELECT * FROM course_enrollments WHERE user_id = ${userId}::uuid
            ORDER BY enrolled_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM course_enrollments WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // quiz_attempts — optional private-module table (answers jsonb is personal data — include it)
        sql<Record<string, unknown>[]>`
            SELECT id, quiz_id, user_id, enrollment_id, started_at, submitted_at,
                   score, passed, attempt_number, answers
            FROM quiz_attempts WHERE user_id = ${userId}::uuid
            ORDER BY started_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM quiz_attempts WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // training_acknowledgements — optional private-module table
        sql<Record<string, unknown>[]>`
            SELECT * FROM training_acknowledgements WHERE user_id = ${userId}::uuid
            ORDER BY acknowledged_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM training_acknowledgements WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // user_notifications — durable inbox (capped); all columns are personal data
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, kind, payload, read_at, created_at, expires_at
            FROM user_notifications WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_notifications WHERE user_id = ${userId}::uuid`,

        // user_notification_webhooks — the endpoint the subject configured for
        // themselves. The URL is personal data (it can name their own host, or
        // carry a provider topic id that acts as a bearer for their feed), so it
        // is exported; EXCLUDE secret_encrypted, the HMAC signing key.
        sql<Record<string, unknown>[]>`
            SELECT id, user_id, url, created_at, updated_at
            FROM user_notification_webhooks WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM user_notification_webhooks WHERE user_id = ${userId}::uuid`,

        // interactions — polymorphic comment store; exclude soft-deleted rows by default
        sql<Record<string, unknown>[]>`
            SELECT id, target_type, target_id, user_id, body, created_at, updated_at, deleted_at
            FROM interactions WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM interactions WHERE user_id = ${userId}::uuid`,

        // interaction_reactions — per-target emoji reactions
        sql<Record<string, unknown>[]>`
            SELECT id, target_type, target_id, user_id, emoji, created_at
            FROM interaction_reactions WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM interaction_reactions WHERE user_id = ${userId}::uuid`,

        // shoutbox_messages — plugin-owned table (plugins/shoutbox), created by
        // the plugin's own ensureSchema (commit 213502df6), NOT a host migration.
        // It may therefore not exist on installs where the shoutbox plugin has
        // never loaded. Guarded exactly like the optional private-module tables
        // above: any query error (including "relation does not exist") degrades
        // to an empty section instead of failing the whole export. No secret
        // columns exist on this table, so every non-linkage column is exported;
        // deleted_at is included (not filtered) so a soft-deleted message the
        // subject wrote still appears in their own export.
        sql<Record<string, unknown>[]>`
            SELECT id, username, user_group, author_kind, reply_to, body, created_at, deleted_at
            FROM shoutbox_messages WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM shoutbox_messages WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // shoutbox_ai_invocations — plugin-owned table (plugins/shoutbox), created
        // by the plugin's own ensureSchema, NOT a host migration, so it may not
        // exist on installs where the shoutbox has never loaded. Guarded with the
        // same .catch degradation as shoutbox_messages above. The whole row is
        // three columns (id, user_id, created_at); user_id is the subject's own id
        // and is dropped as pure linkage, leaving the timestamp that is the actual
        // disclosure — when they invoked the bot.
        sql<Record<string, unknown>[]>`
            SELECT id, created_at
            FROM shoutbox_ai_invocations WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `.catch(() => [] as Record<string, unknown>[]),
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM shoutbox_ai_invocations WHERE user_id = ${userId}::uuid`.catch(
            () => [{ count: '0' }] as { count: string }[],
        ),

        // playback_incident_events — timeline/client_info/message are already
        // redacted at write time (playback-incident.service.ts), so the raw row
        // is safe to export as-is; no column exclusions needed here.
        sql<Record<string, unknown>[]>`
            SELECT * FROM playback_incident_events WHERE user_id = ${userId}::uuid
            ORDER BY occurred_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM playback_incident_events WHERE user_id = ${userId}::uuid`,

        // client_diagnostics — everything the subject's apps reported (playback incidents,
        // crashes, errors, API failure counts, log bundles). Payloads are redacted at write
        // time. Log bundles are exported with their FULL log text (decompressed, bounded),
        // one bundle at a time so peak memory stays at one bundle.
        exportClientDiagnostics(sql, userId),

        // jellyfin_display_preferences — data is an opaque pass-through JSONB
        // blob (see the migration's own comment); exported as-is, no column
        // exclusions needed.
        sql<Record<string, unknown>[]>`
            SELECT * FROM jellyfin_display_preferences WHERE user_id = ${userId}::uuid
            ORDER BY updated_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM jellyfin_display_preferences WHERE user_id = ${userId}::uuid`,

        // network_speed_tests — the whole row, mirroring playback_incident_events
        // one block above: device_id, client_info and the per-bucket series are
        // all the subject's own data, and Art. 15 is about showing them what is
        // held, not about holding some of it back. A column the erasure path
        // scrubs is still a column the subject is entitled to SEE while it
        // exists.
        sql<Record<string, unknown>[]>`
            SELECT * FROM network_speed_tests WHERE user_id = ${userId}::uuid
            ORDER BY created_at DESC LIMIT ${PER_TABLE_LIMIT}
        `,
        sql<
            { count: string }[]
        >`SELECT COUNT(*)::text AS count FROM network_speed_tests WHERE user_id = ${userId}::uuid`,
    ]);

    const syncRows = await sql<Record<string, unknown>[]>`
        SELECT xid::text, seq::text, kind, entity_id, recorded_at FROM sync_changes
        WHERE user_id = ${userId}::uuid ORDER BY xid, seq LIMIT ${PER_TABLE_LIMIT}
    `;
    const [syncCount] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM sync_changes WHERE user_id = ${userId}::uuid
    `;

    // ── 3. Assemble the export document
    const account = accountRows[0] ?? undefined;

    const countOf = (rows: { count: string }[]) => parseInt(rows[0]?.count ?? '0', 10);

    return {
        sync_changes: toSection(syncRows, Number(syncCount.count)),
        version: 1,
        exported_at: new Date().toISOString(),
        subject_username: username,

        account,

        ratings: toSection(ratingRows, countOf(ratingCount)),
        watchlist: toSection(watchlistRows, countOf(watchlistCount)),
        suggestions: toSection(suggestionRows, countOf(suggestionCount)),

        media_state: toSection(mediaStateRows, countOf(mediaStateCount)),
        media_events: toSection(mediaEventsRows, countOf(mediaEventsCount)),
        media_events_archive: toSection(mediaEventsArchiveRows, countOf(mediaEventsArchiveCount)),
        watch_history: toSection(watchHistoryRows, countOf(watchHistoryCount)),

        media_annotations: toSection(annotationRows, countOf(annotationCount)),
        media_flags: toSection(mediaFlagsRows, countOf(mediaFlagsCount)),

        profiles: toSection(profileRows, countOf(profileCount)),
        playback_preferences: toSection(playbackPrefRows, countOf(playbackPrefCount)),
        widget_order: toSection(widgetOrderRows, countOf(widgetOrderCount)),
        feed_preferences: toSection(feedPrefRows, countOf(feedPrefCount)),
        search_preferences: toSection(searchPrefRows, countOf(searchPrefCount)),
        pinned_genres: toSection(pinnedGenreRows, countOf(pinnedGenreCount)),
        section_feedback: toSection(sectionFeedbackRows, countOf(sectionFeedbackCount)),
        excluded_series: toSection(excludedSeriesRows, countOf(excludedSeriesCount)),

        stream_policy: toSection(streamPolicyRows, countOf(streamPolicyCount)),

        playlists: toSection(playlistRows, countOf(playlistCount)),
        playlist_view_state: toSection(playlistViewRows, countOf(playlistViewCount)),
        playlist_members: toSection(playlistMemberRows, countOf(playlistMemberCount)),
        playlist_item_watched: toSection(
            playlistItemWatchedRows,
            countOf(playlistItemWatchedCount),
        ),
        playlist_items: toSection(playlistItemsRows, countOf(playlistItemsCount)),

        personal_access_tokens: toSection(patRows, countOf(patCount)),
        oauth_refresh_tokens: toSection(oauthRows, countOf(oauthCount)),
        subsonic_passwords: toSection(subsonicRows, countOf(subsonicCount)),
        jellyfin_passwords: toSection(jellyfinPwRows, countOf(jellyfinPwCount)),

        assistant_messages: toSection(assistantRows, countOf(assistantCount)),

        watchlist_activities: toSection(watchlistActivityRows, countOf(watchlistActivityCount)),

        music_listen_events: toSection(musicListenRows, countOf(musicListenCount)),
        music_play_starts: toSection(musicPlayStartRows, countOf(musicPlayStartCount)),
        user_music_state: toSection(musicStateRows, countOf(musicStateCount)),

        taste_dampers: toSection(tasteDamperRows, countOf(tasteDamperCount)),
        rate_skips: toSection(rateSkipRows, countOf(rateSkipCount)),
        media_share_opt_out: toSection(shareOptOutRows, countOf(shareOptOutCount)),

        play_sessions: toSection(playSessionRows, countOf(playSessionCount)),
        watch_state_sync_log: toSection(watchStateSyncRows, countOf(watchStateSyncCount)),
        watch_state_pull_log: toSection(watchStatePullRows, countOf(watchStatePullCount)),
        watch_sync_activity: toSection(watchSyncActivityRows, countOf(watchSyncActivityCount)),
        watch_sync_preferences: toSection(
            watchSyncPreferenceRows,
            countOf(watchSyncPreferenceCount),
        ),
        plugin_credentials: toSection(pluginCredentialRows, countOf(pluginCredentialCount)),
        collaborative_chat_messages: toSection(collabChatRows, countOf(collabChatCount)),
        livetv_watch_history: toSection(livetvWatchHistoryRows, countOf(livetvWatchHistoryCount)),
        livetv_favorites: toSection(livetvFavoriteRows, countOf(livetvFavoriteCount)),
        livetv_simple_mode: toSection(livetvSimpleModeRows, countOf(livetvSimpleModeCount)),
        user_library_permissions: toSection(userLibraryPermRows, countOf(userLibraryPermCount)),

        user_access_groups: toSection(userAccessGroupRows, countOf(userAccessGroupCount)),
        training_assignments: toSection(trainingAssignmentRows, countOf(trainingAssignmentCount)),

        user_sessions: toSection(userSessionRows, countOf(userSessionCount)),
        provider_device_tokens: toSection(
            providerDeviceTokenRows,
            countOf(providerDeviceTokenCount),
        ),
        user_devices: toSection(userDeviceRows, countOf(userDeviceCount)),
        device_control_grants: toSection(deviceControlGrantRows, countOf(deviceControlGrantCount)),
        oauth_device_codes: toSection(oauthDeviceCodeRows, countOf(oauthDeviceCodeCount)),

        certificates: toSection(certificateRows, countOf(certificateCount)),
        course_enrollments: toSection(courseEnrollmentRows, countOf(courseEnrollmentCount)),
        quiz_attempts: toSection(quizAttemptRows, countOf(quizAttemptCount)),
        training_acknowledgements: toSection(trainingAckRows, countOf(trainingAckCount)),

        notifications: toSection(userNotificationRows, countOf(userNotificationCount)),
        notification_webhooks: toSection(
            notificationWebhookRows,
            countOf(notificationWebhookCount),
        ),

        interactions: toSection(interactionRows, countOf(interactionCount)),
        interaction_reactions: toSection(
            interactionReactionRows,
            countOf(interactionReactionCount),
        ),

        shoutbox_messages: toSection(shoutboxMessageRows, countOf(shoutboxMessageCount)),

        shoutbox_ai_invocations: toSection(
            shoutboxAiInvocationRows,
            countOf(shoutboxAiInvocationCount),
        ),

        playback_incident_events: toSection(playbackIncidentRows, countOf(playbackIncidentCount)),

        client_diagnostics: clientDiagnosticsSection,

        jellyfin_display_preferences: toSection(
            jellyfinDisplayPreferencesRows,
            countOf(jellyfinDisplayPreferencesCount),
        ),

        network_speed_tests: toSection(networkSpeedTestRows, countOf(networkSpeedTestCount)),
    };
}
