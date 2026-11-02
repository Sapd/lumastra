// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fribb Anime ID Sync — native defineTask implementation.
 *
 * Downloads the Fribb/anime-lists community mapping from GitHub (auto-cached
 * for 24h in memory) and enriches active anime media items with MAL and
 * AniList external IDs, derived from their existing TMDB IDs.
 *
 * Mapping source:
 *   https://github.com/Fribb/anime-lists
 *   Format: JSON array, ~42k entries, ~7MB. Fields used: themoviedb_id,
 *   mal_id, anilist_id, type ('TV', 'MOVIE', 'OVA', 'ONA', 'SPECIAL', ...).
 *
 *   ⚠️ SCHEMA DRIFT (observed 2026-07): the upstream dataset now emits
 *   `themoviedb_id` as a per-media-type OBJECT, not a bare number, and every id
 *   sits in an array:
 *       { "movie": [372058] }   or   { "tv": [60808] }
 *   and `type` is now UPPERCASE ('MOVIE'/'TV', previously 'Movie'/'TV'). The
 *   old code keyed a `Map<number, …>` off the raw object and filtered by
 *   `type === 'Movie'`, so EVERY lookup missed and every anime was tombstoned
 *   `not-in-fribb-dataset` — 0 MAL ids ever written, which silently broke all
 *   MAL watch-sync resolution. `buildTmdbLookup` now parses the nested buckets
 *   and `fribbTypeSide` normalizes the case; both tolerate the legacy shapes.
 *
 * Disambiguation:
 *   The same TMDB ID can appear in multiple Fribb entries. `buildTmdbLookup`
 *   already narrows by the bucket's media type (a library movie only indexes
 *   under Fribb `movie` ids, a series only under `tv` ids), so `disambiguate`
 *   only breaks a residual tie when >1 entry shares the same (type, id). If
 *   exactly 1 entry remains, we use it. Otherwise skip.
 *
 * IMDb fallback:
 *   Fribb sometimes files an anime MOVIE's tmdb under its parent TV series'
 *   `tv` bucket rather than the movie's own tmdb (e.g. End of Evangelion, No
 *   Game No Life: Zero), so the tmdb-bucket lookup misses entirely. When it
 *   does, we match the library item's imdb id against Fribb's `imdb_id`
 *   (`buildImdbLookup`) — an imdb id is work-specific, so it resolves the movie
 *   even when Fribb's tmdb mapping points at the wrong entity.
 *
 * Modes (via drainBacklog):
 *   - catchup: process one slice (500 items) per scheduled weekly tick
 *   - manual:  drain all items missing a MAL ID
 *   - force:   delete all mal/anilist external_ids, then drain as manual
 *
 * No rate limiting needed: all lookup work is in-memory after the initial
 * fetch; only DB writes (upsertExternalId) hit the network.
 *
 * Configuration:
 * - DISABLE_FRIBB_ANIME_SYNC: Set to 'true' to disable this task entirely.
 *   Checked at execute() entry so manual triggers are also blocked.
 *
 * Settings:
 * - dataUrl: URL to the anime-list-full.json file (default: official GitHub).
 */

import { z } from 'zod';
import { ExternalIdOwnedByAnotherItemError } from '$lib/server/services/catalog.service.js';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import type { BacklogStage, TaskContext, HttpClient } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import type postgres from 'postgres';
import {
    upsertCompletedRow,
    upsertSkippedPermanentRow,
} from '../../../database/queries/stage-state.queries.js';
import { getAuthoritativeStageIds } from '$lib/server/config.js';
import { registry } from '../../registry.js';
import { withApiCallSpend } from '../../api-call-spend.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';

// ============================================================================
// Types (exported for unit tests)
// ============================================================================

/**
 * Fribb's `themoviedb_id`. Historically a bare number; the current dataset
 * encodes it as an object with per-media-type buckets, each a scalar or array.
 * Both shapes are handled so a mirror pinned to an older commit still works.
 */
export type FribbTmdbId =
    number | { movie?: number | number[] | null; tv?: number | number[] | null };

export interface FribbEntry {
    themoviedb_id?: FribbTmdbId | null;
    mal_id?: number | null;
    anilist_id?: number | null;
    anidb_id?: number | null;
    tvdb_id?: number | null;
    // Fribb carries the IMDb id (scalar or array). Used as a fallback match:
    // Fribb sometimes files an anime MOVIE's tmdb under its parent TV series'
    // `tv` bucket (not the movie's own tmdb), so the tmdb-bucket lookup misses;
    // the imdb id still points at the right work.
    imdb_id?: string | string[] | null;
    type?: string;
}

interface CandidateRow {
    media_id: string;
    media_type: string;
    tmdb_id: string;
}

// ============================================================================
// Constants
// ============================================================================

const FRIBB_URL = 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// 2026-05-24: bumped 500→2000. Fribb's anime list is fetched once per 24h
// (CACHE_TTL_MS) and lives in-memory after that, so per-item cost is just
// JSON lookup + DB upsert (~ms each). 2000 items per run = a few seconds
// of work, fits easily into the schedule. Combined with schedule drop
// 168h→48h yields ~7000 items/week vs 500/week previously — drains an
// 8k backlog in ~4 days instead of ~16 weeks.
const SLICE_SIZE = 2000;
const SUPPORTED_TYPES = ['movie', 'tv'] as const;

