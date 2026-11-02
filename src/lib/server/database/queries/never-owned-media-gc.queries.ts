// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Never-owned media GC: SQL for removing catalog rows that never had local
 * media and that nothing references (TMDB discovery sweep rows, migration
 * carry-overs, orphan stubs and the skeleton seasons/episodes under them).
 *
 * A GC UNIT is a root plus every row the root owns:
 *   - movie   — the movie and its extras
 *   - series  — the series with its seasons, episodes and extras
 *
 * A root is never-owned: an active top-level movie or series without files
 * and without any of the "formerly available" stamps the retention policy
 * keys on. Every unit member must pass every keep rule
 * ({@link NEVER_OWNED_KEEP_RULES}); one protected member keeps the whole
 * unit. Admin-only maintenance: these queries consider every library and
 * never serve user browse results.
 *
 * `scripts/sql/never-owned-media-gc-preview.sql` restates these rules as
 * plain read-only SQL for psql; an integration test runs it against the same
 * fixtures and requires identical counts.
 */

import type postgres from 'postgres';
import {
    formerlyAvailableSql,
    mediaReferenceGuard,
    noOperatorCurationSql,
    RETENTION_UNIT_MAX_ROWS,
} from './media-retention.queries.js';

export const NEVER_OWNED_GC_KINDS = ['movie', 'series'] as const;
export type NeverOwnedGcKind = (typeof NEVER_OWNED_GC_KINDS)[number];
export const NEVER_OWNED_GC_UNIT_MAX_ROWS = RETENTION_UNIT_MAX_ROWS;
const NEVER_OWNED_GC_MAX_DEPTH = 64;

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** Why a keep rule protects a unit; also the grouping the run result reports. */
export type KeepCategory =
    | 'user-data'
    | 'history'
    | 'curation'
    | 'delivery'
    | 'live-tv'
    | 'files'
    | 'catalog-state'
    | 'discovery'
    | 'shape';

export type MediaReferenceClass =
    | {
          class: 'protect';
          category: KeepCategory;
          reason: string;
          /** Extra condition on the referencing row `r`; without it any row protects. */
          when?: (sql: postgres.Sql) => Fragment;
          /** Rule key that already covers this reference (no generated rule). */
          coveredBy?: string;
      }
    | { class: 'derived'; reason: string }
    | { class: 'unit'; reason: string };

const protect = (
    category: KeepCategory,
    reason: string,
    extra: { when?: (sql: postgres.Sql) => Fragment; coveredBy?: string } = {},
): MediaReferenceClass => ({ class: 'protect', category, reason, ...extra });
const derived = (reason: string): { class: 'derived'; reason: string } => ({
    class: 'derived',
    reason,
});

/**
 * Every foreign key to `media_items(id)`, keyed `table.column`. `protect`:
 * a referencing row keeps the unit. `derived`: provider/cache/pipeline data
 * that is rebuilt from the provider or only exists for the row itself, so it
 * may cascade with it. `unit`: the parent link that defines unit membership.
 * The integration test enumerates pg_constraint and fails on any FK missing
 * here, so a new FK cannot silently cascade.
 */
