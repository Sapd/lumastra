// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GDPR Data Subject Schemas
 *
 * Zod schemas for GDPR Art. 15 (right of access / portability) export.
 * SINGLE SOURCE OF TRUTH — run `npm run openapi:generate` after changes.
 *
 * Conventions:
 * - Use .optional() (Swift compat); .nullable() only when DB truly returns null.
 * - Sensitive columns (password_hash, avatar_data, token secrets) are excluded.
 * - Raw embedding vectors are excluded (large + not meaningful to a subject).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-table section schemas
// ---------------------------------------------------------------------------

const UserAccountSchema = z
    .object({
        id: z.string().guid().describe('Internal UUID'),
        username: z.string().describe('Login handle'),
        is_admin: z.boolean().describe('Admin flag'),
        allow_live_tv: z
            .boolean()
            .nullable()
            .optional()
            .describe('Live TV switch (null = default allowed)'),
        display_name: z.string().nullable().optional().describe('Display name'),
        email: z.string().nullable().optional().describe('Email address'),
        hide_streams: z.boolean().optional().describe('Hide-streams flag'),
        share_listening_activity: z
            .boolean()
            .optional()
            .describe('Sharing switch for the coarse-grained listening activity tier'),
        share_audiobook_activity: z
            .boolean()
            .optional()
            .describe('Audiobook-wide social sharing switch'),
        groups: z.array(z.string()).nullable().optional().describe('IdP group memberships'),
        created_at: z.string().describe('Account created timestamp'),
        updated_at: z.string().describe('Account last updated timestamp'),
        last_seen_at: z.string().nullable().optional().describe('Last seen timestamp'),
        disabled_at: z.string().nullable().optional().describe('Disabled-at timestamp'),
    })
    .describe(
        'Core account data. Excludes: avatar_data (bytea), password_hash, password_updated_at.',
    );

const TruncatedSectionSchema = z.object({
    rows: z.array(z.record(z.string(), z.unknown())).describe('Rows in this section'),
    truncated: z.boolean().describe('True when the row count hit the per-table cap'),
    total_count: z.number().int().describe('Total rows before any cap'),
});

// ---------------------------------------------------------------------------
// Main export schema
// ---------------------------------------------------------------------------