/** Stage skip reason while `DISABLE_FRIBB_ANIME_SYNC` is set (reclaimed when cleared). */
export const FRIBB_DISABLED_REASON = 'fribb-anime-sync-disabled';

// ============================================================================
// In-memory cache
// ============================================================================

let _cachedEntries: FribbEntry[] | null = null;
let _cacheExpiresAt = 0;
let _pendingFetch: Promise<FribbEntry[]> | null = null;
let _dataUrl = FRIBB_URL;

// ============================================================================
// Pure utilities — exported for unit tests
// ============================================================================

/**
 * Media-type lookup key. `buildTmdbLookup` keys entries by `${side}:${tmdbId}`
 * so a library movie only ever matches Fribb `movie` ids and a series only `tv`
 * ids — the id's bucket carries the type, so we never rely on the (case-drifted)
 * `type` string for the primary match.
 */
function tmdbKey(side: 'movie' | 'tv', tmdbId: number): string {
    return `${side}:${tmdbId}`;
}

/** Coerce a Fribb tmdb bucket (scalar | array | null) to a list of positive ints. */
function toTmdbIdArray(v: number | number[] | null | undefined): number[] {
    if (v == null) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0);
}

/**
 * Normalize Fribb's `type` (case-drifted to UPPERCASE upstream) to a media
 * side. Everything that isn't a movie is tv-side, matching the legacy
 * `!== 'Movie'` semantics. Returns null when the type is unusable so a legacy
 * bare-number entry gets indexed under both sides and disambiguate breaks the tie.
 */
export function fribbTypeSide(type: string | undefined): 'movie' | 'tv' | null {
    if (!type) return null;
    const t = type.trim().toUpperCase();
    if (t === 'MOVIE') return 'movie';
    if (t === 'UNKNOWN') return null;
    return 'tv'; // TV, OVA, ONA, SPECIAL, MUSIC, …
}

/**
 * Build Map<`${side}:${tmdbId}`, FribbEntry[]> from the raw Fribb array.
 * Entries without any usable themoviedb_id are skipped. Handles both the
 * current per-type object shape and the legacy bare-number shape.
 */
export function buildTmdbLookup(entries: FribbEntry[]): Map<string, FribbEntry[]> {
    const map = new Map<string, FribbEntry[]>();
    const add = (side: 'movie' | 'tv', id: number, entry: FribbEntry): void => {
        const key = tmdbKey(side, id);
        const bucket = map.get(key);
        if (bucket) bucket.push(entry);
        else map.set(key, [entry]);
    };
    for (const entry of entries) {
        const raw = entry.themoviedb_id;
        if (raw == null) continue;
        if (typeof raw === 'number') {
            if (!Number.isFinite(raw) || raw <= 0) continue;
            // Legacy bare-number shape: the id itself doesn't say movie-or-tv, so
            // index under the side implied by `type`, falling back to both.
            const side = fribbTypeSide(entry.type);
            if (side) add(side, raw, entry);
            else {
                add('movie', raw, entry);
                add('tv', raw, entry);
            }
        } else if (typeof raw === 'object') {
            for (const id of toTmdbIdArray(raw.movie)) add('movie', id, entry);
            for (const id of toTmdbIdArray(raw.tv)) add('tv', id, entry);
        }
    }
    return map;
}

/**
 * Break a residual tie among Fribb entries that share the same (side, tmdbId).
 * Callers pass the already type-narrowed bucket from `buildTmdbLookup`, so the
 * common case is exactly one entry. When several collide we prefer the one whose
 * declared `type` matches the requested side; ambiguity (0 or 2+) returns null.
 */
export function disambiguate(entries: FribbEntry[], mediaType: 'movie' | 'tv'): FribbEntry | null {
    if (entries.length === 0) return null;
    if (entries.length === 1) return entries[0];
    const side = isMovie(mediaType) ? 'movie' : 'tv';
    const preferred = entries.filter((e) => fribbTypeSide(e.type) === side);
    return preferred.length === 1 ? preferred[0] : null;
}

/** Look up a library item's (mediaType, tmdbId) against the Fribb lookup map. */
export function lookupFribbEntries(
    lookup: Map<string, FribbEntry[]>,
    mediaType: 'movie' | 'tv',
    tmdbId: number,
): FribbEntry[] {
    return lookup.get(tmdbKey(mediaType, tmdbId)) ?? [];
}

/**
 * Build Map<imdbId, FribbEntry[]> for the IMDb fallback. `imdb_id` is a scalar
 * or array in the dataset; entries without one are skipped. An IMDb id is unique
 * to a work, so this catches the class where Fribb files an anime movie's tmdb
 * under the parent TV series' `tv` bucket — the tmdb-bucket lookup misses but
 * the movie's imdb id still resolves to the correct entry.
 */
