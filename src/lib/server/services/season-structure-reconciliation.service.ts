// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Season-Structure Reconciliation
 *
 * Fixes the TVDB-vs-TMDB season-split mismatch: release tools (Sonarr) name
 * files by one provider's season structure (typically TVDB), while metadata
 * sync uses TMDB's canonical structure. When the two disagree (e.g. TMDB has
 * one 50-episode season, disk has 2×25), the scanner creates file-backed
 * episode rows at positions TMDB doesn't know — they stay metadata-blind —
 * while metadata sync creates file-less "ghost" rows at TMDB's canonical
 * positions.
 *
 * The fix is driven by provider episode groups (TMDB's episode-groups API
 * usually carries the TVDB-style split): find a group whose
 * (group index → season, order position → episode) mapping covers every
 * unmatched file-backed episode WITHOUT contradicting any TMDB id already
 * bound to a file-backed row, then:
 *   1. bind identity onto the file rows (external_id, title, overview, still,
 *      title_binding='identity') — same write shape as episode reconciliation,
 *   2. merge the file-less ghost rows that held those TMDB ids into their
 *      successors (user state migrates), then delete seasons left empty,
 *   3. relocate the ghosts nothing bound — group positions with no local file,
 *      e.g. a still-airing tail — to the season/episode the group implies,
 *      so they stop showing up under the provider's flat canonical numbering,
 *   4. store the group as the series' active ordering (source 'auto').
 *
 * Binding and ghost merge of one episode are one unit of work: they commit
 * together inside the per-series advisory-lock transaction, behind a savepoint,
 * with an undo record (episode_reconciliation_moves). Lifecycle hooks run after
 * the commit.
 *
 * File-backed episodes keep their local season/episode numbers and parents —
 * display stays consistent with disk/Sonarr/Jellyfin. Detection is conservative:
 * a group is only auto-applied when it covers all unmatched episodes and
 * either agrees with at least one existing binding or matches the local
 * file-backed season structure exactly.
 */

import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import type postgres from 'postgres';
import { inSavepoint, withTx } from '$lib/server/database/with-tx.js';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import type { ExternalIdWrite } from '$lib/server/providers/provider-types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { upsertProviderMetadataUnlessLocked } from '$lib/server/database/queries/media-upsert.js';
import {
    insertReconciliationMove,
    loadBlockedPairKeys,
    reconciliationPairKey,
    RECONCILIATION_QUARANTINE_PROVIDER,
} from '$lib/server/database/queries/episode-reconciliation-moves.queries.js';
import {
    getEpisodeGroupProvider,
    type EpisodeGroupDetails,
    type EpisodeGroupSummary,
} from '$lib/server/providers/episode-group-provider.js';
import {
    getSeriesOrdering,
    resolveTmdbIdFromMediaId,
} from '$lib/server/database/queries/episode-orderings.queries.js';
import {
    getEpisodeOrderingService,
    ensureEpisodeGroupProvidersRegistered,
    type EpisodeOrderingType,
} from '$lib/server/services/episode-ordering.service.js';
import {
    loadTmdbCatalog,
    type TmdbCatalogEpisode,
} from '$lib/server/services/episode-reconciliation.service.js';

const logger = Logger.for('SeasonStructureReconciliation');

// =============================================================================
// Types
// =============================================================================

export interface SeasonStructureBinding {
    /** Local file-backed episode (media_items.id) that lacks a TMDB identity */
    episodeId: string;
    /** Local (disk) numbering */
    seasonNumber: number;
    episodeNumber: number;
    /** TMDB episode the group mapping resolves this position to */
    tmdbEpisodeId: string;
    /** Provider's canonical position of that episode */
    originalSeasonNumber: number;
    originalEpisodeNumber: number;
    /** Episode name from the group payload (fallback when catalog misses it) */
    groupEpisodeName: string | null;
}

/**
 * A canonical (file-less) row whose TMDB id the group maps to a position no
 * local file occupies — e.g. the not-yet-downloaded tail of the last bucket.
 * It stays unavailable, but must sit at the position the group implies instead
 * of the provider's flat canonical one (Re:Zero: S4E12-19, not S1E78-85).
 */
export interface SeasonStructureRelocation {
    tmdbEpisodeId: string;
    targetSeasonNumber: number;
    targetEpisodeNumber: number;
}

export interface SeasonStructureDetection {
    seriesMediaId: string;
    provider: string;
    groupId: string;
    groupName: string;
    orderingType: EpisodeOrderingType;
    bindings: SeasonStructureBinding[];
    /** Group positions with no local file — ghosts to move, never to bind */
    relocations: SeasonStructureRelocation[];
    /** File-backed episodes whose existing TMDB id the group mapping confirmed */
    agreements: number;
    /** Group structure exactly equals the local file-backed season structure */
    exactStructure: boolean;
    /**
     * Group bucket numbering matches what syncOrderings would produce (no
     * specials/empty buckets were filtered) — only then may the group be
     * activated as the display ordering.
     */
    orderingConsistent: boolean;
}