export const UserDataExportSchema = z
    .object({
        /** Format version — increment when shape changes */
        version: z.literal(1).describe('Export format version'),
        exported_at: z.string().describe('ISO timestamp of export generation'),
        subject_username: z.string().describe('Username of the data subject'),

        // ── Core account
        account: UserAccountSchema.optional().describe('Core users row'),

        // ── Ratings, watchlist, suggestions
        ratings: TruncatedSectionSchema.describe('user_ratings rows'),
        watchlist: TruncatedSectionSchema.describe(
            "playlist_items rows for the subject's playlist_type = 'watchlist' playlist (migration 16.259.0; formerly user_watchlist rows)",
        ),
        suggestions: TruncatedSectionSchema.describe('user_suggestions rows'),

        // ── Watch state and history
        media_state: TruncatedSectionSchema.describe('user_media_state rows'),
        media_events: TruncatedSectionSchema.describe(
            'user_media_events rows (recent; capped at 10k)',
        ),
        media_events_archive: TruncatedSectionSchema.describe(
            'user_media_events_archive rows (capped at 10k)',
        ),
        watch_history: TruncatedSectionSchema.describe('watch_history rows (capped at 10k)'),

        // ── Annotations and flags
        media_annotations: TruncatedSectionSchema.describe('media_annotations rows'),
        media_flags: TruncatedSectionSchema.describe('user_media_flags rows'),

        // ── Profile and preferences
        profiles: TruncatedSectionSchema.describe(
            'user_profiles rows. Excludes raw embedding vector.',
        ),
        playback_preferences: TruncatedSectionSchema.describe('user_playback_preferences rows'),
        widget_order: TruncatedSectionSchema.describe('user_widget_order rows'),
        feed_preferences: TruncatedSectionSchema.describe('user_feed_preferences rows'),
        search_preferences: TruncatedSectionSchema.describe('user_search_preferences rows'),
        pinned_genres: TruncatedSectionSchema.describe('user_pinned_genres rows'),
        section_feedback: TruncatedSectionSchema.describe('user_section_feedback rows'),
        excluded_series: TruncatedSectionSchema.describe(
            'user_media_flags rows with flag_type=series_excluded (formerly user_excluded_series, folded in migration 16.108.0)',
        ),

        // ── Stream policy (TEXT-keyed)
        stream_policy: TruncatedSectionSchema.describe(
            'user_stream_policies rows (keyed by username; excludes __default__ sentinel)',
        ),

        // ── Playlists (owned)
        playlists: TruncatedSectionSchema.describe('playlists rows where owner_id = subject'),
        playlist_view_state: TruncatedSectionSchema.describe(
            'playlist_view_state rows (TEXT-keyed)',
        ),
        playlist_members: TruncatedSectionSchema.describe('playlist_members rows'),
        playlist_item_watched: TruncatedSectionSchema.describe('playlist_item_watched rows'),
        playlist_items: TruncatedSectionSchema.describe(
            'playlist_items rows for every playlist the subject owns, including their watchlist. ' +
                "The watchlist's rows are also listed separately under the `watchlist` section above — " +
                'the same data appears in both places, once per playlist (this one) and once filtered ' +
                'to the watchlist specifically (that one).',
        ),

        // ── Auth / tokens (existence + metadata only — no secret material)
        personal_access_tokens: TruncatedSectionSchema.describe(
            'personal_access_tokens metadata (label, created_at, last_used_at). Excludes token/secret.',
        ),
        oauth_refresh_tokens: TruncatedSectionSchema.describe(
            'oauth_refresh_tokens metadata (client_id, scope, created_at). Excludes refresh_token.',
        ),
        subsonic_passwords: TruncatedSectionSchema.describe(
            'subsonic_client_passwords metadata (client, created_at). Excludes password_hash.',
        ),
        jellyfin_passwords: TruncatedSectionSchema.describe(
            'jellyfin_client_passwords metadata (device, created_at). Excludes password_hash.',
        ),

        // ── AI assistant messages
        assistant_messages: TruncatedSectionSchema.describe(
            'assistant_messages rows (capped at 10k). Excludes raw embedding_query vector.',
        ),

        // ── Watchlist activities
        watchlist_activities: TruncatedSectionSchema.describe('watchlist_activities rows'),

        // ── Music
        music_listen_events: TruncatedSectionSchema.describe(
            'music_listen_events rows (capped at 10k)',
        ),
        music_play_starts: TruncatedSectionSchema.describe(
            'music_play_starts rows (capped at 10k)',
        ),
        user_music_state: TruncatedSectionSchema.describe('user_music_state rows'),

        // ── Suggestion (taste-related)
        taste_dampers: TruncatedSectionSchema.describe('user_taste_dampers rows'),
        rate_skips: TruncatedSectionSchema.describe(
            'user_rate_skips rows — items the subject skipped in the /rate swipe trainer (media_id, skipped_at).',
        ),
        media_share_opt_out: TruncatedSectionSchema.describe(
            'user_media_share_opt_out rows — titles the subject suppressed from their social trust circle (media_id, created_at).',
        ),

        // ── Viewing session log
        play_sessions: TruncatedSectionSchema.describe(
            'play_sessions rows (capped at 10k). Excludes ip_address, jellyfin_session_id, device_capabilities, external_payload.',
        ),

        // ── Watch-sync history
        watch_state_sync_log: TruncatedSectionSchema.describe(
            'watch_state_sync_log rows — per-user watch-sync history keyed by (user_id, media_id, provider, direction). Capped at 10k.',
        ),
        watch_state_pull_log: TruncatedSectionSchema.describe(
            'watch_state_pull_log rows — per-provider pull log (last_pulled_at, resolved/skipped/error counts).',
        ),
        watch_sync_activity: TruncatedSectionSchema.describe(
            'watch_sync_activity rows — per-connection sync activity feed (capped).',
        ),
        watch_sync_preferences: TruncatedSectionSchema.describe(
            'watch_sync_preferences rows — per-provider sync direction preference (both/pull/push) and push watermark.',
        ),

        // ── Plugin credentials (metadata only — encrypted value excluded)
        plugin_credentials: TruncatedSectionSchema.describe(
            'plugin_user_credentials metadata (plugin_id, key, created_at, last_accessed_at). Excludes value_encrypted.',
        ),

        // ── Generic comments and reactions (interactions primitive)
        interactions: TruncatedSectionSchema.describe(
            'interactions rows — polymorphic comment store (target_type, target_id, body). Capped at 10k.',
        ),
        interaction_reactions: TruncatedSectionSchema.describe(
            'interaction_reactions rows — per-target emoji reactions (target_type, target_id, emoji). Capped at 10k.',
        ),

        // ── Collaborative chat messages
        collaborative_chat_messages: TruncatedSectionSchema.describe(
            'collaborative_chat_messages rows (capped at 10k)',
        ),

        // ── LiveTV channel watch history
        livetv_watch_history: TruncatedSectionSchema.describe(
            'livetv_channel_watch_history rows (capped at 10k)',
        ),

        // ── LiveTV channel favorites
        livetv_favorites: TruncatedSectionSchema.describe(
            'livetv_channel_favorites rows — channels the user pinned as favorites',
        ),

        // ── LiveTV simple mode
        livetv_simple_mode: TruncatedSectionSchema.describe(
            'livetv_simple_mode row — the Live TV simple mode setup (lock PIN not included)',
        ),

        // ── User library permissions (admin-managed access config)
        user_library_permissions: TruncatedSectionSchema.describe(
            'user_library_permissions rows — library access configuration assigned to the user',
        ),

        // ── Session tokens (metadata only — no secret material)
        user_sessions: TruncatedSectionSchema.describe(
            'user_sessions metadata (created_at, expires_at, user_agent, oidc claims). Excludes token_hash and ip.',
        ),

        // ── Jellyfin/provider device tokens (metadata only)
        provider_device_tokens: TruncatedSectionSchema.describe(
            'user_provider_device_tokens metadata (provider_device_binding, device_id, created_at, last_used_at). Excludes provider_access_token.',
        ),

        // ── Device registry — display names are personal data
        user_devices: TruncatedSectionSchema.describe(
            'user_devices registry (device_id, reported_name, custom_name, device_type, client_id, first_seen_at, last_seen_at). Device names such as "Wohnzimmer" can disclose details of the subject\'s home.',
        ),
        device_control_grants: TruncatedSectionSchema.describe(
            'Household remote-control grants the subject gave or received (owner_user_id, grantee_user_id, created_at).',
        ),

        // ── OAuth device-flow authorization records (metadata only — no OAuth secrets)
        oauth_device_codes: TruncatedSectionSchema.describe(
            'oauth_device_codes metadata (client_id, scope, status, created_at, expires_at). Excludes device_code and user_code.',
        ),

        // ── Access group memberships (optional — empty section on non-enterprise installs)
        user_access_groups: TruncatedSectionSchema.describe(
            'user_access_groups rows — access group memberships (group_id, assigned_at).',
        ),

        // ── Training assignments targeting this user as the learner (optional)
        training_assignments: TruncatedSectionSchema.describe(
            'training_assignments rows where the subject is the target learner (title, item_kind, required, due_at). Excludes assigned_by (admin actor column).',
        ),

        // ── Notification inbox (durable inbox rows; capped at 10k)
        notifications: TruncatedSectionSchema.describe(
            'user_notifications rows — durable notification inbox (kind, payload, read_at, created_at, expires_at). Capped at 10k.',
        ),

        // ── Per-user outbound notification endpoint (metadata + URL; no secret)
        notification_webhooks: TruncatedSectionSchema.describe(
            "user_notification_webhooks rows — the outbound notification endpoint the subject configured (url, created_at, updated_at). The URL is the subject's own personal data (it can name their host or carry a provider topic id). Excludes secret_encrypted.",
        ),

        // ── Enterprise assessment (optional — empty section on non-enterprise installs)
        certificates: TruncatedSectionSchema.describe(
            'certificates rows — issued course completion certificates (serial, issued_at, revoked_at).',
        ),
        course_enrollments: TruncatedSectionSchema.describe(
            'course_enrollments rows — per-user course enrollment and completion status.',
        ),
        quiz_attempts: TruncatedSectionSchema.describe(
            'quiz_attempts rows — scored quiz attempts including answers jsonb (score, passed, attempt_number, answers).',
        ),
        training_acknowledgements: TruncatedSectionSchema.describe(
            'training_acknowledgements rows — explicit training acknowledgement records.',
        ),

        // ── Public shoutbox chat messages (plugin-owned table; optional — empty
        // section on installs where the shoutbox plugin has never run)
        shoutbox_messages: TruncatedSectionSchema.describe(
            'shoutbox_messages rows the subject authored (id, username, user_group, author_kind, reply_to, body, created_at, deleted_at). Plugin-owned table (plugins/shoutbox) — empty section if the table does not exist on this install.',
        ),

        // ── Shoutbox AI invocations (plugin-owned table; optional — empty
        // section on installs where the shoutbox plugin has never run)
        shoutbox_ai_invocations: TruncatedSectionSchema.describe(
            'shoutbox_ai_invocations rows recording each time the subject triggered an AI reply in the shoutbox (id, created_at). Backs the per-user hourly AI rate limit and is pruned to a short retention window (hours, not history), so this section is the recent tail rather than a complete record; user_id is omitted as pure linkage to the subject themselves. Plugin-owned table (plugins/shoutbox) — empty section if the table does not exist on this install.',
        ),

        // ── Client-reported playback incident forensic log (migration 16.210.0)
        playback_incident_events: TruncatedSectionSchema.describe(
            'playback_incident_events rows — client-reported playback errors, reconnects and terminal failures (trigger_type, error_type, stage, http_status, server_diagnostic_code, reconnect_cause, message, device_id, media_id, timeline, client_info, resolved_at). message/timeline/client_info are already redacted at write time.',
        ),

        // ── Client-reported diagnostics store (migration 16.268.0)
        client_diagnostics: TruncatedSectionSchema.describe(
            "client_diagnostics rows — everything the subject's apps reported: playback incidents, crashes, hangs, JavaScript errors, API failure counts, log bundles and server-detected client-compatibility incidents (kind, platform, app/os version, device model, device_id, play_session_id, occurred_at, received_at, summary, payload). Log bundles include logText: the full decompressed log the user sent.",
        ),

        // ── Client-timed network speed tests (migrations 16.248.0 + 16.249.0)
        network_speed_tests: TruncatedSectionSchema.describe(
            "network_speed_tests rows — speed measurements the subject's own client timed and reported (mode, bytes_requested, bytes_received, duration_ms, ttfb_ms, throughput_bps, min_bucket_bps, stall_ms, request_count, max_ttfb_ms, min_request_bps, gap_ms, requests, aborted, device_id, client_info, buckets, created_at). The full row, mirroring playback_incident_events: the reporting device and the per-bucket/per-request series are the subject's own data, so nothing is withheld.",
        ),

        sync_changes: TruncatedSectionSchema.describe('Recent per-user library sync change keys.'),

        // ── /j DisplayPreferences persistence (migration 16.207.0)
        jellyfin_display_preferences: TruncatedSectionSchema.describe(
            'jellyfin_display_preferences rows — saved DisplayPreferences DTOs for the /j Jellyfin-compat layer (display_prefs_id, client, data, created_at, updated_at). data is an opaque JSONB blob a client last POSTed to personalize their homepage/library-view layout.',
        ),
    })
    .meta({
        id: 'UserDataExport',
        description: 'GDPR Art. 15 data-subject export for one user.',
    });

export type UserDataExport = z.infer<typeof UserDataExportSchema>;
export type TruncatedSection = z.infer<typeof TruncatedSectionSchema>;