export function buildImdbLookup(entries: FribbEntry[]): Map<string, FribbEntry[]> {
    const map = new Map<string, FribbEntry[]>();
    for (const entry of entries) {
        const raw = entry.imdb_id;
        if (raw == null) continue;
        const ids = Array.isArray(raw) ? raw : [raw];
        for (const id of ids) {
            if (typeof id !== 'string' || id.length === 0) continue;
            const bucket = map.get(id);
            if (bucket) bucket.push(entry);
            else map.set(id, [entry]);
        }
    }
    return map;
}

// ============================================================================
// Fribb data loader
// ============================================================================

async function loadFribbData(http: HttpClient, signal?: AbortSignal): Promise<FribbEntry[]> {
    const now = Date.now();
    if (_cachedEntries !== null && now < _cacheExpiresAt) {
        return _cachedEntries;
    }
    if (_pendingFetch !== null) return _pendingFetch;
    _pendingFetch = http
        .get(_dataUrl, { signal })
        .then(async (r) => {
            if (!r.ok) throw new Error(`Fribb fetch failed: ${r.status} ${r.statusText}`);
            const data = (await r.json()) as unknown;
            if (!Array.isArray(data) || data.length === 0) {
                throw new Error('Fribb data invalid: expected non-empty array');
            }
            _cachedEntries = data as FribbEntry[];
            _cacheExpiresAt = Date.now() + CACHE_TTL_MS;
            return _cachedEntries;
        })
        .finally(() => {
            _pendingFetch = null;
        });
    return _pendingFetch;
}

// ============================================================================
// SQL helpers
// ============================================================================

async function countBacklog(sql: postgres.Sql): Promise<{
    analyzed: number;
    remaining: number;
    ineligible: number;
}> {
    const [row] = await sql<[{ analyzed: number; remaining: number; ineligible: number }]>`
        SELECT
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM external_ids ef
                    WHERE ef.media_id = mi.id AND ef.source = 'fribb-anime-lists'
                )
            )::int AS analyzed,
            COUNT(*) FILTER (
                WHERE EXISTS (
                    SELECT 1 FROM external_ids et
                    WHERE et.media_id = mi.id AND et.provider = 'tmdb'
                )
                AND NOT EXISTS (
                    SELECT 1 FROM external_ids ef
                    WHERE ef.media_id = mi.id AND ef.source = 'fribb-anime-lists'
                )
            )::int AS remaining,
            COUNT(*) FILTER (
                WHERE NOT EXISTS (
                    SELECT 1 FROM external_ids et
                    WHERE et.media_id = mi.id AND et.provider = 'tmdb'
                )
            )::int AS ineligible
        FROM media_items mi
        WHERE mi.status = 'active'
          AND mi.media_type IN ${sql(SUPPORTED_TYPES)}
    `;
    return {
        analyzed: row?.analyzed ?? 0,
        remaining: row?.remaining ?? 0,
        ineligible: row?.ineligible ?? 0,
    };
}

async function fetchCandidates(
    sql: postgres.Sql,
    limit: number,
    isForce: boolean,
    afterId?: string,
): Promise<CandidateRow[]> {
    if (isForce) {
        if (afterId) {
            return sql<CandidateRow[]>`
                SELECT mi.id AS media_id, mi.media_type, ei.external_id AS tmdb_id
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
                WHERE mi.status = 'active'
                  AND mi.media_type IN ${sql(SUPPORTED_TYPES)}
                  AND mi.id > ${afterId}::uuid
                ORDER BY mi.id ASC
                LIMIT ${limit}
            `;
        }
        return sql<CandidateRow[]>`
            SELECT mi.id AS media_id, mi.media_type, ei.external_id AS tmdb_id
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.status = 'active'
              AND mi.media_type IN ${sql(SUPPORTED_TYPES)}
            ORDER BY mi.id ASC
            LIMIT ${limit}
        `;
    }
    if (afterId) {
        return sql<CandidateRow[]>`
            SELECT mi.id AS media_id, mi.media_type, ei.external_id AS tmdb_id
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
            WHERE mi.status = 'active'
              AND mi.media_type IN ${sql(SUPPORTED_TYPES)}
              AND mi.id > ${afterId}::uuid
              AND NOT EXISTS (
                  SELECT 1 FROM external_ids ef
                  WHERE ef.media_id = mi.id AND ef.source = 'fribb-anime-lists'
              )
            ORDER BY mi.id ASC
            LIMIT ${limit}
        `;
    }
    return sql<CandidateRow[]>`
        SELECT mi.id AS media_id, mi.media_type, ei.external_id AS tmdb_id
        FROM media_items mi
        JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'tmdb'
        WHERE mi.status = 'active'
          AND mi.media_type IN ${sql(SUPPORTED_TYPES)}
          AND NOT EXISTS (
              SELECT 1 FROM external_ids ef
              WHERE ef.media_id = mi.id AND ef.source = 'fribb-anime-lists'
          )
        ORDER BY mi.id ASC
        LIMIT ${limit}
    `;
}

/**
 * Coverage-table backlog for fribb-anime-sync.
 *
 * Returns series that have a retriable stage state row and still have a TMDB
 * external ID available (required for Fribb lookup).  Result shape is
 * identical to `fetchCandidates` so callers can swap the fetch without
 * changing the process-slice logic.
 */