export interface SeasonStructureApplyResult {
    bound: number;
    skipped: number;
    ghostsDeleted: number;
    /** File-less canonical rows moved to their group-implied season/episode */
    ghostsRelocated: number;
    emptySeasonsDeleted: number;
    orderingApplied: boolean;
}

/**
 * Dependency overrides, primarily for tests: inject a registered mock group
 * provider and a preloaded canonical catalog instead of hitting TMDB.
 */
export interface SeasonStructureDeps {
    /** Episode-group provider id in the registry (default 'tmdb') */
    provider?: string;
    /** Provider-specific series id for group listing (default: resolved TMDB id) */
    seriesExternalId?: string;
    /** Preloaded canonical episode catalog (default: loadTmdbCatalog) */
    catalog?: TmdbCatalogEpisode[];
    /** Cooperative cancellation (checked between provider calls / phases) */
    signal?: AbortSignal;
}

interface LocalEpisodeRow {
    id: string;
    season_number: number;
    episode_number: number;
    title_binding: string | null;
    metadata_locked: boolean;
    tmdb_id: string | null;
}

// =============================================================================
// Detection
// =============================================================================

/** File-backed episodes of a series with their current tmdb episode binding. */
async function loadFileBackedEpisodes(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<LocalEpisodeRow[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by a specific series UUID; not user-facing
    return await sql<LocalEpisodeRow[]>`
        SELECT mi.id, mi.season_number, mi.episode_number, mi.title_binding,
               mi.metadata_locked, ei.external_id AS tmdb_id
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE season.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND mi.has_files = true
          AND mi.season_number > 0
          AND mi.episode_number IS NOT NULL
    `;
}

interface GroupPositionEntry {
    tmdbEpisodeId: string;
    originalSeasonNumber: number;
    originalEpisodeNumber: number;
    name: string | null;
    /** Position the group itself implies (bucket index + 1, order + 1) */
    groupSeasonNumber: number;
    groupEpisodeNumber: number;
}

/**
 * Positional view of a group: (group index + 1) is the season, (order + 1) the
 * episode — identical to how syncOrderings derives order_season/episode_number,
 * so ordering rows and bindings stay consistent.
 */
function buildGroupPositionMap(details: EpisodeGroupDetails): {
    positions: Map<string, GroupPositionEntry>;
    seasonCounts: number[];
    /** true when buckets were skipped — numbering then DIVERGES from syncOrderings */
    filteredBuckets: boolean;
} {
    const positions = new Map<string, GroupPositionEntry>();
    const seasonCounts: number[] = [];
    // Skip empty buckets and pure-specials buckets (all original season 0):
    // local detection only considers season_number > 0, so counting them here
    // would shift every subsequent bucket's season number by one and misbind.
    // NOTE: syncOrderings numbers ALL buckets — when this filter drops any,
    // the group's order_season_numbers won't line up with local seasons, so
    // the caller must NOT activate such a group as the display ordering.
    const sortedSeasons = [...details.seasons]
        .filter((s) => s.episodes.length > 0 && s.episodes.some((ep) => ep.seasonNumber !== 0))
        .sort((a, b) => a.order - b.order);
    const filteredBuckets = sortedSeasons.length !== details.seasons.length;
    for (let seasonIdx = 0; seasonIdx < sortedSeasons.length; seasonIdx++) {
        const groupSeasonNumber = seasonIdx + 1;
        const sortedEpisodes = [...sortedSeasons[seasonIdx].episodes].sort(
            (a, b) => a.order - b.order,
        );
        seasonCounts.push(sortedEpisodes.length);
        for (const ep of sortedEpisodes) {
            positions.set(`${groupSeasonNumber}:${ep.order + 1}`, {
                tmdbEpisodeId: String(ep.id),
                originalSeasonNumber: ep.seasonNumber,
                originalEpisodeNumber: ep.episodeNumber,
                name: ep.name ?? null,
                groupSeasonNumber,
                groupEpisodeNumber: ep.order + 1,
            });
        }
    }
    return { positions, seasonCounts, filteredBuckets };
}

/**
 * Detect a season-structure mismatch and the episode group that resolves it.
 * Returns null when there is nothing to fix, when the admin set a manual
 * ordering, or when no group passes the safety gates.
 */
export async function detectSeasonStructureFix(
    sql: postgres.Sql,
    seriesMediaId: string,
    deps: SeasonStructureDeps = {},
): Promise<SeasonStructureDetection | null> {
    // Respect an explicit admin choice unconditionally.
    const existingOrdering = await getSeriesOrdering(sql, seriesMediaId);
    if (existingOrdering?.ordering_source === 'manual') {
        return null;
    }

    const localEpisodes = await loadFileBackedEpisodes(sql, seriesMediaId);
    const unmatched = localEpisodes.filter((e) => e.tmdb_id === null);
    if (unmatched.length === 0) {
        return null;
    }

    // Local file-backed structure: season → episode count, plus id lookups.
    const localSeasonCounts = new Map<number, number>();
    const boundByPosition = new Map<string, string>(); // "s:e" → tmdb id
    const fileBackedTmdbIds = new Set<string>();
    for (const ep of localEpisodes) {
        localSeasonCounts.set(ep.season_number, (localSeasonCounts.get(ep.season_number) ?? 0) + 1);
        if (ep.tmdb_id) {
            boundByPosition.set(`${ep.season_number}:${ep.episode_number}`, ep.tmdb_id);
            fileBackedTmdbIds.add(ep.tmdb_id);
        }
    }
    const localSeasonsSorted = [...localSeasonCounts.entries()].sort(([a], [b]) => a - b);

    // Only fixable rows become bindings; locked/manual rows are left alone and
    // don't block detection (they can't be corrected anyway). Checked BEFORE
    // any provider call so a locked-only series doesn't burn API quota on
    // every sync.
    const fixable = unmatched.filter((e) => !e.metadata_locked && e.title_binding !== 'manual');
    if (fixable.length === 0) {
        return null;
    }

    const providerId = deps.provider ?? 'tmdb';
    // Built-in provider registration is lazy (first EpisodeOrderingService
    // construction). In a fresh process nothing may have constructed it yet —
    // without this the registry lookup below silently returns undefined and
    // detection reports "nothing found" (bit us on prod, 2026-07-10).
    ensureEpisodeGroupProvidersRegistered();
    const groupProvider = getEpisodeGroupProvider(providerId);
    if (!groupProvider) {
        logger.warn('Episode group provider not registered', { providerId, seriesMediaId });
        return null;
    }

    let seriesExternalId = deps.seriesExternalId;
    if (!seriesExternalId && providerId === 'tmdb') {
        const tmdbId = await resolveTmdbIdFromMediaId(sql, seriesMediaId);
        if (tmdbId) seriesExternalId = String(tmdbId);
    }
    if (!seriesExternalId) {
        return null;
    }

    let groups: EpisodeGroupSummary[];
    try {
        groups = await groupProvider.getEpisodeGroups(seriesExternalId);
    } catch (err) {
        logger.warn('Failed to list episode groups', { seriesMediaId, error: err });
        return null;
    }
    if (groups.length === 0) {
        return null;
    }

    let best: SeasonStructureDetection | null = null;
    for (const group of groups) {
        if (deps.signal?.aborted) return null;
        if (group.groupCount === 0 || group.episodeCount === 0) continue;

        let details: EpisodeGroupDetails | null;
        try {
            details = await groupProvider.getGroupDetails(group.groupId);
        } catch (err) {
            logger.warn('Failed to load episode group details', {
                groupId: group.groupId,
                error: err,
            });
            continue;
        }
        if (!details) continue;

        const { positions, seasonCounts, filteredBuckets } = buildGroupPositionMap(details);

        // Contradiction check: every already-bound file position the group
        // covers must map to the SAME tmdb episode the row already holds.
        let agreements = 0;
        let contradicted = false;
        for (const [pos, tmdbId] of boundByPosition) {
            const mapped = positions.get(pos);
            if (!mapped) continue;
            if (mapped.tmdbEpisodeId === tmdbId) {
                agreements++;
            } else {
                contradicted = true;
                break;
            }
        }
        if (contradicted) continue;

        // Coverage: every fixable episode must resolve to a TMDB episode that
        // is not already bound to some other file-backed row, and no two
        // fixable episodes may resolve to the SAME TMDB episode (malformed
        // group data) — a duplicate would collide in upsertExternalId and
        // roll back the whole apply batch.
        const bindings: SeasonStructureBinding[] = [];
        const usedTmdbIds = new Set<string>();
        let covered = true;
        for (const ep of fixable) {
            const mapped = positions.get(`${ep.season_number}:${ep.episode_number}`);
            if (
                !mapped ||
                fileBackedTmdbIds.has(mapped.tmdbEpisodeId) ||
                usedTmdbIds.has(mapped.tmdbEpisodeId)
            ) {
                covered = false;
                break;
            }
            usedTmdbIds.add(mapped.tmdbEpisodeId);
            bindings.push({
                episodeId: ep.id,
                seasonNumber: ep.season_number,
                episodeNumber: ep.episode_number,
                tmdbEpisodeId: mapped.tmdbEpisodeId,
                originalSeasonNumber: mapped.originalSeasonNumber,
                originalEpisodeNumber: mapped.originalEpisodeNumber,
                groupEpisodeName: mapped.name,
            });
        }
        if (!covered) continue;

        // Every group position no local file occupies. Their canonical holders
        // (if any) are file-less rows stranded at the provider's flat numbering
        // — apply moves them to the group position instead. Purely positional:
        // apply re-checks the holder, the target season and the target slot.
        const relocations: SeasonStructureRelocation[] = [];
        for (const entry of positions.values()) {
            if (
                fileBackedTmdbIds.has(entry.tmdbEpisodeId) ||
                usedTmdbIds.has(entry.tmdbEpisodeId)
            ) {
                continue;
            }
            relocations.push({
                tmdbEpisodeId: entry.tmdbEpisodeId,
                targetSeasonNumber: entry.groupSeasonNumber,
                targetEpisodeNumber: entry.groupEpisodeNumber,
            });
        }

        const exactStructure =
            seasonCounts.length === localSeasonsSorted.length &&
            seasonCounts.every((count, idx) => localSeasonsSorted[idx]?.[1] === count);

        // Safety gate: without either corroborating evidence (existing bindings
        // agree) or an exact structural match, don't auto-apply.
        if (agreements === 0 && !exactStructure) continue;

        const candidate: SeasonStructureDetection = {
            seriesMediaId,
            provider: providerId,
            groupId: group.groupId,
            groupName: group.groupName,
            orderingType: (group.groupType || 'other') as EpisodeOrderingType,
            bindings,
            relocations,
            agreements,
            exactStructure,
            orderingConsistent: !filteredBuckets,
        };
        if (
            !best ||
            candidate.agreements > best.agreements ||
            (candidate.agreements === best.agreements &&
                candidate.exactStructure &&
                !best.exactStructure) ||
            // Deterministic tie-break: provider group order can vary between
            // runs (and transient fetch failures skip groups), so equal scores
            // must not flip-flop the chosen group across syncs.
            (candidate.agreements === best.agreements &&
                candidate.exactStructure === best.exactStructure &&
                candidate.groupId < best.groupId)
        ) {
            best = candidate;
        }
    }

    return best;
}

// =============================================================================
// Apply
// =============================================================================

/** `sync_quarantine.provider` of the undo markers this service's undo writes. */
export const SEASON_STRUCTURE_QUARANTINE_PROVIDER =
    RECONCILIATION_QUARANTINE_PROVIDER['season-structure'];

/**
 * Bind one file-backed episode to its TMDB episode on the caller's transaction
 * handle: release the ghost's id, write the id and canonical title fields,
 * merge the ghost into the episode (user state migrates), and write the undo
 * record. The caller runs it behind a savepoint, so a throw discards all of it.
 * File-backed episodes keep their local numbering, so from and to coincide.
 */
async function applyBinding(
    tx: postgres.Sql,
    seriesMediaId: string,
    binding: SeasonStructureBinding,
    ghostId: string | null,
    catalogEp: TmdbCatalogEpisode | undefined,
): Promise<void> {
    // The ghost was looked up before this savepoint began. Read it again with a
    // lock: it must still be file-less, unlocked and hold the id about to be
    // moved. One that gained a file since (a scan linked it) is playable now and
    // must not be merged away; the pair is skipped.
    if (ghostId) {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal TOCTOU re-check keyed by a specific episode UUID; not user-facing
        const [ghost] = await tx<{ id: string }[]>`
            SELECT mi.id
            FROM media_items mi
            JOIN external_ids ei
                ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
            WHERE mi.id = ${ghostId}
              AND mi.has_files = false
              AND NOT mi.metadata_locked
              AND ei.external_id = ${binding.tmdbEpisodeId}
            FOR UPDATE OF mi
        `;
        if (!ghost) throw new Error('ghost changed since detection');
    }

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal read keyed by a specific episode UUID; not user-facing
    const [prev] = await tx<
        {
            parent_id: string | null;
            season_number: number;
            episode_number: number;
            title: string | null;
            overview: string | null;
            title_binding: string | null;
            still_path: string | null;
        }[]
    >`
        SELECT mi.parent_id, mi.season_number, mi.episode_number, mi.title, mi.overview,
               mi.title_binding,
               (SELECT pm.metadata->>'still_path' FROM provider_metadata pm
                WHERE pm.media_id = mi.id AND pm.provider = 'tmdb'
                  AND jsonb_typeof(pm.metadata) = 'object') AS still_path
        FROM media_items mi
        WHERE mi.id = ${binding.episodeId}
        FOR UPDATE OF mi
    `;
    if (!prev) throw new Error('episode no longer exists');

    const catalogService = createCatalogService(tx, { skipLifecycleHooks: true });
    if (ghostId) {
        await catalogService.deleteExternalId(ghostId, 'tmdb', 'episode');
    }

    const extId: ExternalIdWrite = {
        provider: 'tmdb',
        id: binding.tmdbEpisodeId,
        mediaType: 'episode',
        source: 'reconciliation',
    };
    // A skipped write (the identity-swap guard) must not leave a merged ghost
    // behind with no identity bound.
    if (!(await catalogService.upsertExternalId(binding.episodeId, extId, true))) {
        throw new Error('external id write was skipped');
    }

    const title = catalogEp?.name ?? binding.groupEpisodeName;
    const overview = catalogEp?.overview ?? null;
    // A locked episode still gets its identity; only its display fields are
    // frozen, so this UPDATE matching no row is not a failure.
    await tx`
        UPDATE media_items
        SET title = COALESCE(${title}, title),
            overview = COALESCE(${overview}, overview),
            title_binding = 'identity',
            updated_at = NOW()
        WHERE id = ${binding.episodeId}
          AND NOT metadata_locked
    `;
    await refreshSortTitles(tx, [binding.episodeId]);

    const stillPath = catalogEp?.stillPath;
    if (stillPath) {
        // No `force` here (C3 fix-round-2, 2026-09-25 security
        // review): `force` on `SyncOptions` covers the SERIES row
        // only (metadata-sync-single.service.ts's documented
        // contract) — children follow `forceChildren`, which is not
        // threaded through this call. Round 1 mistakenly passed the
        // series-level `force` down to this CHILD row's still_path
        // write while leaving the sibling `media_items` UPDATE above
        // unconditional-lock-respecting, producing a split outcome
        // (still_path written, title not) for a locked episode
        // during a force-admin sync. Both writes now consistently
        // respect the lock with no override at this layer.
        // `forceChildren` stays out on purpose: detection already
        // treats a locked episode as protected from rebinding
        // (episode-reconciliation.queries.ts), so a force flag here
        // would have to re-bind the identity of rows an admin froze,
        // not just refresh their metadata. `forceChildren` reaches
        // locked episodes through the canonical child sync instead
        // (`batchFindOrCreateEpisodes` in metadata-sync-single).
        await upsertProviderMetadataUnlessLocked(tx, binding.episodeId, 'tmdb', {
            still_path: stillPath,
        });
    }

    // MERGE, don't hard-delete: ghosts are where user state accumulates before
    // the fix runs (watch-sync pull resolves by tmdb id with no has_files
    // filter; mark-season-watched fans out to file-less rows), so watched
    // flags, ratings, playlist membership and watch history must migrate to the
    // file-backed successor that just inherited the ghost's identity. The merge
    // opens no transaction of its own; its lifecycle hooks run after our commit.
    const mergeStats = ghostId
        ? await MediaDeletionService.mergeIntoTx(tx, binding.episodeId, ghostId)
        : null;

    await insertReconciliationMove(tx, {
        seriesId: seriesMediaId,
        episodeId: binding.episodeId,
        service: 'season-structure',
        evidence: 'episode-group',
        ghostId,
        tmdbEpisodeId: binding.tmdbEpisodeId,
        fromParentId: prev.parent_id,
        fromSeason: prev.season_number,
        fromEpisode: prev.episode_number,
        toParentId: prev.parent_id,
        toSeason: prev.season_number,
        toEpisode: prev.episode_number,
        prevTitleBinding: prev.title_binding,
        prevTitle: prev.title,
        prevOverview: prev.overview,
        prevStillPath: prev.still_path,
        mergeStats: mergeStats ? { ...mergeStats } : null,
    });
}

/**
 * Apply a detected fix: bind TMDB identity onto the file-backed rows, delete
 * the ghost holders, and activate the group as the series ordering.
 */
export async function applySeasonStructureFix(
    sql: postgres.Sql,
    detection: SeasonStructureDetection,
    deps: SeasonStructureDeps = {},
): Promise<SeasonStructureApplyResult> {
    const { seriesMediaId } = detection;
    if (deps.signal?.aborted) {
        return {
            bound: 0,
            skipped: 0,
            ghostsDeleted: 0,
            ghostsRelocated: 0,
            emptySeasonsDeleted: 0,
            orderingApplied: false,
        };
    }
    const catalog = deps.catalog ?? (await loadTmdbCatalog(sql, seriesMediaId));
    const catalogById = new Map(catalog.map((c) => [c.tmdbEpisodeId, c]));

    let bound = 0;
    let skipped = 0;
    let manualAborted = false;
    /** ghosts merged inside the transaction, each into the episode that inherited its identity */
    const mergedPairs: { ghostId: string; successorId: string }[] = [];
    const boundEpisodeIds: string[] = [];

    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Serialize with episode reconciliation applies for the same series.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesMediaId})::bigint)`;

        // TOCTOU guard: detection checked the ordering preference before its
        // (potentially slow) provider calls — an admin may have set a MANUAL
        // ordering since. Manual always wins; abort without writing anything.
        const orderingNow = await getSeriesOrdering(tx, seriesMediaId);
        if (orderingNow?.ordering_source === 'manual') {
            manualAborted = true;
            return;
        }

        const targetIds = detection.bindings.map((b) => b.tmdbEpisodeId);
        // Holders are looked up GLOBALLY: a duplicate-series row outside this
        // series can hold a target id too, and upsertExternalId would throw on
        // it, rolling back the whole batch. Out-of-series holders are skipped
        // like file-backed ones (we only ever release in-series ghosts).
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by explicit tmdb episode ids; not user-facing
        const holders = await tx<
            {
                media_id: string;
                external_id: string;
                has_files: boolean;
                metadata_locked: boolean;
                in_series: boolean;
            }[]
        >`
            SELECT ei.media_id, ei.external_id, mi.has_files, mi.metadata_locked,
                   EXISTS (
                       SELECT 1 FROM media_items season
                       WHERE season.id = mi.parent_id
                         AND season.media_type = 'season'
                         AND season.parent_id = ${seriesMediaId}
                   ) AS in_series
            FROM external_ids ei
            JOIN media_items mi ON mi.id = ei.media_id AND mi.media_type = 'episode'
            WHERE ei.provider = 'tmdb'
              AND ei.media_type = 'episode'
              AND ei.external_id = ANY(${targetIds}::text[])
        `;
        const holderByExtId = new Map(holders.map((h) => [h.external_id, h]));

        // Staleness re-check: a concurrent reconciliation may have bound one of
        // our target episodes since detection — never overwrite a fresh binding.
        const bindingEpisodeIds = detection.bindings.map((b) => b.episodeId);
        const alreadyBoundRows = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE media_id = ANY(${bindingEpisodeIds}::uuid[])
              AND provider = 'tmdb'
              AND media_type = 'episode'
        `;
        const alreadyBound = new Set(alreadyBoundRows.map((r) => r.media_id));

        // Pairs an admin undid are not applied again. The key is the (episode,
        // TMDB episode) pair: the next sync recreates an undone ghost under a new id.
        const blocked = await loadBlockedPairKeys(tx, bindingEpisodeIds);

        for (const binding of detection.bindings) {
            if (alreadyBound.has(binding.episodeId)) {
                skipped++;
                continue;
            }
            if (blocked.has(reconciliationPairKey(binding.episodeId, binding.tmdbEpisodeId))) {
                skipped++;
                continue;
            }
            const holder = holderByExtId.get(binding.tmdbEpisodeId);
            // A file-backed holder means the detection snapshot went stale —
            // never steal an id from a playable row. An admin-locked holder is
            // frozen from automated changes (mirrors getLockedHeldTmdbIds in
            // episode reconciliation). An out-of-series holder belongs to a
            // duplicate series — not ours to release.
            if (holder && (holder.has_files || holder.metadata_locked || !holder.in_series)) {
                skipped++;
                continue;
            }

            // One binding is one unit of work: release the ghost's id, bind it,
            // merge the ghost away and write the undo record behind a savepoint,
            // so a binding that cannot finish leaves no half-applied state.
            const outcome = await inSavepoint(tx, (bindingTx) =>
                applyBinding(
                    bindingTx,
                    seriesMediaId,
                    binding,
                    holder?.media_id ?? null,
                    catalogById.get(binding.tmdbEpisodeId),
                ),
            );
            if (!outcome.ok) {
                skipped++;
                logger.warn('Season-structure binding failed; nothing was written for it', {
                    seriesMediaId,
                    episodeId: binding.episodeId,
                    tmdbEpisodeId: binding.tmdbEpisodeId,
                    error:
                        outcome.error instanceof Error
                            ? outcome.error.message
                            : String(outcome.error),
                });
                continue;
            }
            bound++;
            boundEpisodeIds.push(binding.episodeId);
            if (holder)
                mergedPairs.push({ ghostId: holder.media_id, successorId: binding.episodeId });
        }
    });

    if (manualAborted) {
        logger.info('Season-structure fix aborted — manual ordering set during detection', {
            seriesMediaId,
        });
        return {
            bound: 0,
            skipped: 0,
            ghostsDeleted: 0,
            ghostsRelocated: 0,
            emptySeasonsDeleted: 0,
            orderingApplied: false,
        };
    }

    // Post-commit hooks of the merges that ran inside the transaction.
    let ghostsDeleted = 0;
    for (const { ghostId, successorId } of mergedPairs) {
        ghostsDeleted++;
        try {
            await MediaDeletionService.runMergeHooks(sql, successorId, ghostId);
        } catch (err) {
            logger.warn('Merge hooks failed post-commit (non-fatal)', {
                ghostId,
                successorId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Relocate the ghosts nothing bound: they hold group positions with no
    // local file (a season still airing, or simply not downloaded). Left alone
    // they sit at the provider's flat canonical numbering — Re:Zero showed
    // S4E12-19 as "Season 1, episodes 78-85, unavailable". Moving them is the
    // only correction available when the group can't be activated as the
    // display ordering (orderingConsistent === false).
    let ghostsRelocated = 0;
    if (detection.relocations.length > 0 && !deps.signal?.aborted) {
        // Season rows this series actually has, by season number.
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal cleanup keyed by a specific series UUID; not user-facing
        const seasonRows = await sql<{ id: string; season_number: number }[]>`
            SELECT id, season_number
            FROM media_items
            WHERE parent_id = ${seriesMediaId}
              AND media_type = 'season'
              AND season_number IS NOT NULL
        `;
        const seasonIdByNumber = new Map(seasonRows.map((s) => [s.season_number, s.id]));

        for (const relocation of detection.relocations) {
            if (deps.signal?.aborted) break;
            const targetSeasonId = seasonIdByNumber.get(relocation.targetSeasonNumber);
            // No local season row (e.g. a future season with nothing on disk):
            // creating one would invent structure the scanner never saw.
            if (!targetSeasonId) continue;

            try {
                // Single guarded statement: move the in-series, file-less,
                // unlocked holder of this tmdb id — but only when the target
                // slot is free, so uq_media_items_episode can't be violated by
                // a row the scanner added since detection.
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal cleanup scoped to this series' seasons by the season.parent_id predicate; not user-facing
                const moved = await sql<{ id: string }[]>`
                    UPDATE media_items mi
                    SET parent_id = ${targetSeasonId},
                        season_number = ${relocation.targetSeasonNumber},
                        episode_number = ${relocation.targetEpisodeNumber},
                        updated_at = NOW()
                    FROM external_ids ei, media_items season
                    WHERE ei.media_id = mi.id
                      AND ei.provider = 'tmdb'
                      AND ei.media_type = 'episode'
                      AND ei.external_id = ${relocation.tmdbEpisodeId}
                      AND mi.media_type = 'episode'
                      AND mi.has_files = false
                      AND NOT mi.metadata_locked
                      AND season.id = mi.parent_id
                      AND season.media_type = 'season'
                      AND season.parent_id = ${seriesMediaId}
                      AND (
                          mi.season_number IS DISTINCT FROM ${relocation.targetSeasonNumber}
                          OR mi.episode_number IS DISTINCT FROM ${relocation.targetEpisodeNumber}
                      )
                      AND NOT EXISTS (
                          SELECT 1 FROM media_items occupied
                          WHERE occupied.parent_id = ${targetSeasonId}
                            AND occupied.media_type = 'episode'
                            AND occupied.season_number = ${relocation.targetSeasonNumber}
                            AND occupied.episode_number = ${relocation.targetEpisodeNumber}
                      )
                    RETURNING mi.id
                `;
                if (moved.length > 0) ghostsRelocated++;
            } catch (err) {
                logger.warn('Failed to relocate ghost episode', {
                    seriesMediaId,
                    tmdbEpisodeId: relocation.tmdbEpisodeId,
                    target: `${relocation.targetSeasonNumber}:${relocation.targetEpisodeNumber}`,
                    error: err,
                });
            }
        }
    }

    // Seasons that only existed to hold ghosts are now empty file-less shells.
    let emptySeasonsDeleted = 0;
    if (ghostsDeleted > 0) {
        // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal cleanup keyed by a specific series UUID; not user-facing
        const emptySeasons = await sql<{ id: string }[]>`
            SELECT s.id
            FROM media_items s
            WHERE s.parent_id = ${seriesMediaId}
              AND s.media_type = 'season'
              AND s.has_files = false
              AND NOT EXISTS (SELECT 1 FROM media_items e WHERE e.parent_id = s.id)
        `;
        for (const season of emptySeasons) {
            if (deps.signal?.aborted) break;
            // Re-check emptiness right before deleting: a concurrent scan may
            // have inserted an episode since the SELECT above, and the
            // parent_id FK is ON DELETE SET NULL — deleting now would orphan
            // it. (Window shrinks to ms; the scanner recreates the season row
            // on conflict-free insert if we lose the remaining race.)
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal cleanup keyed by a specific season UUID; not user-facing
            const [child] = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE parent_id = ${season.id} LIMIT 1
            `;
            if (child) continue;
            try {
                await MediaDeletionService.hardDelete(sql, season.id);
                emptySeasonsDeleted++;
            } catch (err) {
                logger.warn('Failed to delete empty season', {
                    seasonId: season.id,
                    error: err,
                });
            }
        }
    }

    // Activate the group as the series ordering (display metadata + admin UI
    // state + absolute-number lookups). Non-fatal: identity binding is the fix,
    // the ordering record is bookkeeping on top.
    let orderingApplied = false;
    // Re-check right before overwriting: manual always wins, even when it was
    // set after the binding transaction above (the bindings themselves are
    // still valid identity fixes either way). Beyond that, only activate the
    // group as the DISPLAY ordering when it is safe:
    //  - bound > 0: activation is bookkeeping on top of a successful fix
    //  - orderingConsistent: syncOrderings numbers ALL buckets; a group whose
    //    specials/empty buckets we filtered for binding would display local
    //    S1 as S2 etc.
    //  - no file-backed specials: watch-status fan-outs exclude episodes
    //    without ordering rows once an ordering is active — silently flipping
    //    that semantic for a user's specials is not automation's call.
    const orderingBeforeActivate = await getSeriesOrdering(sql, seriesMediaId);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal check keyed by a specific series UUID; not user-facing
    const [fileBackedSpecial] = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        WHERE season.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND mi.has_files = true
          AND mi.season_number = 0
        LIMIT 1
    `;
    const skipActivation =
        orderingBeforeActivate?.ordering_source === 'manual' ||
        deps.signal?.aborted === true ||
        bound === 0 ||
        !detection.orderingConsistent ||
        fileBackedSpecial !== undefined;
    if (skipActivation) {
        logger.info('Skipping ordering activation', {
            seriesMediaId,
            manual: orderingBeforeActivate?.ordering_source === 'manual',
            aborted: deps.signal?.aborted === true,
            bound,
            orderingConsistent: detection.orderingConsistent,
            hasFileBackedSpecials: fileBackedSpecial !== undefined,
        });
    } else {
        try {
            const orderingService = getEpisodeOrderingService(sql);
            await orderingService.setSeriesOrdering(
                { mediaId: seriesMediaId },
                detection.orderingType,
                {
                    source: 'auto',
                    provider: detection.provider,
                    groupId: detection.groupId,
                },
            );
            await orderingService.syncOrderings(
                { mediaId: seriesMediaId },
                detection.orderingType,
                detection.provider,
                detection.groupId,
            );
            await orderingService.applyOrderingToEpisodes(
                { mediaId: seriesMediaId },
                detection.orderingType,
                detection.provider,
                detection.groupId,
            );
            orderingApplied = true;
        } catch (err) {
            logger.warn('Season-structure fix: ordering activation failed (non-fatal)', {
                seriesMediaId,
                error: err,
            });
        }
    }

    // Post-commit hooks: mirror applyReconciliation.
    for (const episodeId of boundEpisodeIds) {
        try {
            await MediaLifecycleService.afterMetadataChanged(episodeId, ['title', 'overview'], sql);
        } catch (err) {
            logger.warn('afterMetadataChanged failed post-commit (non-fatal)', {
                episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        try {
            const { getImageProxyService } =
                await import('$lib/server/services/image-proxy/index.js');
            getImageProxyService().invalidateCatalogImage(episodeId);
        } catch (err) {
            logger.warn('invalidateCatalogImage failed post-commit (non-fatal)', {
                episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    if (bound > 0) {
        try {
            const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
            await cacheManager.for(CACHE_NAMESPACES.nextEpisode).clear();
            await cacheManager.for(CACHE_NAMESPACES.heroNextUp).clear();
            await cacheManager.for(CACHE_NAMESPACES.newEpisodes).clear();
        } catch (err) {
            logger.warn('Post-fix cache clear failed (non-fatal)', {
                seriesMediaId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    logger.info('Applied season-structure fix', {
        seriesMediaId,
        groupId: detection.groupId,
        groupName: detection.groupName,
        bound,
        skipped,
        ghostsDeleted,
        ghostsRelocated,
        emptySeasonsDeleted,
        orderingApplied,
    });

    return { bound, skipped, ghostsDeleted, ghostsRelocated, emptySeasonsDeleted, orderingApplied };
}

// =============================================================================
// Auto entry point (metadata-sync hook)
// =============================================================================

/**
 * Cheap-gated auto fix: called after a series metadata sync. Returns null when
 * there was nothing to do.
 */
export async function maybeAutoFixSeasonStructure(
    sql: postgres.Sql,
    seriesMediaId: string,
    deps: SeasonStructureDeps = {},
): Promise<SeasonStructureApplyResult | null> {
    // Gate on a single query before touching any provider API.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal sync gate keyed by a specific series UUID; not user-facing
    const unmatchedPositions = await sql<{ season_number: number; episode_number: number }[]>`
        SELECT mi.season_number, mi.episode_number
        FROM media_items mi
        JOIN media_items season ON season.id = mi.parent_id AND season.media_type = 'season'
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE season.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND mi.has_files = true
          AND mi.season_number > 0
          AND mi.episode_number IS NOT NULL
          AND ei.external_id IS NULL
    `;
    if (unmatchedPositions.length === 0) {
        return null;
    }

    // Negative-detection backoff: detection failures are usually permanent
    // (no matching group, TMDB lacks the episodes, everything locked). Cache
    // the unmatched-set signature and skip the provider calls until the set
    // changes (new files, new TMDB data) — otherwise every scheduled sync of
    // an unfixable series re-pays the full episode-group API cost.
    const signature = unmatchedPositions
        .map((r) => `${r.season_number}:${r.episode_number}`)
        .sort()
        .join(',');
    let backoffCache: {
        get: (k: string) => Promise<unknown>;
        set: (k: string, v: string) => Promise<void>;
        delete: (k: string) => Promise<void>;
    } | null = null;
    try {
        const { cacheManager, CACHE_NAMESPACES } = await import('$lib/server/cache/index.js');
        backoffCache = cacheManager.for(CACHE_NAMESPACES.seasonStructureDetect);
        if ((await backoffCache.get(seriesMediaId)) === signature) {
            return null;
        }
    } catch {
        backoffCache = null; // cache unavailable — proceed without backoff
    }
    const rememberFailure = async (): Promise<void> => {
        try {
            await backoffCache?.set(seriesMediaId, signature);
        } catch {
            // Non-fatal
        }
    };

    const detection = await detectSeasonStructureFix(sql, seriesMediaId, deps);
    if (!detection || detection.bindings.length === 0) {
        if (!deps.signal?.aborted) await rememberFailure();
        return null;
    }

    logger.info('Season-structure mismatch detected, auto-applying episode group', {
        seriesMediaId,
        groupId: detection.groupId,
        groupName: detection.groupName,
        bindings: detection.bindings.length,
        agreements: detection.agreements,
        exactStructure: detection.exactStructure,
    });

    const result = await applySeasonStructureFix(sql, detection, deps);
    if (result.bound === 0 && !deps.signal?.aborted) {
        // Everything skipped (locked/stale/foreign holders) — same signature
        // will produce the same outcome next sync, so back off.
        await rememberFailure();
    } else if (result.bound > 0) {
        try {
            await backoffCache?.delete(seriesMediaId);
        } catch {
            // Non-fatal
        }
    }
    return result;
}