export const MEDIA_ITEM_FK_CLASSIFICATION: Readonly<Record<string, MediaReferenceClass>> = {
    // User data, history, curation and delivery: keep.
    'user_ratings.media_id': protect('user-data', 'A user rated the title.'),
    'user_media_state.media_id': protect('user-data', 'Watch state, favourite or progress.'),
    'user_media_events.media_id': protect('history', 'Playback/activity events.'),
    'user_music_state.track_id': protect('user-data', 'Listening counters.'),
    'music_listen_events.track_id': protect('history', 'Listening history.'),
    'user_rate_skips.media_id': protect('user-data', 'The user skipped rating it.'),
    'user_taste_dampers.media_id': protect('user-data', '"Less like this" feedback.'),
    'user_media_share_opt_out.media_id': protect('user-data', 'Share preference.'),
    'user_suggestions.media_id': protect(
        'user-data',
        'Personal recommendation shown in For You; deleting would break the rail entry. Expired suggestions stop protecting once their cleanup removes them.',
    ),
    'media_annotations.media_id': protect('user-data', 'User notes/pins.'),
    'playlist_items.media_id': protect('user-data', 'Playlist or watchlist entry.'),
    'watchlist_activities.media_id': protect('history', 'Watchlist history (SET NULL).'),
    'watch_history.media_id': protect('history', 'Viewing sessions (SET NULL).'),
    'watch_state_sync_log.media_id': protect('history', 'Watch-sync log.'),
    'play_sessions.media_id': protect('delivery', 'Playback session.'),
    'playback_incident_events.media_id': protect('delivery', 'Playback incident (SET NULL).'),
    'transcode_failure_events.media_id': protect('delivery', 'Transcode failure (SET NULL).'),
    'download_renditions.media_item_id': protect('delivery', 'Offline download rendition.'),
    'hls_playback_tokens.catalog_media_item_id': protect('delivery', 'Playback grant.'),
    'media_added_pending.media_item_id': protect('delivery', 'Queued "new media" notification.'),
    'upload_sessions.media_item_id': protect('delivery', 'Upload in progress (SET NULL).'),
    'training_assignments.media_id': protect('user-data', 'Training assignment.'),
    'course_modules.media_item_id': protect('user-data', 'Course module (SET NULL).'),
    'courses.cover_media_id': protect('user-data', 'Course cover (SET NULL).'),
    'sync_quarantine.expected_series_id': protect(
        'history',
        'Watch-sync payload awaiting resolution (SET NULL).',
    ),
    'episode_reconciliation_moves.episode_id': protect(
        'history',
        'Reconciliation move with undo data (SET NULL).',
    ),
    'library_availability.media_id': protect(
        'files',
        'Available in an external library (Jellyfin); unavailable rows are a cache.',
        { when: (sql) => sql`r.available = true` },
    ),
    'series_episode_ordering.media_id': protect(
        'curation',
        'Operator-chosen episode ordering; automatic orderings are derived.',
        { when: (sql) => sql`COALESCE(r.ordering_source, 'manual') <> 'auto'` },
    ),
    'admin_media_change_receipts.media_item_id': protect(
        'curation',
        'Recoverable admin media choice.',
    ),
    'media_artwork_suppressions.media_item_id': protect('curation', 'Operator hid an image.'),
    'music_edit_receipts.target_id': protect('curation', 'Recoverable manual music edit.'),
    'personal_media_dispositions.media_id': protect(
        'curation',
        'Local admin decision to keep an unmatched item as personal media.',
    ),
    'media_artwork.media_item_id': protect('curation', 'Historical admin artwork before capture.', {
        when: (sql) => sql`r.remote_url LIKE 'admin:%'`,
    }),
    'image_candidates.media_item_id': protect(
        'curation',
        'Manually chosen artwork (chosen_by admin/user); automatic provider artwork is derived.',
        { when: (sql) => sql`(r.chosen_by <> 'auto' OR r.remote_url LIKE 'admin:%')` },
    ),
    'media_file_items.media_item_id': protect('files', 'A file is linked.'),
    'media_items.canonical_id': protect(
        'catalog-state',
        'Alias target: another row redirects here.',
    ),
    'livetv_channels.id': protect('live-tv', 'The row is a Live TV channel.'),

    'cached_list_items.media_id': protect(
        'discovery',
        'On a curated list. List sync only links rows that exist, so deleting drops the entry until the sweep re-creates the title under a new UUID.',
    ),

    // Unit membership.
    'media_items.parent_id': {
        class: 'unit',
        reason: 'Children are unit members and are checked and deleted explicitly (the FK is SET NULL).',
    },

    // Derived: rebuilt from providers or only meaningful with the row.
    'external_ids.media_id': derived('Provider ids of the row itself.'),
    'provider_metadata.media_id': derived('Provider payload cache.'),
    'media_credits.media_id': derived('Derived from provider_metadata.'),
    'media_people.media_id': derived('Derived from provider_metadata.'),
    'media_genres.media_id': derived('Derived from provider_metadata.'),
    'media_keywords.media_id': derived('Derived from provider_metadata.'),
    'media_scalars.media_id': derived('Derived from provider_metadata.'),
    'media_titles.media_id': derived('Provider alternative titles.'),
    'media_item_translations.media_id': derived('Provider translations.'),
    'album_split_health_pairs.album_a': derived('Split-album health check bookkeeping.'),
    'album_split_health_pairs.album_b': derived('Split-album health check bookkeeping.'),
    'media_external_groupings.media_id': derived('Provider grouping cache.'),
    'media_popularity.media_id': derived('Provider popularity.'),
    'music_popularity_rank.media_id': derived('Computed rank.'),
    'media_embeddings.media_id': derived('Embedding of the row.'),
    'media_audio_clusters.media_id': derived('Audio analysis.'),
    'media_audio_embedding_state.media_id': derived('Audio analysis state.'),
    'media_audio_embeddings.media_id': derived('Audio analysis.'),
    'media_audio_map_coords.media_id': derived('Audio map projection.'),
    'media_lyrics_embedding_state.media_id': derived('Lyrics analysis state.'),
    'media_lyrics_embeddings.media_id': derived('Lyrics analysis.'),
    'media_item_stage_state.media_item_id': derived('Pipeline bookkeeping.'),
    'media_item_quality.media_item_id': derived('File-derived quality bookkeeping.'),
    'media_item_languages.media_item_id': derived('Stream-derived languages.'),
    'media_segments.media_id': derived('Skip segments of a file.'),
    'media_segment_candidates.media_id': derived('Unreviewed segment candidates.'),
    'media_segment_fingerprints.media_id': derived('Resumable file/input-bound audio extraction.'),
    'media_segment_analysis_passes.media_id': derived(
        'File/input-bound analyzer completion evidence.',
    ),
    'trickplay_params.media_item_id': derived('Trickplay of a file.'),
    'episode_orderings.episode_media_id': derived('Provider episode-group mapping.'),
    'episode_orderings.series_media_id': derived('Provider episode-group mapping.'),
    'series_grouping_state.series_id': derived('Provider grouping enrichment state.'),
    'series_health_reports.series_media_id': derived('Diagnostic report.'),
    'audiobook_book_contributors.media_id': derived('Audiobook link rows (never a GC kind).'),
    'audiobook_book_series.media_id': derived('Audiobook link rows (never a GC kind).'),
};