async function findCoverageTableBacklog(sql: postgres.Sql, limit: number): Promise<CandidateRow[]> {
    return sql<CandidateRow[]>`
        SELECT mi.id AS media_id, mi.media_type, ei.external_id AS tmdb_id
        FROM media_item_stage_state miss
        JOIN media_items mi ON mi.id = miss.media_item_id
        JOIN external_ids ei
            ON ei.media_id = mi.id
           AND ei.provider = 'tmdb'
        WHERE miss.stage_id = 'fribb-anime-sync'
          AND miss.status IN ('pending', 'failed_transient', 'obsolete', 'skipped_transient')
          AND (miss.next_eligible_at IS NULL OR miss.next_eligible_at <= now())
        ORDER BY miss.next_eligible_at ASC NULLS FIRST, miss.updated_at ASC, mi.id ASC
        LIMIT ${limit}
    `;
}

async function wipeAnimeIds(sql: postgres.Sql): Promise<void> {
    // external_ids removal routed through CatalogService (composite-key
    // ownership). Lifecycle hooks are skipped — a force-mode wipe re-enrolls
    // every affected item on the same drain pass.
    const { CatalogService } = await import('../../../services/catalog.service.js');
    const catalog = new CatalogService(sql, { skipLifecycleHooks: true });
    await catalog.deleteExternalIdsByProviderSource(['mal', 'anilist'], 'fribb-anime-lists');
}

// ============================================================================
// Settings helpers
// ============================================================================

async function initializeSettings(): Promise<void> {
    // The legacy `config-loader.getFileConfig` (file-backed per-plugin JSON
    // overrides) was retired with the rest of the legacy plugin runtime.
    // Read the optional env override directly here; SDK natives that need
    // runtime-mutable settings should use `ctx.settings()` instead.
    const envOverride = process.env.LUMASTRA_PLUGIN_FRIBB_ANIME_SYNC_DATA_URL;
    if (envOverride && envOverride.trim()) {
        _dataUrl = envOverride.trim();
    }
}

// ============================================================================
// Task definition
// ============================================================================

const inputSchema = z.object({}).passthrough();

type FribbAnimeSyncInput = Record<string, unknown>;

interface FribbAnimeSyncResult {
    enriched: number;
    skipped: number;
    errors: number;
    message: string;
}

export const fribbAnimeSyncTask = defineTask<FribbAnimeSyncInput, FribbAnimeSyncResult>({
    id: 'fribb-anime-sync',
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'Fribb Anime ID Sync',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, http: true },

    // 2026-05-24: dropped 168h → 48h (3.5× more runs/week). Combined with
    // SLICE_SIZE bump 500→2000 yields ~7k items/week (vs 500/week previously)
    // and drains an 8k backlog in ~4 days. fribb is light-weight (cached
    // dataset + DB upserts) so the extra cadence is essentially free at
    // steady state when there's nothing to enrich.
    schedule: {
        every: '48h',
        runOnStartup: false,
    },
    feedsInto: ['mal-anime-id-enrichment'],

    // MODE-INDEPENDENT, and paired with exclusiveWith below — see
    // music-popularity.ts for the long form. The orchestrator's SETNX mutex key
    // is `identityKey(taskId, identityFor(input))`, so exclusiveWith inherits
    // whatever this returns: a mode-suffixed identity would hand catchup,
    // manual and force each their own key and collapse only same-mode re-fires.
    // catchup, manual and force are the same work at different depths here, so
    // single-flight across all three is the correct semantics.
    identityFor: () => 'global',
    scope: 'global',
    // Singleton guard. `force` drops the cached anime ID mappings, and without this it could run
    // CONCURRENTLY with an in-flight catchup or manual pass — deleting rows
    // that pass is mid-write. The derived data is recomputable, so the damage
    // is wasted work and a transient hole rather than permanent loss, but the
    // wipe racing its own writer is not a state worth allowing. ttl >= the
    // task's hard timeout, per the SDK rule.
    exclusiveWith: { scope: 'global', ttl: '40m' },
    // Mass-enrichment — anime ID database sync, API-bound.
    resourceClass: 'bulk',
    // Honours `{ mode: 'manual' }` — drains the whole backlog in one
    // run instead of the single batch a scheduled catchup cycle does.
    supportsFullRun: true,
    // Drops the cached anime ID mappings and reloads them from the Fribb list.
    supportsForceRun: true,

    inputSchema,

    coversStages: [
        {
            id: 'fribb-anime-sync',
            // BUG 5 fix: was ['series'] only, but the task processes movies too
            // (SUPPORTED_TYPES = ['movie', 'tv'] above; the disambiguate()
            // logic explicitly branches on Fribb type === 'Movie'). With
            // 'movie' missing here, coverage rows were never seeded for anime
            // movies, so any non-force drain (which sources candidates from
            // findCoverageTableBacklog when this stage is authoritative)
            // permanently skipped them — invisible in the backlog, never
            // enqueued by stage-sweep. 'movie'/'series' is the SDK-canonical
            // vocabulary (SdkMediaType) — NOT 'tv', which is only the
            // media_items.media_type column's storage convention.
            appliesTo: ['movie', 'series'] as const,
            invalidatedBy: ['identity.assigned', 'identity.changed', 'identity.cleared'] as const,
            // Opt the stage into stage-sweep enqueue so its pending rows are
            // driven to a terminal status each cycle instead of wedging.
            enqueueable: true,
            // Domain: only series that have a TMDB external_id can ever be
            // Fribb-matched (the dataset is keyed by themoviedb_id). The
            // framework eligibility dispose pass tombstones any series without
            // one; an identity event re-eligibilizes it.
            //
            // `DISABLE_FRIBB_ANIME_SYNC` is part of eligibility too (same pattern as
            // trickplay-generation's TRICKPLAY_ENABLED). execute() early-returns
            // while the flag is set and the task is global-identity, so nothing
            // ever wrote these rows: on preprod (2026-10-07) 70 rows sat `pending`
            // since August, stage-sweep found them every tick, enqueued nothing and
            // backed off, and the admin UI showed a backlog that could never drain.
            // The flag is a live getter read inside the builder, so no event or
            // restart is needed. Disabling takes effect on the next sweep tick
            // (the dispose runs every tick). Re-enabling can take up to
            // PER_STAGE_HEAL_QUIET_MS (15 min): the heal goes quiet after a tick
            // that reclaimed nothing, which is every tick while the flag is set.
            eligibility: {
                sql: (sql) =>
                    sql`${config.DISABLE_FRIBB_ANIME_SYNC ? sql`false` : sql`true`} AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.provider = 'tmdb')`,
                // Reclaim rows that were previously tombstoned by the old
                // predicate disposition under the legacy reason string, and the
                // rows the disabled predicate below stamps once the task is
                // switched back on.
                recoverWhenAdditionalReasons: ['fribb:no-tmdb-id', FRIBB_DISABLED_REASON],
            },
            terminalDisposition: [
                // Switched off by the operator (or a use-case preset). A
                // predicate, not a global-guard: a guard drains to
                // `skipped_transient`, which progress counts as REMAINING, while a
                // switched-off task is "not applicable to this install". Runs
                // before the eligibility dispose, so rows carry this reason rather
                // than the generic 'ineligible'; the heal reclaims it (listed
                // above) the moment the flag is cleared.
                {
                    kind: 'predicate',
                    ruleId: 'fribb-anime-sync-enabled',
                    disposeAs: 'skipped_permanent',
                    reason: FRIBB_DISABLED_REASON,
                    excludes: (sql) => (config.DISABLE_FRIBB_ANIME_SYNC ? sql`true` : sql`false`),
                },
                // Everything else: the task itself guarantees a terminal write on
                // every TMDB-bearing candidate (success → completed; all 6
                // no-match branches → skipped_permanent via the inline tombstone).
                // Wedge-guard Invariant 2 observes the guarantee at runtime.
                {
                    kind: 'self-terminal',
                    ruleId: 'fribb-writes-every-tmdb-candidate',
                },
            ],
        },
    ],

    settings: {
        fields: [
            {
                key: 'dataUrl',
                type: 'string',
                label: 'Data URL',
                description:
                    'URL to the anime-list-full.json file. ' +
                    'Useful for pointing at a local mirror or a pinned commit. ' +
                    'Leave empty to use the official Fribb GitHub source.',
                default: FRIBB_URL,
            },
        ],
    },

    timeout: { hard: '30m', soft: '25m' },

    backlog: {
        unitLabel: 'anime',
        sliceSize: 1,
        softBudget: '1s',
        idOf: (row): string => {
            const r = row as { id?: unknown } | null | undefined;
            return r && typeof r.id === 'string' ? r.id : String(r);
        },
        async stages(ctx: TaskContext): Promise<BacklogStage[]> {
            const status = await countBacklog(ctx.sql);
            const stages: BacklogStage[] = [];
            if (status.remaining > 0) {
                stages.push({
                    id: 'remaining',
                    label: 'Remaining',
                    count: status.remaining,
                });
            }
            if (status.ineligible > 0) {
                stages.push({
                    id: 'ineligible',
                    label: 'Ineligible',
                    count: status.ineligible,
                });
            }
            return stages;
        },
        async wipe(ctx: TaskContext): Promise<void> {
            await wipeAnimeIds(ctx.sql);
        },
        async compute(): Promise<{ items: unknown[]; remainingHint?: number }> {
            return { items: [], remainingHint: 0 };
        },
    },

    async execute(ctx) {
        const { logger, signal } = ctx;
        if (!ctx.http) throw new Error('fribb-anime-sync: http capability required');
        const http = ctx.http;

        if (config.DISABLE_FRIBB_ANIME_SYNC) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    enriched: 0,
                    skipped: 0,
                    errors: 0,
                    message: 'fribb-anime-sync disabled via DISABLE_FRIBB_ANIME_SYNC',
                },
            };
        }

        await initializeSettings();

        const rawInput = (ctx.input as Record<string, unknown> | undefined) ?? {};
        const mode = typeof rawInput.mode === 'string' ? rawInput.mode : 'catchup';

        const {
            resolveDrainMode,
            drainBacklog,
            lazyBacklog,
            computeRemainingHint,
            formatStopReason,
            isAbortedStop,
        } = await import('../../../plugins/runtime/drain-backlog.js');

        const { CatalogService } = await import('../../../services/catalog.service.js');

        const drainMode = resolveDrainMode(
            mode,
            logger as unknown as Parameters<typeof resolveDrainMode>[1],
        );
        const isForce = drainMode === 'force';

        let enriched = 0;
        let skipped = 0;
        let errors = 0;
        let processed = 0;
        let afterId: string | undefined;

        const useCoverageTable = getAuthoritativeStageIds().has('fribb-anime-sync');

        // Nothing to match → don't download the dataset. Without this an empty
        // install (before setup, or with no TMDB-identified movies or shows)
        // fetched the full list from GitHub every 48h for no reason. The probe is
        // the drain's own first fetch, so it can't disagree with it.
        const probe =
            useCoverageTable && !isForce
                ? await findCoverageTableBacklog(ctx.sql, 1)
                : await fetchCandidates(ctx.sql, 1, isForce);
        if (probe.length === 0) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    enriched: 0,
                    skipped: 0,
                    errors: 0,
                    message: 'No movies or shows to match — Fribb dataset not downloaded',
                },
            };
        }

        // loadFribbData is the task's SINGLE external dependency. A raw Error
        // thrown from here (fetch failed, non-2xx, malformed payload) would leave
        // execute() only classifiable by the generic infra fallback — inconsistent
        // with the explicit transient TaskError this family raises for every other
        // failure mode (total-write-failure below). Wrap it so a dataset-load
        // failure is retriable and visible to the circuit breaker. An abort is not
        // a failure — let it propagate untouched so the runner records it as such.
        let entries: FribbEntry[];
        try {
            // The GitHub-raw Fribb list fetch is this task's only external request;
            // the drain matches items against it in-memory. Count it on the cost page.
            entries = await withApiCallSpend(ctx, () => loadFribbData(http, signal));
        } catch (err) {
            if (signal?.aborted) throw err;
            throw new TaskError({
                message:
                    `fribb-anime-sync: failed to load the Fribb dataset (the task's sole ` +
                    `external dependency): ${err instanceof Error ? err.message : String(err)}`,
                kind: 'transient',
                cause: err,
            });
        }
        logger.info(`Loaded ${entries.length} Fribb entries`);

        const lookup = buildTmdbLookup(entries);
        logger.info(`TMDB lookup map: ${lookup.size} unique TMDB IDs`);
        const imdbLookup = buildImdbLookup(entries);
        logger.info(`IMDb fallback map: ${imdbLookup.size} unique IMDb IDs`);

        const catalogService = new CatalogService(ctx.sql, {
            skipLifecycleHooks: true,
        });

        const snapshot = lazyBacklog(() => countBacklog(ctx.sql).then((s) => s.remaining));

        const result = await drainBacklog<CandidateRow>(
            { logger, abortSignal: signal },
            {
                mode: drainMode,
                // The drain's own default budget is 110 min, but this task is
                // killed by the run watchdog at timeout.hard (30m) — a manual
                // drain would be marked FAILED mid-slice instead of stopping
                // cleanly. Finish under that cap so the run ends as
                // stopReason 'budget' and the remainder rolls to the next catchup.
                softBudgetMs: 25 * 60 * 1000,
                sliceSize: SLICE_SIZE,
                onWipe: isForce ? () => wipeAnimeIds(ctx.sql) : undefined,
                idOf: (row) => row.media_id,
                fetchSlice: async (limit) => {
                    const items =
                        useCoverageTable && !isForce
                            ? await findCoverageTableBacklog(ctx.sql, limit)
                            : await fetchCandidates(ctx.sql, limit, isForce, afterId);
                    const initial = await snapshot();
                    return {
                        items,
                        remainingHint: computeRemainingHint(initial, processed, items.length),
                    };
                },
                processSlice: async (slice, sliceSignal) => {
                    let enrichedThisSlice = 0;

                    // Tombstone the stage row when an item is determined not to
                    // be enrichable by this task. Without this the row sits in
                    // `pending` on every future run, gets re-fetched every slice,
                    // and keeps the dormant-stage health invariant red even
                    // though the task is succeeding. Only fires when the
                    // coverage table is the source of truth so we don't write to
                    // a non-existent stage row in legacy/force modes.
                    const tombstone = async (mediaId: string, reason: string): Promise<void> => {
                        if (!useCoverageTable) return;
                        try {
                            await upsertSkippedPermanentRow(ctx.sql, {
                                mediaItemId: mediaId,
                                stageId: 'fribb-anime-sync',
                                processingVersion: 1,
                                skippedReason: reason,
                            });
                        } catch (err) {
                            logger.warn('Failed to write skipped_permanent stage row', {
                                mediaId,
                                reason,
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    };

                    // Batch-fetch imdb ids for this slice up front — the IMDb
                    // fallback below (for movies Fribb files under the parent
                    // TV series' tmdb) needs them, and one query per slice beats
                    // one per item. Best-effort: on failure, fall back to
                    // tmdb-only matching for this slice.
                    const imdbByMedia = new Map<string, string>();
                    const sliceMediaIds = slice.map((s) => s.media_id);
                    if (sliceMediaIds.length > 0) {
                        try {
                            const imdbRows = await ctx.sql<
                                { media_id: string; external_id: string }[]
                            >`
                                SELECT media_id, external_id
                                FROM external_ids
                                WHERE provider = 'imdb'
                                  AND media_id = ANY(${sliceMediaIds}::uuid[])
                            `;
                            for (const r of imdbRows) {
                                if (!imdbByMedia.has(r.media_id)) {
                                    imdbByMedia.set(r.media_id, r.external_id);
                                }
                            }
                        } catch (err) {
                            logger.warn('fribb: imdb-fallback batch fetch failed', {
                                error: err instanceof Error ? err.message : String(err),
                            });
                        }
                    }

                    for (const item of slice) {
                        if (sliceSignal.aborted) break;

                        const tmdbId = parseInt(item.tmdb_id, 10);
                        if (!Number.isFinite(tmdbId) || tmdbId <= 0) {
                            skipped++;
                            await tombstone(item.media_id, 'invalid-tmdb-id');
                            continue;
                        }

                        // Resolve the media type BEFORE the Fribb lookup: the
                        // lookup is keyed by (media type, tmdb id) so a library
                        // movie only matches Fribb `movie` ids and a series only
                        // `tv` ids (the id's bucket carries the type).
                        const raw = item.media_type as string | null | undefined;
                        if (!raw) {
                            skipped++;
                            await tombstone(item.media_id, 'missing-media-type');
                            continue;
                        }
                        if (!isMovie(raw) && !isSeries(raw)) {
                            skipped++;
                            await tombstone(item.media_id, 'unsupported-media-type');
                            continue;
                        }
                        const mediaType = (isMovie(raw) ? 'movie' : 'tv') as 'movie' | 'tv';

                        // Primary: match by (media type, tmdb id) bucket.
                        const tmdbCandidates = lookupFribbEntries(lookup, mediaType, tmdbId);
                        let match =
                            tmdbCandidates.length > 0
                                ? disambiguate(tmdbCandidates, mediaType)
                                : null;

                        // IMDb fallback: Fribb sometimes files an anime MOVIE's
                        // tmdb under its parent TV series' `tv` bucket (not the
                        // movie's own tmdb), so the tmdb-bucket lookup misses
                        // (e.g. End of Evangelion, No Game No Life: Zero). Fribb
                        // still carries the correct imdb_id and the library item
                        // has an imdb id — match on that.
                        if (!match) {
                            const imdbId = imdbByMedia.get(item.media_id);
                            if (imdbId) {
                                const imdbCandidates = imdbLookup.get(imdbId) ?? [];
                                if (imdbCandidates.length > 0) {
                                    match = disambiguate(imdbCandidates, mediaType);
                                }
                            }
                        }

                        if (!match) {
                            skipped++;
                            await tombstone(
                                item.media_id,
                                tmdbCandidates.length === 0
                                    ? 'not-in-fribb-dataset'
                                    : 'no-fribb-match-after-disambiguation',
                            );
                            continue;
                        }

                        let wrote = false;
                        // A provider id already owned by ANOTHER media item is durable:
                        // (provider, external_id, media_type) is UNIQUE, so no amount of
                        // retrying takes it. Counting it as a write error meant the item
                        // stayed a candidate, was re-selected on the next slice, threw
                        // again, and the run ended "0 enriched with N write error(s)" ->
                        // TaskError -> circuit breaker. On prod that reached 413,590
                        // errors in one five-minute run and opened the breaker, starving
                        // every healthy candidate behind it. Real case: two chapters of
                        // one film both mapped to mal:52107.
                        //
                        // Tombstone instead. Deliberately NOT added to
                        // recoverWhenAdditionalReasons: eligibility.sql is already TRUE
                        // while this holds (the item has a mal id and anime genres), so
                        // listing it would hot-loop exactly as the 'mal:no-chain' note
                        // explains. Recovery rides the identity.* events this stage
                        // subscribes to — whenever either item's id actually changes.
                        // NOTE the shape: this records the conflict and reports
                        // "handled", but the caller must NOT `continue` on it. Doing so
                        // (a) skipped the AniList upsert when only the MAL id was taken
                        // — losing an enrichment whose AniList id was free — and (b)
                        // when MAL had already succeeded, jumped past the `wrote`
                        // completion block, stamping a genuinely-enriched item
                        // skipped_permanent. Both writes are attempted; the tombstone is
                        // applied at the end, and only if nothing was written.
                        let conflicted: string | null = null;
                        const noteConflict = (err: unknown, which: string): boolean => {
                            if (err instanceof ExternalIdOwnedByAnotherItemError) {
                                logger.info(`${which} id owned by another item`, {
                                    mediaId: item.media_id,
                                    tmdbId,
                                    ownerMediaId: err.ownerMediaId,
                                });
                                conflicted = which.toLowerCase();
                                return true;
                            }
                            return false;
                        };

                        if (match.mal_id != null) {
                            try {
                                // `wrote` follows the RETURN value, not merely the
                                // absence of a throw: the convergence guard skips the
                                // write silently, and counting that as enrichment
                                // reported items as enriched whose id we never stored.
                                if (
                                    await catalogService.upsertExternalId(item.media_id, {
                                        provider: 'mal',
                                        id: String(match.mal_id),
                                        mediaType,
                                        source: 'fribb-anime-lists',
                                    })
                                ) {
                                    wrote = true;
                                }
                            } catch (err) {
                                // A durable ownership conflict is NOT a write error:
                                // it must not fail the run, and it must not abandon the
                                // other provider's write. Fall through to the next
                                // statement either way — no break (that would end the
                                // whole slice) and no continue (that skipped the other
                                // id and the completion block).
                                if (!noteConflict(err, 'MAL')) {
                                    errors++;
                                    logger.warn('Failed to upsert MAL ID', {
                                        mediaId: item.media_id,
                                        tmdbId,
                                        error: err instanceof Error ? err.message : String(err),
                                    });
                                }
                            }
                        }
                        if (match.anilist_id != null) {
                            try {
                                if (
                                    await catalogService.upsertExternalId(item.media_id, {
                                        provider: 'anilist',
                                        id: String(match.anilist_id),
                                        mediaType,
                                        source: 'fribb-anime-lists',
                                    })
                                ) {
                                    wrote = true;
                                }
                            } catch (err) {
                                // A durable ownership conflict is NOT a write error:
                                // it must not fail the run, and it must not abandon the
                                // other provider's write. Fall through to the next
                                // statement either way — no break (that would end the
                                // whole slice) and no continue (that skipped the other
                                // id and the completion block).
                                if (!noteConflict(err, 'AniList')) {
                                    errors++;
                                    logger.warn('Failed to upsert AniList ID', {
                                        mediaId: item.media_id,
                                        tmdbId,
                                        error: err instanceof Error ? err.message : String(err),
                                    });
                                }
                            }
                        }
                        // Tombstone ONLY when the conflict left nothing written. If one
                        // provider's id was taken but the other landed, the item IS
                        // enriched and must complete normally — writing it off would
                        // discard real coverage.
                        if (conflicted && !wrote) {
                            await tombstone(item.media_id, 'mal:id-owned-by-another-item');
                            continue;
                        }
                        if (wrote) {
                            enriched++;
                            enrichedThisSlice++;
                            try {
                                await upsertCompletedRow(ctx.sql, {
                                    mediaItemId: item.media_id,
                                    stageId: 'fribb-anime-sync',
                                    processingVersion: 1,
                                });
                            } catch {
                                // Non-fatal — coverage write failure must not abort sync
                            }
                        } else if (match.mal_id == null && match.anilist_id == null) {
                            // Disambiguated to a Fribb entry that carries neither a
                            // MAL nor an AniList id — nothing to write. Tombstone it
                            // or the coverage backlog re-selects it every run (the
                            // 6th wedge branch; the other five tombstone above).
                            skipped++;
                            await tombstone(item.media_id, 'fribb-match-no-mal-anilist-id');
                        }
                    }

                    processed += slice.length;
                    afterId = slice[slice.length - 1]?.media_id;
                    return {
                        produced: enrichedThisSlice,
                        advanced: slice.length,
                    };
                },
                onProgress: (p, t, meta) => {
                    ctx.reportProgress(p, t, meta?.currentItem);
                },
                phase: 'Enriching anime with MAL/AniList IDs',
                heartbeat: {
                    getTotal: () => snapshot.peek(),
                    getProcessed: () => processed,
                    getStatus: () =>
                        `Enriching anime... (${enriched} enriched, ${skipped} skipped)`,
                },
            },
        );

        const noneProcessed = enriched + skipped + errors === 0;
        const suffix = formatStopReason(result.stopReason);
        const message = noneProcessed
            ? result.stopReason === 'drained' || result.stopReason === 'single-slice'
                ? 'No anime items need MAL/AniList ID enrichment'
                : `No items processed${suffix}`
            : `Enriched ${enriched} anime items with MAL/AniList IDs (${skipped} skipped, ${errors} errors)${suffix}`;

        logger.info(message);

        // Monitoring-blindness guard: if the run made write attempts and EVERY one
        // failed (enriched === 0 while errors > 0), that's a total failure, not
        // "nothing to do". A returned success:false would be invisible — the runner
        // records a returned result as a COMPLETED run and reports SUCCESS to the
        // circuit breaker. Throw a transient TaskError instead so the run is marked
        // failed, retried, and the breaker can trip. Genuine no-work (enriched === 0,
        // errors === 0 — everything skipped/tombstoned or empty backlog) and partial
        // success (enriched > 0) stay success. Aborts are handled by the return below.
        if (!isAbortedStop(result.stopReason) && enriched === 0 && errors > 0) {
            throw new TaskError({
                message:
                    `fribb-anime-sync: total failure — 0 enriched with ${errors} ` +
                    `write error(s) and no successful writes.`,
                kind: 'transient',
            });
        }

        return {
            success: !isAbortedStop(result.stopReason) && (errors === 0 || enriched > 0),
            itemsProcessed: enriched,
            stopReason: isAbortedStop(result.stopReason) ? 'aborted' : undefined,
            result: {
                enriched,
                skipped,
                errors,
                message,
            },
        };
    },
});

registry.registerTask(fribbAnimeSyncTask);