/**
 * Columns that hold media ids WITHOUT a foreign key. Same classes as
 * {@link MEDIA_ITEM_FK_CLASSIFICATION}; protect entries carry their own
 * predicate because the comparison is not a plain FK equality. Mutes live in
 * `user_media_flags` (`series_excluded`, target = catalog UUID) and are
 * protected; a TMDB-keyed mute (`tv:123`) names no catalog row.
 */
export const NO_FK_MEDIA_REFERENCES: Readonly<
    Record<
        string,
        | { class: 'protect'; category: KeepCategory; reason: string; protects: ReferencePredicate }
        | { class: 'derived'; reason: string }
    >
> = {
    'music_edit_receipts.reference_ids': {
        class: 'protect',
        category: 'curation',
        reason: 'Original music identities and batch participants needed by an available Undo.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM music_edit_receipts r WHERE r.undone_at IS NULL AND r.reference_ids @> ARRAY[${sql(alias)}.id])`,
    },
    'admin_media_change_receipts.owner': {
        class: 'derived',
        reason: 'Lookup key mirrors the classified media_item_id FK for catalog owners; person handles are not media identities.',
    },
    'admin_media_change_receipts.before_state': {
        class: 'protect',
        category: 'curation',
        reason: 'A recoverable file mapping may restore links to episodes in its original, different series.',
        protects: (sql, alias) => sql`EXISTS (SELECT 1 FROM admin_media_change_receipts r
            WHERE r.undone_at IS NULL AND r.kind LIKE 'file-mapping:%'
              AND (r.before_state->'ids') ? ${sql(alias)}.id::text)`,
    },
    'interactions.target_id': {
        class: 'protect',
        category: 'user-data',
        reason: 'Comment on the title (text id, legacy spellings).',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM interactions r WHERE r.target_type = 'media' AND lower(replace(r.target_id, '-', '')) = replace(${sql(alias)}.id::text, '-', ''))`,
    },
    'interaction_reactions.target_id': {
        class: 'protect',
        category: 'user-data',
        reason: 'Reaction on the title.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM interaction_reactions r WHERE r.target_type = 'media' AND lower(replace(r.target_id, '-', '')) = replace(${sql(alias)}.id::text, '-', ''))`,
    },
    'user_media_flags.target_id': {
        class: 'protect',
        category: 'user-data',
        reason: 'Per-user flags, including mutes by catalog UUID.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM user_media_flags r WHERE lower(replace(r.target_id, '-', '')) = replace(${sql(alias)}.id::text, '-', ''))`,
    },
    'watch_state_pending_resolution.internal_media_id': {
        class: 'protect',
        category: 'history',
        reason: 'Imported watch state awaiting resolution.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM watch_state_pending_resolution r WHERE r.internal_media_id = ${sql(alias)}.id)`,
    },
    'watch_sync_activity.media_id': {
        class: 'protect',
        category: 'history',
        reason: 'Watch-sync activity log.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM watch_sync_activity r WHERE r.media_id = ${sql(alias)}.id)`,
    },
    'user_media_events_archive.media_id': {
        class: 'protect',
        category: 'history',
        reason: 'Archived playback events.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM user_media_events_archive r WHERE r.media_id = ${sql(alias)}.id)`,
    },
    'assistant_messages.context_media_ids': {
        class: 'protect',
        category: 'user-data',
        reason: 'Assistant chat history that cites the title.',
        // unnest first so the planner can hash the id set instead of probing every array.
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM (SELECT unnest(r.context_media_ids) AS id FROM assistant_messages r) x WHERE x.id = ${sql(alias)}.id)`,
    },
    'client_diagnostics.media_id': {
        class: 'protect',
        category: 'delivery',
        reason: 'Client diagnostic report about playing the title.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM client_diagnostics r WHERE r.media_id = ${sql(alias)}.id)`,
    },
    'active_transcode_jobs.item_id': {
        class: 'protect',
        category: 'delivery',
        reason: 'Running transcode (text id as the client sent it).',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM active_transcode_jobs r WHERE lower(replace(r.item_id, '-', '')) = replace(${sql(alias)}.id::text, '-', ''))`,
    },
    'hls_playback_tokens.media_item_id': {
        class: 'protect',
        category: 'delivery',
        reason: 'Playback token (live grants bind a station here, catalog grants also have the FK).',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM hls_playback_tokens r WHERE r.media_item_id = ${sql(alias)}.id)`,
    },
    // Reconciliation moves keep their undo data; the undo locks on series_id and moves the
    // episode back between from_parent_id/to_parent_id (episode-reconciliation-undo.service.ts).
    'episode_reconciliation_moves.series_id': {
        class: 'protect',
        category: 'history',
        reason: 'Series of a reconciliation move (undo history).',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.series_id = ${sql(alias)}.id)`,
    },
    'episode_reconciliation_moves.from_parent_id': {
        class: 'protect',
        category: 'history',
        reason: 'Season an undo moves the episode back to.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.from_parent_id = ${sql(alias)}.id)`,
    },
    'episode_reconciliation_moves.to_parent_id': {
        class: 'protect',
        category: 'history',
        reason: 'Season a reconciliation moved the episode to.',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.to_parent_id = ${sql(alias)}.id)`,
    },
    'episode_reconciliation_moves.ghost_id': {
        class: 'protect',
        category: 'history',
        reason: 'Duplicate row a reconciliation merged (undo history).',
        protects: (sql, alias) =>
            sql`EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.ghost_id = ${sql(alias)}.id)`,
    },
    'file_range_mapping_proofs.season_id': derived(
        'Generated file/input mapping evidence; shared hard-delete cleanup removes the observation with its season, without conferring ownership of participant files.',
    ),
    'event_outbox.media_item_id': derived('Pipeline event queue, drained within minutes.'),
    'plugin_failure_events.item_id': derived('Plugin failure diagnostics.'),
    'integrity_violations.media_id': derived('Health-check findings.'),
    'mood_vectors.seed_media_ids': derived('Music mood seeds (never a GC kind).'),
    'sync_changes.entity_id': derived('The library delta-sync log itself.'),
};

/** Run parameters a rule may compare against. */
export interface RuleContext {
    /** `NOW() - minAgeDays`, as a fresh fragment per use. */
    cutoff: () => Fragment;
    /** `NOW() - max(minAgeDays, 2 × DISCOVERY_DETAIL_REFRESH_DAYS)`, as a fresh fragment per use. */
    discoveryCutoff: () => Fragment;
}

/**
 * The discovery sweep's re-stamp cadence (`DISCOVERY_DETAIL_REFRESH_DAYS` in
 * tmdb-metadata-sync.ts; a unit test keeps the two equal). A stamp may be up to this old
 * while the title is still listed, so the discovery rule looks back twice as far.
 */
export const DISCOVERY_DETAIL_REFRESH_DAYS = 14;

/** Days a discovery stamp keeps a unit: never less than two re-stamp periods. */
export function discoveryLookbackDays(minAgeDays: number): number {
    return Math.max(minAgeDays, 2 * DISCOVERY_DETAIL_REFRESH_DAYS);
}

/** TRUE when the rule protects the media_items row named `alias`. */
type ReferencePredicate = (sql: postgres.Sql, alias: string) => Fragment;
type RulePredicate = (sql: postgres.Sql, alias: string, ctx: RuleContext) => Fragment;

/**
 * `provider_metadata.metadata` key the TMDB discovery sweep stamps when it refreshes an
 * item's details (`DISCOVERY_DETAIL_SYNCED_AT_KEY` in ai-sync.queries.ts; a test keeps the
 * two equal). The sweep re-stamps every item still on its lists every
 * DISCOVERY_DETAIL_REFRESH_DAYS (14), so a stamp newer than the minimum age means the
 * title is still listed and the sweep would re-create it under a new UUID.
 * `media_items.updated_at` cannot serve: migrations and backfills rewrite whole tables
 * (prod: every never-owned root has updated_at within the last 30 days).
 */
export const DISCOVERY_SEEN_KEY = 'discovery_detail_synced_at';
const ISO_TIMESTAMP = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$';

export interface KeepRule {
    /** `table.column` for references, a short name for row-state rules. */
    key: string;
    category: KeepCategory;
    /** TRUE when this rule protects the member row `alias`. */
    protects: RulePredicate;
}

/** Row-state rules on the member itself. */
const STATE_RULES: KeepRule[] = [
    {
        key: 'not-active',
        category: 'catalog-state',
        protects: (sql, alias) => sql`${sql(alias)}.status <> 'active'`,
    },
    {
        key: 'has-files',
        category: 'files',
        protects: (sql, alias) => sql`${sql(alias)}.has_files`,
    },
    {
        key: 'formerly-owned',
        category: 'files',
        protects: (sql, alias) => formerlyAvailableSql(sql, alias),
    },
    {
        key: 'dismissed',
        category: 'curation',
        protects: (sql, alias) => sql`${sql(alias)}.is_dismissed`,
    },
    {
        key: 'alias-row',
        category: 'catalog-state',
        protects: (sql, alias) => sql`${sql(alias)}.canonical_id IS NOT NULL`,
    },
    {
        key: 'operator-curation',
        category: 'curation',
        protects: (sql, alias) => sql`NOT ${noOperatorCurationSql(sql, alias)}`,
    },
    {
        // The root is old enough, but a season or episode added since is recent activity.
        key: 'young-member',
        category: 'catalog-state',
        protects: (sql, alias, ctx) => sql`${sql(alias)}.created_at >= ${ctx.cutoff()}`,
    },
    {
        key: 'recently-seen-by-discovery',
        category: 'discovery',
        // The regex guard keeps one malformed stamp from aborting the whole evaluation.
        // OFFSET 0 keeps this lookup correlated to the bounded member batch.
        // Prod used 314k buffers scanning all provider metadata, versus 38k
        // with indexed member lookups; removing the fence reintroduces that plan.
        protects: (sql, alias, ctx) =>
            sql`EXISTS (SELECT 1 FROM provider_metadata pm
                WHERE pm.media_id = ${sql(alias)}.id
                  AND CASE WHEN pm.metadata->>${DISCOVERY_SEEN_KEY} ~ ${ISO_TIMESTAMP}
                           THEN (pm.metadata->>${DISCOVERY_SEEN_KEY})::timestamptz >= ${ctx.discoveryCutoff()}
                           ELSE false END OFFSET 0)`,
    },
];

function fkRule(key: string, entry: Extract<MediaReferenceClass, { class: 'protect' }>): KeepRule {
    return {
        key,
        category: entry.category,
        protects: (sql, alias) => fkProtectionSql(sql, alias, key, entry),
    };
}

function fkProtectionSql(
    sql: postgres.Sql,
    alias: string,
    key: string,
    entry: Extract<MediaReferenceClass, { class: 'protect' }>,
): Fragment {
    const [table, column] = key.split('.');
    return sql`EXISTS (SELECT 1 FROM ${sql(table)} r WHERE r.${sql(column)} = ${sql(alias)}.id ${
        entry.when ? sql`AND ${entry.when(sql)}` : sql``
    })`;
}

/**
 * Every keep rule, in report order. Generated from the two classification
 * tables so the guard and the classification cannot disagree.
 */
export const NEVER_OWNED_KEEP_RULES: readonly KeepRule[] = [
    ...STATE_RULES,
    ...Object.entries(MEDIA_ITEM_FK_CLASSIFICATION).flatMap(([key, entry]) =>
        entry.class === 'protect' && !entry.coveredBy ? [fkRule(key, entry)] : [],
    ),
    ...Object.entries(NO_FK_MEDIA_REFERENCES).flatMap(([key, entry]) =>
        entry.class === 'protect'
            ? [{ key, category: entry.category, protects: entry.protects }]
            : [],
    ),
];

/** Reference protections shared by music retention, without never-owned age/state rules. */
export function classifiedMediaReferenceGuard(
    sql: postgres.Sql,
    alias: string,
    opts: { missingTrackFiles?: boolean } = {},
): Fragment {
    const rules: Fragment[] = [
        ...Object.entries(MEDIA_ITEM_FK_CLASSIFICATION).flatMap(([key, entry]) =>
            entry.class === 'protect' &&
            !entry.coveredBy &&
            !(opts.missingTrackFiles && key === 'media_file_items.media_item_id')
                ? [fkProtectionSql(sql, alias, key, entry)]
                : [],
        ),
        ...Object.values(NO_FK_MEDIA_REFERENCES).flatMap((entry) =>
            entry.class === 'protect' ? [entry.protects(sql, alias)] : [],
        ),
    ];
    return rules.reduce((guard, protects) => sql`${guard} AND NOT (${protects})`, sql`true`);
}

/**
 * Tables of the protect-class no-FK references. Their writers take no key lock on the
 * media row, so a delete SHARE-locks them (NOWAIT) to keep a reference from appearing
 * between the re-check and the commit.
 */
export const NEVER_OWNED_NO_FK_LOCK_TABLES: readonly string[] = [
    ...new Set(
        Object.entries(NO_FK_MEDIA_REFERENCES)
            .filter(([, entry]) => entry.class === 'protect')
            .map(([key]) => key.split('.')[0]),
    ),
].sort();

/** Shape and belt-and-braces rules that are evaluated per unit, not per member. */
export const NEVER_OWNED_UNIT_RULES = {
    'unexpected-member-type': 'shape',
    'too-deep': 'shape',
    oversized: 'shape',
    // The retention guard is evaluated as well, so the GC is never laxer than it.
    'retention-reference-guard': 'user-data',
} as const satisfies Record<string, KeepCategory>;

/** Never-owned root predicate on `alias` (age excluded). */
export function neverOwnedRootSql(sql: postgres.Sql, alias: string): Fragment {
    const a = sql(alias);
    return sql`(
        ${a}.media_type IN ('movie', 'tv')
        AND ${a}.parent_id IS NULL
        AND ${a}.status = 'active'
        AND ${a}.has_files = false
        AND NOT ${formerlyAvailableSql(sql, alias)}
    )`;
}

export interface NeverOwnedUnitCandidate {
    id: string;
    kind: NeverOwnedGcKind;
    members: number;
    seasons: number;
    episodes: number;
    extras: number;
}

export interface NeverOwnedKindSummary {
    kind: NeverOwnedGcKind;
    /** Never-owned roots at least `minAgeDays` old (evaluated). */
    roots: number;
    /** Never-owned roots younger than `minAgeDays` (not evaluated). */
    tooYoung: number;
    /** Units that pass every rule. */
    eligible: number;
    /** Rows in eligible units, root included. */
    eligibleRows: number;
    eligibleSeasons: number;
    eligibleEpisodes: number;
    eligibleExtras: number;
    /** Evaluated units kept by at least one rule. */
    kept: number;
}

export interface NeverOwnedGcEvaluation {
    /** The first `limit` eligible units, in root-id order. */
    candidates: NeverOwnedUnitCandidate[];
    summary: Record<NeverOwnedGcKind, NeverOwnedKindSummary>;
    /** Kept units per rule key; a unit counts once under every rule that protects it. */
    keptByRule: Record<string, number>;
    /** Kept units per category; a unit counts once per category. */
    keptByCategory: Partial<Record<KeepCategory, number>>;
    /** Keyset cursor: the last root id of a full batch; null when this batch was the last. */
    nextAfterRootId: string | null;
}

/** Root ids per evaluation statement over the whole catalog. */
export const NEVER_OWNED_GC_ROOT_BATCH = 2000;

export function emptyNeverOwnedEvaluation(): NeverOwnedGcEvaluation {
    return {
        candidates: [],
        summary: { movie: emptySummary('movie'), series: emptySummary('series') },
        keptByRule: {},
        keptByCategory: {},
        nextAfterRootId: null,
    };
}

/**
 * Add one batch into a running total. Batches cover disjoint root-id ranges, so every
 * count (units per rule and per category included) simply adds up.
 */
export function mergeNeverOwnedEvaluation(
    into: NeverOwnedGcEvaluation,
    batch: NeverOwnedGcEvaluation,
    candidateLimit: number,
): void {
    for (const c of batch.candidates)
        if (into.candidates.length < candidateLimit) into.candidates.push(c);
    for (const kind of NEVER_OWNED_GC_KINDS) {
        const a = into.summary[kind];
        const b = batch.summary[kind];
        a.roots += b.roots;
        a.tooYoung += b.tooYoung;
        a.eligible += b.eligible;
        a.eligibleRows += b.eligibleRows;
        a.eligibleSeasons += b.eligibleSeasons;
        a.eligibleEpisodes += b.eligibleEpisodes;
        a.eligibleExtras += b.eligibleExtras;
        a.kept += b.kept;
    }
    for (const [rule, n] of Object.entries(batch.keptByRule))
        into.keptByRule[rule] = (into.keptByRule[rule] ?? 0) + n;
    for (const [category, n] of Object.entries(batch.keptByCategory))
        into.keptByCategory[category as KeepCategory] =
            (into.keptByCategory[category as KeepCategory] ?? 0) + (n ?? 0);
    into.nextAfterRootId = batch.nextAfterRootId;
}

function emptySummary(kind: NeverOwnedGcKind): NeverOwnedKindSummary {
    return {
        kind,
        roots: 0,
        tooYoung: 0,
        eligible: 0,
        eligibleRows: 0,
        eligibleSeasons: 0,
        eligibleEpisodes: 0,
        eligibleExtras: 0,
        kept: 0,
    };
}

/**
 * Evaluate never-owned units and return the first `limit` eligible ones plus
 * per-kind and per-rule counts. Reads only. Scope: the unit rooted at `rootId`,
 * or one keyset batch of `batchSize` roots after `afterRootId` (root-id order),
 * or, with neither, every root in one statement (tests, previews of small
 * catalogs). Each rule is one semi-join over all unit members, so the counts
 * per rule come from the same pass that decides eligibility.
 */
export async function evaluateNeverOwnedUnits(
    sql: postgres.Sql,
    opts: {
        limit: number;
        minAgeDays: number;
        rootId?: string;
        afterRootId?: string | null;
        batchSize?: number;
        signal?: AbortSignal;
    },
): Promise<NeverOwnedGcEvaluation> {
    const ctx: RuleContext = {
        cutoff: () => sql`(NOW() - make_interval(days => ${opts.minAgeDays}::int))`,
        discoveryCutoff: () =>
            sql`(NOW() - make_interval(days => ${discoveryLookbackDays(opts.minAgeDays)}::int))`,
    };
    const cutoff = ctx.cutoff();
    const root = opts.rootId ? sql`AND mi.id = ${opts.rootId}::uuid` : sql``;
    const after = opts.afterRootId ? sql`AND mi.id > ${opts.afterRootId}::uuid` : sql``;
    const page = opts.batchSize ? sql`ORDER BY mi.id LIMIT ${opts.batchSize}` : sql``;
    const hits = NEVER_OWNED_KEEP_RULES.map(
        (rule) => sql`
            SELECT ${rule.key}::text AS rule, ${rule.category}::text AS category, m.root_id
            FROM member_rows m
            WHERE ${rule.protects(sql, 'm', ctx)}
        `,
    ).reduce((acc, part) => sql`${acc} UNION ALL ${part}`);
    // Admin-only maintenance over all libraries; file-less rows are the point.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    const query = sql<
        {
            row_type: 'candidate' | 'kind' | 'rule' | 'category' | 'cursor';
            id: string | null;
            kind: NeverOwnedGcKind | null;
            rule: string | null;
            n_units: number | null;
            n_roots: number | null;
            n_young: number | null;
            n_rows: number | null;
            n_seasons: number | null;
            n_episodes: number | null;
            n_extras: number | null;
            n_kept: number | null;
        }[]
    >`
        WITH RECURSIVE all_roots AS MATERIALIZED (
            SELECT mi.id,
                   CASE WHEN mi.media_type = 'tv' THEN 'series' ELSE 'movie' END AS kind,
                   mi.created_at,
                   mi.created_at >= ${cutoff} AS young
            FROM media_items mi
            WHERE ${neverOwnedRootSql(sql, 'mi')} ${root} ${after}
            ${page}
        ),
        roots AS MATERIALIZED (SELECT * FROM all_roots WHERE NOT young),
        -- The visited path makes a parent_id cycle terminate without repeating a member.
        unit(root_id, id, depth, path) AS (
            SELECT r.id, r.id, 0, ARRAY[r.id] FROM roots r
            UNION ALL
            SELECT u.root_id, c.id, u.depth + 1, u.path || c.id
            FROM unit u JOIN media_items c ON c.parent_id = u.id
            WHERE u.depth < ${NEVER_OWNED_GC_MAX_DEPTH} AND c.id <> ALL(u.path)
        ),
        members AS MATERIALIZED (
            SELECT u.root_id, u.id, u.depth, mi.media_type,
                   (u.depth = 0
                    OR (r.kind = 'movie' AND mi.media_type = 'extra')
                    OR (r.kind = 'series' AND mi.media_type IN ('season', 'episode', 'extra'))) AS type_ok,
                   -- A walk cut off at the depth cap with rows below it is never a complete unit.
                   CASE WHEN u.depth >= ${NEVER_OWNED_GC_MAX_DEPTH}
                        THEN EXISTS (SELECT 1 FROM media_items deeper
                                     WHERE deeper.parent_id = u.id AND deeper.id <> ALL(u.path))
                        ELSE false END AS truncated
            FROM unit u
            JOIN roots r ON r.id = u.root_id
            JOIN media_items mi ON mi.id = u.id
        ),
        -- Fetch each bounded member once rather than rejoining the entire catalog
        -- for every keep rule (the recursive CTE's row estimate can be much too high).
        member_rows AS MATERIALIZED (
            SELECT mb.root_id, m.*
            FROM members mb JOIN media_items m ON m.id = mb.id
        ),
        hits AS MATERIALIZED (
            ${hits}
            UNION ALL
            SELECT 'unexpected-member-type', 'shape', mb.root_id FROM members mb WHERE NOT mb.type_ok
            UNION ALL
            SELECT 'too-deep', 'shape', mb.root_id FROM members mb WHERE mb.truncated
        ),
        guard_clean AS (
            SELECT m.root_id, COUNT(*)::int AS n
            FROM member_rows m
            WHERE ${mediaReferenceGuard(sql, 'm')}
            GROUP BY m.root_id
        ),
        protected_roots AS MATERIALIZED (
            SELECT DISTINCT root_id FROM hits
        ),
        evaluated AS MATERIALIZED (
            SELECT r.id, r.kind, r.created_at,
                   COUNT(*)::int AS members,
                   COUNT(*) FILTER (WHERE mb.media_type = 'season')::int AS seasons,
                   COUNT(*) FILTER (WHERE mb.media_type = 'episode')::int AS episodes,
                   COUNT(*) FILTER (WHERE mb.media_type = 'extra')::int AS extras,
                   COALESCE(MAX(g.n), 0) AS guard_clean,
                   COUNT(h.root_id) = 0 AS no_hits
            FROM roots r
            JOIN members mb ON mb.root_id = r.id
            LEFT JOIN guard_clean g ON g.root_id = r.id
            LEFT JOIN protected_roots h ON h.root_id = r.id
            GROUP BY r.id, r.kind, r.created_at
        ),
        judged AS MATERIALIZED (
            SELECT e.*,
                   e.guard_clean = e.members AS guard_ok,
                   e.members <= ${NEVER_OWNED_GC_UNIT_MAX_ROWS} AS size_ok,
                   (e.no_hits AND e.guard_clean = e.members
                    AND e.members <= ${NEVER_OWNED_GC_UNIT_MAX_ROWS}) AS ok
            FROM evaluated e
        ),
        unit_rules AS (
            SELECT h.rule, h.category, h.root_id FROM hits h
            UNION ALL
            SELECT 'retention-reference-guard', 'user-data', j.id FROM judged j WHERE NOT j.guard_ok
            UNION ALL
            SELECT 'oversized', 'shape', j.id FROM judged j WHERE NOT j.size_ok
        )
        SELECT * FROM (
            SELECT 'candidate'::text AS row_type, j.id::text AS id, j.kind, NULL::text AS rule,
                   1 AS n_units, NULL::int AS n_roots, NULL::int AS n_young, j.members AS n_rows,
                   j.seasons AS n_seasons, j.episodes AS n_episodes, j.extras AS n_extras,
                   NULL::int AS n_kept
            FROM judged j
            WHERE j.ok
            ORDER BY j.id
            LIMIT ${opts.limit}
        ) candidates
        UNION ALL
        SELECT 'kind', NULL, k.kind, NULL,
               (SELECT COUNT(*) FROM judged j WHERE j.kind = k.kind AND j.ok)::int,
               (SELECT COUNT(*) FROM all_roots a WHERE a.kind = k.kind AND NOT a.young)::int,
               (SELECT COUNT(*) FROM all_roots a WHERE a.kind = k.kind AND a.young)::int,
               (SELECT COALESCE(SUM(j.members), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int,
               (SELECT COALESCE(SUM(j.seasons), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int,
               (SELECT COALESCE(SUM(j.episodes), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int,
               (SELECT COALESCE(SUM(j.extras), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int,
               (SELECT COUNT(*) FROM judged j WHERE j.kind = k.kind AND NOT j.ok)::int
        FROM (VALUES ('movie'), ('series')) k(kind)
        UNION ALL
        SELECT 'rule', NULL, NULL, ur.rule, COUNT(DISTINCT ur.root_id)::int,
               NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM unit_rules ur GROUP BY ur.rule
        UNION ALL
        SELECT 'category', NULL, NULL, ur.category, COUNT(DISTINCT ur.root_id)::int,
               NULL, NULL, NULL, NULL, NULL, NULL, NULL
        FROM unit_rules ur GROUP BY ur.category
        UNION ALL
        SELECT 'cursor', (SELECT a.id::text FROM all_roots a ORDER BY a.id DESC LIMIT 1), NULL, NULL,
               (SELECT COUNT(*) FROM all_roots)::int, NULL, NULL, NULL, NULL, NULL, NULL, NULL
    `;
    const cancel = (): void => {
        if (typeof query.cancel === 'function') query.cancel();
    };
    opts.signal?.throwIfAborted();
    opts.signal?.addEventListener('abort', cancel, { once: true });
    try {
        const rows = await query;
        opts.signal?.throwIfAborted();
        const result = emptyNeverOwnedEvaluation();
        for (const row of rows) {
            if (row.row_type === 'candidate' && row.id && row.kind) {
                result.candidates.push({
                    id: row.id,
                    kind: row.kind,
                    members: row.n_rows ?? 0,
                    seasons: row.n_seasons ?? 0,
                    episodes: row.n_episodes ?? 0,
                    extras: row.n_extras ?? 0,
                });
            } else if (row.row_type === 'kind' && row.kind) {
                result.summary[row.kind] = {
                    kind: row.kind,
                    roots: row.n_roots ?? 0,
                    tooYoung: row.n_young ?? 0,
                    eligible: row.n_units ?? 0,
                    eligibleRows: row.n_rows ?? 0,
                    eligibleSeasons: row.n_seasons ?? 0,
                    eligibleEpisodes: row.n_episodes ?? 0,
                    eligibleExtras: row.n_extras ?? 0,
                    kept: row.n_kept ?? 0,
                };
            } else if (row.row_type === 'rule' && row.rule) {
                result.keptByRule[row.rule] = row.n_units ?? 0;
            } else if (row.row_type === 'category' && row.rule) {
                result.keptByCategory[row.rule as KeepCategory] = row.n_units ?? 0;
            } else if (row.row_type === 'cursor' && opts.batchSize) {
                // A full batch may have more roots after it; a short one was the last.
                result.nextAfterRootId = (row.n_units ?? 0) >= opts.batchSize ? row.id : null;
            }
        }
        return result;
    } finally {
        opts.signal?.removeEventListener('abort', cancel);
    }
}
