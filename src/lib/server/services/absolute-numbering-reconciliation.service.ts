// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Absolute-Numbering Reconciliation
 *
 * Fixes long-running series whose releases are numbered ABSOLUTELY while the
 * provider splits them into seasons — and whose provider ALSO numbers episodes
 * absolutely inside each season (TMDB does this for Sky Harbor: season 13 holds
 * episodes 422-522, not 1-101).
 *
 * The scanner takes the season from the filename when it has one
 * (`resolveSeasonNumber`), so a release named `S01E0422` sitting in a
 * `Season 13/` folder lands at local (season 1, episode 422) with no provider
 * identity, while metadata sync creates the real episode as a file-less ghost
 * at (season 13, episode 422). The library then shows season 1 jumping from
 * E61 straight to E422 with no metadata.
 *
 * Unlike season-structure reconciliation this needs no episode groups: the
 * absolute number alone identifies the episode. The whole safety of the fix
 * rests on UNIQUENESS — a match is only made when exactly one file-less
 * canonical ghost AND exactly one orphaned file row carry that number, and NO
 * other episode of the series does. For a normally numbered series episode
 * numbers repeat in every season, so nothing is unique and this declines. The
 * ghost's season must also lack an E1.
 *
 * Both checks are heuristics: a missing E1 is necessary for an absolute season,
 * not proof of one. Accepted blind spot: when the provider's FIRST season holds
 * the whole absolute run (S1 = E1..E366), every target season has an E1, so
 * per-season files (S09E21 = absolute 188) are never matched. That shape is
 * indistinguishable from a per-season show whose S1E21 merely lacks a file.
 *
 * The E1 guard stays on this number-match path, although a file name that
 * carries the absolute number (below) no longer depends on it. Number-matches
 * are only proposals while RECONCILE_AUTO_APPLY_NUMBER_MATCHES is off, but with
 * the setting on the guard still stops the Bleach and Polar Opposites shapes
 * (a file named S09E21 moving to S1E21), and it costs one NOT EXISTS.
 *
 * A file whose name carries the absolute number (`absolute_episode`, read by the
 * scanner from `S09E21 - 188 - Title` or `S01E0422`) is matched differently and
 * never falls back to the number-match path: its target is the TMDB episode at
 * absolute position N of the series' catalog (rows in the DB, ordered by season
 * and episode), or, when the provider numbers a season absolutely, the episode
 * numbered N. Where both exist they must name the same row. The target must be a
 * file-less, unlocked ghost, and the catalog must be gap-free up to N, else the
 * file is left alone. It works for a first season that holds the whole absolute
 * run, the shape the number-match path has to decline.
 *
 * Absolute position alone is NOT strong evidence: TMDB orders some shows
 * differently from Sonarr/TVDB (a Case Closed file named 041 lands on another
 * episode; a Pokemon file named 1139 lands in S24). So the file's own episode
 * title must agree with the target's TMDB name or alt names (the similarity and
 * 0.8 threshold episode reconciliation uses; a multi-part title is tried whole
 * first, then per segment). Segments that only repeat the series name or consist
 * of language and release words (`S01E0422 - ONE PIECE [GER-JAP]`) are not a title:
 * - agrees: evidence `filename-absolute`;
 * - clearly disagrees (a usable title scoring below the threshold): declined,
 *   nothing written and not proposed, because the target is probably wrong;
 * - no usable title (missing, `TBA`, `Episode 12`, the series name only, or the
 *   target has none): evidence `filename-absolute-untitled`, a proposal only,
 *   EXCEPT when the file has no title at all and rules (a) absolute position and
 *   (b) season without an E1 both name the same row: two independent derivations
 *   agree, evidence `filename-absolute-corroborated` (the One Piece shape).
 * `filename-absolute` and `filename-absolute-corroborated` apply when
 * RECONCILE_AUTO_APPLY_FILENAME_MATCHES is on (default); off, they are proposals.
 * Alt names need the TMDB catalog; it is loaded (through deps.getCatalog, else
 * loadTmdbCatalog) only for a pair whose title disagrees with the ghost's stored
 * name, so the verdict never depends on who calls.
 *
 * Candidates from the two paths are reconciled before anything is applied: a
 * ghost or orphan that a file-name candidate claims is taken out of the
 * number-match path (file-name evidence wins), and a ghost or orphan still
 * claimed twice declines both claims.
 *
 * Apply mirrors season-structure reconciliation: bind identity onto the file
 * row, copy the canonical title/overview/still, merge the ghost into it (user
 * state migrates), then move the file row into the ghost's now-vacated season
 * and episode so it displays where the provider says it belongs.
 *
 * One pair is one unit of work: bind, merge and move commit together inside the
 * per-series advisory-lock transaction, behind a savepoint, with an undo record
 * (episode_reconciliation_moves). A pair that cannot finish (the target slot is
 * taken, the row got locked) writes nothing. Lifecycle hooks and cache clears
 * run after the commit.
 *
 * Evidence decides whether a match applies or only proposes. A match backed by
 * nothing but matching episode numbers (`number-match`) is applied only when
 * RECONCILE_AUTO_APPLY_NUMBER_MATCHES is on; otherwise it is written to
 * sync_quarantine as an `absolute-numbering:proposed` row. File-name evidence
 * (`filename-absolute`, `filename-absolute-corroborated`) applies when
 * RECONCILE_AUTO_APPLY_FILENAME_MATCHES is on (default), at most
 * {@link MAX_APPLIED_PAIRS_PER_SYNC} pairs per series and sync; the rest waits
 * for the next sync. An untitled file-name match (`filename-absolute-untitled`)
 * is always a proposal. The apply re-runs detection under the series lock and
 * applies a pair only while its FRESH evidence is the one that was detected and
 * the settings still allow it.
 *
 * Proposals are one row per (episode, TMDB episode) pair
 * (reconciliationPairKey), so dismissing or undoing one pair never forgets
 * another of the same episode. A dismissed or applied proposal is never
 * reopened; an open one whose pair is no longer detected (or whose episode got
 * its identity some other way) is resolved by the next sync as superseded.
 */

import { refreshSortTitles } from '$lib/server/database/queries/sort-title.queries.js';
import { createHash } from 'node:crypto';
import type postgres from 'postgres';
import { cacheManager, CACHE_NAMESPACES, buildVersionedCacheKey } from '$lib/server/cache/index.js';
import { inSavepoint, withTx } from '$lib/server/database/with-tx.js';
import { config } from '$lib/server/config.js';
import { createCatalogService } from '$lib/server/services/catalog.service.js';
import { MediaLifecycleService } from '$lib/server/services/media-lifecycle.service.js';
import { MediaDeletionService } from '$lib/server/services/media-deletion.service.js';
import type { ExternalIdWrite } from '$lib/server/providers/provider-types.js';
import { Logger } from '$lib/server/utils/logger.js';
import { upsertProviderMetadataUnlessLocked } from '$lib/server/database/queries/media-upsert.js';
import { recomputeHasFilesBatch } from '$lib/server/database/queries/media-files.queries.js';
import {
    insertReconciliationMove,
    loadBlockedPairKeys,
    reconciliationPairKey,
    RECONCILIATION_BLOCK_PROVIDERS,
    RECONCILIATION_QUARANTINE_PROVIDER,
} from '$lib/server/database/queries/episode-reconciliation-moves.queries.js';
import {
    getQuarantineByKey,
    getQuarantineById,
    listUnresolvedQuarantineByReason,
    quarantineWrite,
    resolveQuarantine,
    type QuarantineEntry,
} from '$lib/server/database/queries/sync-quarantine.queries.js';
import {
    bestMatchAboveThreshold,
    isGenericChapterName,
} from '$lib/server/utils/string-similarity.js';
import { releaseTitleSegments } from '$lib/server/utils/episode-release-title.js';
import {
    loadTmdbCatalog,
    type TmdbCatalogEpisode,
} from '$lib/server/services/episode-reconciliation.service.js';

const logger = Logger.for('AbsoluteNumberingReconciliation');

/** `sync_quarantine.provider` of this service's proposals and undo/reject markers. */
export const ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER =
    RECONCILIATION_QUARANTINE_PROVIDER['absolute-numbering'];
export const ABSOLUTE_NUMBERING_PROPOSED_REASON = 'absolute-numbering:proposed';
const QUARANTINE_SOURCE = 'absolute-numbering-reconciliation';

// =============================================================================
// Types
// =============================================================================

/**
 * What backs a match. `number-match` is gated by
 * RECONCILE_AUTO_APPLY_NUMBER_MATCHES. `filename-absolute` (the absolute number
 * parsed from the file name, and the file's title agrees with the target's) and
 * `filename-absolute-corroborated` (no title in the file name, but two
 * independent derivations of the number name the same row) are gated by
 * RECONCILE_AUTO_APPLY_FILENAME_MATCHES. `filename-absolute-untitled` (no usable
 * title to compare, one derivation only) is only ever proposed.
 */
export type AbsoluteNumberingEvidence =
    | 'number-match'
    | 'filename-absolute'
    | 'filename-absolute-corroborated'
    | 'filename-absolute-untitled';

/** Most pairs one sync applies per series; the rest waits for the next sync. */
export const MAX_APPLIED_PAIRS_PER_SYNC = 50;

export interface AbsoluteNumberingMatch {
    /** File-backed episode stranded at an absolute number with no identity */
    episodeId: string;
    /** Where it currently sits */
    seasonNumber: number;
    episodeNumber: number;
    /** File-less canonical row holding the identity for that absolute number */
    ghostId: string;
    tmdbEpisodeId: string;
    /** The canonical position the file row adopts */
    targetSeasonNumber: number;
    targetEpisodeNumber: number;
    targetSeasonId: string;
    evidence: AbsoluteNumberingEvidence;
}

export interface DetectDeps {
    /** Loads the TMDB catalog (alt names) when a title needs a second look. */
    getCatalog?: () => Promise<TmdbCatalogEpisode[]>;
}

export interface AbsoluteNumberingDetection {
    seriesMediaId: string;
    matches: AbsoluteNumberingMatch[];
}

export interface AbsoluteNumberingApplyResult {
    bound: number;
    skipped: number;
    /** Placeholders merged away, as the merges reported them */
    ghostsDeleted: number;
    /** Episodes the move statement actually relocated */
    moved: number;
    /** Matches written to sync_quarantine instead of applied */
    proposed: number;
    /** Valid pairs left for the next sync because the per-sync cap was reached */
    deferred: number;
}

export interface AbsoluteNumberingDeps {
    /** Preloaded canonical episode catalog (default: loadTmdbCatalog) */
    catalog?: TmdbCatalogEpisode[];
    /** Cooperative cancellation (checked between phases) */
    signal?: AbortSignal;
    /** Override of RECONCILE_AUTO_APPLY_NUMBER_MATCHES (default: the setting) */
    autoApplyNumberMatches?: boolean;
    /** Override of RECONCILE_AUTO_APPLY_FILENAME_MATCHES (default: the setting) */
    autoApplyFilenameMatches?: boolean;
    /** Override of {@link MAX_APPLIED_PAIRS_PER_SYNC} */
    maxPairsPerSync?: number;
}

interface ApplyPolicy {
    numberMatches: boolean;
    filenameMatches: boolean;
}

function applyPolicy(deps: AbsoluteNumberingDeps): ApplyPolicy {
    return {
        numberMatches: deps.autoApplyNumberMatches ?? config.RECONCILE_AUTO_APPLY_NUMBER_MATCHES,
        filenameMatches:
            deps.autoApplyFilenameMatches ?? config.RECONCILE_AUTO_APPLY_FILENAME_MATCHES,
    };
}

/** Whether a match with this evidence applies on its own under the policy. */
function appliesOnItsOwn(evidence: AbsoluteNumberingEvidence, policy: ApplyPolicy): boolean {
    switch (evidence) {
        case 'number-match':
            return policy.numberMatches;
        case 'filename-absolute':
        case 'filename-absolute-corroborated':
            return policy.filenameMatches;
        case 'filename-absolute-untitled':
            return false;
    }
}

interface MatchRow {
    episode_id: string;
    season_number: number;
    episode_number: number;
    ghost_id: string;
    tmdb_episode_id: string;
    target_season_number: number;
    target_episode_number: number;
    target_season_id: string;
    evidence: AbsoluteNumberingEvidence;
}

// =============================================================================
// Detection
// =============================================================================

/**
 * Pair every orphaned file row with the file-less canonical row that shares its
 * absolute episode number, keeping only pairings where that number is unique on
 * BOTH sides. Pure SQL — no provider calls, so this is cheap enough to run on
 * every metadata sync without a backoff cache.
 */
export async function detectAbsoluteNumberingFix(
    sql: postgres.Sql,
    seriesMediaId: string,
    deps: DetectDeps = {},
): Promise<AbsoluteNumberingDetection | null> {
    const numberMatches = await detectNumberMatches(sql, seriesMediaId);
    const filenameMatches = await detectFilenameAbsolute(sql, seriesMediaId, deps);

    // File-name evidence wins: a ghost or orphan that a file-name candidate
    // claims is no number-match candidate any more.
    const claimedGhosts = new Set(filenameMatches.map((m) => m.ghostId));
    const claimedOrphans = new Set(filenameMatches.map((m) => m.episodeId));
    const combined = [
        ...numberMatches.filter(
            (m) => !claimedGhosts.has(m.ghostId) && !claimedOrphans.has(m.episodeId),
        ),
        ...filenameMatches,
    ];

    // Whatever is still claimed twice (one ghost by two orphans, one orphan by
    // two ghosts) cannot be trusted: decline every claim on it.
    const ghostClaims = new Map<string, number>();
    const orphanClaims = new Map<string, number>();
    for (const m of combined) {
        ghostClaims.set(m.ghostId, (ghostClaims.get(m.ghostId) ?? 0) + 1);
        orphanClaims.set(m.episodeId, (orphanClaims.get(m.episodeId) ?? 0) + 1);
    }
    const matches = combined.filter(
        (m) => ghostClaims.get(m.ghostId) === 1 && orphanClaims.get(m.episodeId) === 1,
    );
    return matches.length === 0 ? null : { seriesMediaId, matches };
}

async function detectNumberMatches(
    sql: postgres.Sql,
    seriesMediaId: string,
): Promise<AbsoluteNumberingMatch[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by a specific series UUID; not user-facing
    const rows = await sql<MatchRow[]>`
        WITH ghosts AS (
            SELECT mi.id, mi.parent_id, mi.season_number, mi.episode_number,
                   ei.external_id AS tmdb_id
            FROM media_items mi
            JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
            JOIN external_ids ei
                ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
            WHERE s.parent_id = ${seriesMediaId}
              AND mi.media_type = 'episode'
              AND mi.has_files = false
              AND NOT mi.metadata_locked
              AND mi.season_number > 0
              AND mi.episode_number IS NOT NULL
        ),
        orphans AS (
            SELECT mi.id, mi.season_number, mi.episode_number
            FROM media_items mi
            JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
            LEFT JOIN external_ids ei
                ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
            WHERE s.parent_id = ${seriesMediaId}
              AND mi.media_type = 'episode'
              AND mi.has_files = true
              AND NOT mi.metadata_locked
              AND COALESCE(mi.title_binding, '') <> 'manual'
              AND mi.season_number > 0
              AND mi.episode_number IS NOT NULL
              AND ei.external_id IS NULL
              -- A file that names its absolute number has its own path
              -- (detectFilenameAbsolute) and never falls back to this one.
              AND NOT EXISTS (
                  SELECT 1
                  FROM media_file_items mfi
                  JOIN media_files mf ON mf.id = mfi.file_id
                  WHERE mfi.media_item_id = mi.id AND mf.absolute_episode IS NOT NULL
              )
        )
        SELECT o.id AS episode_id,
               o.season_number,
               o.episode_number,
               g.id AS ghost_id,
               g.tmdb_id AS tmdb_episode_id,
               g.season_number AS target_season_number,
               g.episode_number AS target_episode_number,
               g.parent_id AS target_season_id,
               'number-match'::text AS evidence
        FROM orphans o
        JOIN ghosts g ON g.episode_number = o.episode_number
        -- The number must be absolute: no OTHER episode of the series may carry
        -- it. A sitcom's S3E2 lost its identity when the provider merged the
        -- two-part S3E1/E2, while a new, unaired S6E2 appeared as the only E2
        -- ghost. Every other S?E2 had a file and an identity, so the number was
        -- unique among orphans and among ghosts and the old Season 3 file was
        -- moved into season 6. This check also makes the number unique among
        -- orphans and among ghosts: a second orphan or ghost with the same
        -- number is "another episode" for every pairing.
        WHERE NOT EXISTS (
            SELECT 1
            FROM media_items e
            JOIN media_items es ON es.id = e.parent_id AND es.media_type = 'season'
            WHERE es.parent_id = ${seriesMediaId}
              AND e.media_type = 'episode'
              AND e.season_number > 0
              AND e.episode_number = o.episode_number
              AND e.id <> o.id
              AND e.id <> g.id
        )
        -- And the provider must number the ghost's season absolutely (Sky
        -- Harbor S13 = E422-522). A season that has an E1 is numbered per
        -- season, so its E33 is not absolute episode 33: files named
        -- S13E33-35 would otherwise move into S2E33-35.
        AND NOT EXISTS (
            SELECT 1 FROM media_items first_ep
            WHERE first_ep.parent_id = g.parent_id
              AND first_ep.media_type = 'episode'
              AND first_ep.episode_number = 1
        )
        -- A pair an admin rejected (dismissed its proposal) or undid is not
        -- proposed or applied again. The key is the (episode, TMDB episode)
        -- pair, not the ghost: the next sync recreates an undone ghost under a
        -- new id. Rows keyed by the episode alone (written before the pair key)
        -- count too.
        AND NOT EXISTS (
            SELECT 1 FROM sync_quarantine q
            WHERE q.provider = ANY(${RECONCILIATION_BLOCK_PROVIDERS}::text[])
              AND q.media_type = 'episode'
              AND q.resolved_at IS NOT NULL
              AND q.resolution = 'dismissed'
              AND (
                  q.external_id = o.id::text || ':' || g.tmdb_id
                  OR (q.external_id = o.id::text AND q.payload->>'tmdbEpisodeId' = g.tmdb_id)
              )
        )
        ORDER BY o.episode_number
    `;

    return rows.map((r) => ({
        episodeId: r.episode_id,
        seasonNumber: r.season_number,
        episodeNumber: r.episode_number,
        ghostId: r.ghost_id,
        tmdbEpisodeId: r.tmdb_episode_id,
        targetSeasonNumber: r.target_season_number,
        targetEpisodeNumber: r.target_episode_number,
        targetSeasonId: r.target_season_id,
        evidence: r.evidence,
    }));
}

// -----------------------------------------------------------------------------
// Absolute number from the file name
// -----------------------------------------------------------------------------

/** One TMDB-identified episode row of the series, as the DB holds it. */
interface CatalogRow {
    id: string;
    parent_id: string;
    season_number: number;
    episode_number: number;
    has_files: boolean;
    metadata_locked: boolean;
    tmdb_id: string;
    title: string | null;
}

type TargetResolution =
    | {
          target: CatalogRow;
          /** Both rules (a) and (b) exist and name this row */
          corroborated: boolean;
      }
    | { target: null; reason: 'no-target' | 'disagree' | 'ambiguous' };

/**
 * The catalog in (season, episode) order for as long as it is gap-free: the
 * seasons are consecutive from 1 (season 1 then season 3 is a gap), and a season
 * either counts 1..k, or continues the absolute run (first episode = rows so
 * far + 1). The first season that is neither ends the list, because the
 * position of anything after it is unknown.
 */
function gapFreeCatalog(rows: CatalogRow[]): CatalogRow[] {
    const bySeason = new Map<number, CatalogRow[]>();
    for (const r of rows) {
        const list = bySeason.get(r.season_number) ?? [];
        list.push(r);
        bySeason.set(r.season_number, list);
    }
    const ordered: CatalogRow[] = [];
    let expectedSeason = 1;
    for (const season of [...bySeason.keys()].sort((a, b) => a - b)) {
        if (season !== expectedSeason) break;
        expectedSeason++;
        const eps = (bySeason.get(season) ?? []).sort(
            (a, b) => a.episode_number - b.episode_number,
        );
        const runsFrom = (base: number): boolean =>
            eps.every((e, i) => e.episode_number === base + i);
        if (!runsFrom(1) && !runsFrom(ordered.length + 1)) break;
        ordered.push(...eps);
    }
    return ordered;
}

/**
 * The TMDB episode a file naming absolute number N is.
 * (a) the N-th episode of the gap-free catalog; (b) the episode numbered N in a
 * season the provider numbers absolutely (no E1). Both must agree when both exist.
 */
function resolveAbsoluteTarget(rows: CatalogRow[], n: number): TargetResolution {
    const a = gapFreeCatalog(rows)[n - 1];

    const firstEpisodeOfSeason = new Map<number, number>();
    for (const r of rows) {
        const first = firstEpisodeOfSeason.get(r.season_number);
        if (first === undefined || r.episode_number < first) {
            firstEpisodeOfSeason.set(r.season_number, r.episode_number);
        }
    }
    const bCandidates = rows.filter(
        (r) => r.episode_number === n && (firstEpisodeOfSeason.get(r.season_number) ?? 1) > 1,
    );
    if (bCandidates.length > 1) return { target: null, reason: 'ambiguous' };
    const b = bCandidates[0];

    if (a && b) {
        return a.id === b.id
            ? { target: a, corroborated: true }
            : { target: null, reason: 'disagree' };
    }
    const target = a ?? b;
    return target ? { target, corroborated: false } : { target: null, reason: 'no-target' };
}

interface AbsoluteOrphanRow {
    id: string;
    season_number: number;
    episode_number: number;
    absolute_episodes: number[] | null;
    file_paths: string[] | null;
}

type TitleVerdict = 'agree' | 'disagree' | 'untitled';

const TITLE_THRESHOLD = 0.8;

/** Whether the file name carries a title that can be compared with a name at all. */
function hasUsableTitle(segments: string[]): boolean {
    return segments.some((seg) => !isGenericChapterName(seg));
}

/**
 * Compare the title the file name carries with the target's name variants.
 * 'untitled' when either side has no usable title. A multi-part title is tried
 * whole first (joined by ` - ` or a space, the way a provider writes
 * `Part One - Part Two` as one name); failing that, every usable segment must
 * match a variant on its own.
 */
function judgeTitle(segments: string[], variants: string[]): TitleVerdict {
    const usable = segments.filter((seg) => !isGenericChapterName(seg));
    const names = variants.filter((v) => !isGenericChapterName(v));
    if (usable.length === 0 || names.length === 0) return 'untitled';
    const matches = (q: string): boolean =>
        bestMatchAboveThreshold(q, names, TITLE_THRESHOLD).bestIndex !== -1;
    if (segments.length > 1 && (matches(segments.join(' - ')) || matches(segments.join(' ')))) {
        return 'agree';
    }
    return usable.every(matches) ? 'agree' : 'disagree';
}

// -----------------------------------------------------------------------------
// Decline cache
// -----------------------------------------------------------------------------

/**
 * A pair declined for a title mismatch is declined again on every metadata sync
 * of the series until the file or the target changes, and each time the check
 * loads the TMDB catalog (alt names, provider API calls). The decline is
 * remembered per (orphan episode, target TMDB episode, file title) for 7 days
 * (CACHE_NAMESPACES.absoluteNumberingDeclines). A cached decline never blocks a
 * pair whose stored target title agrees with the file title now.
 */
function declineCacheKey(
    orphanId: string,
    tmdbEpisodeId: string,
    segments: string[] | undefined,
): string | null {
    if (!segments || segments.length === 0) return null;
    const titleHash = createHash('sha1').update(segments.join('\n')).digest('hex');
    return buildVersionedCacheKey('absoluteNumberingDecline', orphanId, tmdbEpisodeId, titleHash);
}

async function isDeclineCached(
    key: string,
    seriesMediaId: string,
    episodeId: string,
): Promise<boolean> {
    try {
        const cache = cacheManager.for(CACHE_NAMESPACES.absoluteNumberingDeclines);
        const hit = await cache.get<boolean>(key);
        if (hit === true) {
            logger.debug('Skipped absolute episode: declined before for this title', {
                seriesMediaId,
                episodeId,
            });
        }
        return hit === true;
    } catch (err) {
        logger.warn('Decline cache read failed (non-fatal)', {
            seriesMediaId,
            error: err instanceof Error ? err.message : String(err),
        });
        return false;
    }
}

async function rememberDecline(key: string, seriesMediaId: string): Promise<void> {
    try {
        await cacheManager.for(CACHE_NAMESPACES.absoluteNumberingDeclines).set(key, true);
    } catch (err) {
        logger.warn('Decline cache write failed (non-fatal)', {
            seriesMediaId,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}

/**
 * Match every orphan whose file name carries an absolute episode number to the
 * TMDB episode at that number (see the file header). Declines, and leaves the
 * orphan alone, when the number is ambiguous, no gap-free target exists, the
 * target already has a file, two orphans claim the same target, or an admin
 * undid or rejected the pair.
 */
async function detectFilenameAbsolute(
    sql: postgres.Sql,
    seriesMediaId: string,
    deps: DetectDeps,
): Promise<AbsoluteNumberingMatch[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by a specific series UUID; not user-facing
    const orphans = await sql<AbsoluteOrphanRow[]>`
        SELECT mi.id, mi.season_number, mi.episode_number,
               (SELECT array_agg(DISTINCT mf.absolute_episode)
                FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = mi.id AND mf.absolute_episode IS NOT NULL
               ) AS absolute_episodes,
               (SELECT array_agg(DISTINCT mf.file_path)
                FROM media_file_items mfi
                JOIN media_files mf ON mf.id = mfi.file_id
                WHERE mfi.media_item_id = mi.id AND mf.absolute_episode IS NOT NULL
               ) AS file_paths
        FROM media_items mi
        JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE s.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND mi.has_files = true
          AND NOT mi.metadata_locked
          AND COALESCE(mi.title_binding, '') <> 'manual'
          AND mi.season_number > 0
          AND mi.episode_number IS NOT NULL
          AND ei.external_id IS NULL
        ORDER BY mi.season_number, mi.episode_number
    `;
    const withNumber = orphans.filter((o) => (o.absolute_episodes?.length ?? 0) > 0);
    if (withNumber.length === 0) return [];

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal reconciliation lookup keyed by a specific series UUID; not user-facing
    const catalog = await sql<CatalogRow[]>`
        SELECT mi.id, mi.parent_id, mi.season_number, mi.episode_number,
               mi.has_files, mi.metadata_locked, mi.title, ei.external_id AS tmdb_id
        FROM media_items mi
        JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
        JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE s.parent_id = ${seriesMediaId}
          AND mi.media_type = 'episode'
          AND mi.season_number > 0
          AND mi.episode_number IS NOT NULL
    `;

    // A pair an admin undid or rejected is not applied again (see detectNumberMatches).
    const dismissedKeys = await loadBlockedPairKeys(
        sql,
        withNumber.map((o) => o.id),
    );

    // Titles the series' own name would otherwise pass for an episode title.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal lookup keyed by a specific series UUID; not user-facing
    const [series] = await sql<{ title: string | null }[]>`
        SELECT title FROM media_items WHERE id = ${seriesMediaId}
    `;
    const seriesTitle = series?.title ?? undefined;

    // Alt names come from the TMDB catalog. The caller's loader when it has one,
    // else the same loader the apply uses, so the verdict never depends on who
    // calls (an absent loader used to mean "no alt names" and a decline).
    const getCatalog = deps.getCatalog ?? (() => loadTmdbCatalog(sql, seriesMediaId));
    let catalogById: Map<string, TmdbCatalogEpisode> | null = null;
    const catalogEntry = async (tmdbId: string): Promise<TmdbCatalogEpisode | undefined> => {
        catalogById ??= new Map((await getCatalog()).map((c) => [c.tmdbEpisodeId, c]));
        return catalogById.get(tmdbId);
    };

    const candidates: AbsoluteNumberingMatch[] = [];
    for (const orphan of withNumber) {
        const numbers = orphan.absolute_episodes ?? [];
        if (numbers.length > 1) {
            logger.info(
                'Skipped absolute episode: the files of one episode name different numbers',
                {
                    seriesMediaId,
                    episodeId: orphan.id,
                    numbers,
                },
            );
            continue;
        }
        const resolution = resolveAbsoluteTarget(catalog, numbers[0]);
        if (!resolution.target) {
            logger.debug('No target for absolute episode number', {
                seriesMediaId,
                episodeId: orphan.id,
                absoluteEpisode: numbers[0],
                reason: resolution.reason,
            });
            continue;
        }
        const target = resolution.target;
        if (target.has_files || target.metadata_locked) {
            logger.info('Skipped absolute episode: its target is not a free ghost', {
                seriesMediaId,
                episodeId: orphan.id,
                absoluteEpisode: numbers[0],
                target: `S${target.season_number}E${target.episode_number}`,
                targetHasFiles: target.has_files,
                targetLocked: target.metadata_locked,
            });
            continue;
        }
        if (dismissedKeys.has(`${orphan.id}:${target.tmdb_id}`)) continue;

        const segments = (orphan.file_paths ?? [])
            .map((fp) => releaseTitleSegments(fp.split('/').pop() ?? fp, { seriesTitle }))
            .find((segs) => segs.length > 0);
        let verdict: TitleVerdict = judgeTitle(segments ?? [], target.title ? [target.title] : []);
        const declineKey = declineCacheKey(orphan.id, target.tmdb_id, segments);
        if (
            verdict !== 'agree' &&
            declineKey &&
            (await isDeclineCached(declineKey, seriesMediaId, orphan.id))
        ) {
            // Declined before for this very pair and file title: no alt-name load.
            continue;
        }
        let catalogConsulted = false;
        if (verdict === 'disagree' || (verdict === 'untitled' && segments?.length)) {
            // The stored name may be in another language than the file's.
            const entry = await catalogEntry(target.tmdb_id);
            catalogConsulted = true;
            if (entry) {
                verdict = judgeTitle(segments ?? [], [
                    ...(target.title ? [target.title] : []),
                    entry.name,
                    ...entry.altNames,
                ]);
            }
        }
        if (verdict === 'disagree') {
            // Remember the decline once the alt names were consulted (the title
            // check has then had its full look at the pair).
            if (declineKey && catalogConsulted) await rememberDecline(declineKey, seriesMediaId);
            logger.info('Skipped absolute episode: its title does not match the target', {
                seriesMediaId,
                episodeId: orphan.id,
                absoluteEpisode: numbers[0],
                target: `S${target.season_number}E${target.episode_number}`,
                fileTitle: segments?.join(' - '),
                targetTitle: target.title,
            });
            continue;
        }
        candidates.push({
            episodeId: orphan.id,
            seasonNumber: orphan.season_number,
            episodeNumber: orphan.episode_number,
            ghostId: target.id,
            tmdbEpisodeId: target.tmdb_id,
            targetSeasonNumber: target.season_number,
            targetEpisodeNumber: target.episode_number,
            targetSeasonId: target.parent_id,
            evidence:
                verdict === 'agree'
                    ? 'filename-absolute'
                    : // No title at all in the file name, but two independent
                      // derivations (absolute position, season without an E1)
                      // name this very row.
                      resolution.corroborated && !hasUsableTitle(segments ?? [])
                      ? 'filename-absolute-corroborated'
                      : 'filename-absolute-untitled',
        });
    }

    // Two orphans claiming one target: neither is trustworthy.
    const claims = new Map<string, number>();
    for (const c of candidates) claims.set(c.ghostId, (claims.get(c.ghostId) ?? 0) + 1);
    return candidates.filter((c) => (claims.get(c.ghostId) ?? 0) === 1);
}

// =============================================================================
// Apply
// =============================================================================

/** Raised inside a pair's savepoint to roll back that pair and nothing else. */
class PairAbortError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PairAbortError';
    }
}

interface PrevEpisodeRow {
    parent_id: string | null;
    season_number: number;
    episode_number: number;
    title: string | null;
    overview: string | null;
    title_binding: string | null;
    still_path: string | null;
}

function emptyResult(): AbsoluteNumberingApplyResult {
    return { bound: 0, skipped: 0, ghostsDeleted: 0, moved: 0, proposed: 0, deferred: 0 };
}

interface AppliedPair {
    /** Id of the undo record */
    moveId: string;
    /** Rows the merge deleted (the placeholder) */
    itemsDeleted: number;
    /** Rows the move statement relocated */
    moved: number;
}

/**
 * Bind, merge and move one pair on the caller's transaction handle, and write
 * its undo record. Throws {@link PairAbortError} when the pair cannot finish;
 * the caller's savepoint then discards every write made here.
 */
async function applyPair(
    tx: postgres.Sql,
    seriesMediaId: string,
    match: AbsoluteNumberingMatch,
    catalogEp: TmdbCatalogEpisode | undefined,
): Promise<AppliedPair> {
    // Re-read the ghost inside the transaction: it must still be file-less,
    // unlocked, hold the id we are about to move AND still sit at the slot the
    // file row will adopt. A ghost relocated since detection leaves that slot to
    // another row (or to nobody); moving the file row there would collide with
    // it, or bind an identity to a position the provider no longer reports.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal TOCTOU re-check keyed by a specific episode UUID; not user-facing
    const [ghost] = await tx<
        { parent_id: string | null; season_number: number | null; episode_number: number | null }[]
    >`
        SELECT mi.parent_id, mi.season_number, mi.episode_number
        FROM media_items mi
        JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE mi.id = ${match.ghostId}
          AND mi.has_files = false
          AND NOT mi.metadata_locked
          AND ei.external_id = ${match.tmdbEpisodeId}
        FOR UPDATE OF mi
    `;
    if (!ghost) throw new PairAbortError('ghost changed since detection');
    if (
        ghost.parent_id !== match.targetSeasonId ||
        ghost.season_number !== match.targetSeasonNumber ||
        ghost.episode_number !== match.targetEpisodeNumber
    ) {
        throw new PairAbortError('ghost moved since detection');
    }

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal check keyed by a specific season UUID; not user-facing
    const [occupant] = await tx<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${match.targetSeasonId}
          AND media_type = 'episode'
          AND season_number = ${match.targetSeasonNumber}
          AND episode_number = ${match.targetEpisodeNumber}
          AND id NOT IN (${match.episodeId}, ${match.ghostId})
        LIMIT 1
    `;
    if (occupant) throw new PairAbortError('target slot is occupied');

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal read keyed by a specific episode UUID; not user-facing
    const [prev] = await tx<PrevEpisodeRow[]>`
        SELECT mi.parent_id, mi.season_number, mi.episode_number, mi.title, mi.overview,
               mi.title_binding,
               (SELECT pm.metadata->>'still_path' FROM provider_metadata pm
                WHERE pm.media_id = mi.id AND pm.provider = 'tmdb'
                  AND jsonb_typeof(pm.metadata) = 'object') AS still_path
        FROM media_items mi
        WHERE mi.id = ${match.episodeId}
        FOR UPDATE OF mi
    `;
    if (!prev) throw new PairAbortError('episode no longer exists');

    const catalogService = createCatalogService(tx, { skipLifecycleHooks: true });
    await catalogService.deleteExternalId(match.ghostId, 'tmdb', 'episode');

    const extId: ExternalIdWrite = {
        provider: 'tmdb',
        id: match.tmdbEpisodeId,
        mediaType: 'episode',
        source: 'reconciliation',
    };
    // A skipped write (the identity-swap guard) must not leave a merged ghost
    // behind with no identity bound.
    if (!(await catalogService.upsertExternalId(match.episodeId, extId, true))) {
        throw new PairAbortError('external id write was skipped');
    }

    const titled = await tx<{ id: string }[]>`
        UPDATE media_items
        SET title = COALESCE(${catalogEp?.name ?? null}, title),
            overview = COALESCE(${catalogEp?.overview ?? null}, overview),
            title_binding = 'identity',
            updated_at = NOW()
        WHERE id = ${match.episodeId}
          AND NOT metadata_locked
        RETURNING id
    `;
    if (titled.length === 0) throw new PairAbortError('episode is metadata-locked');
    await refreshSortTitles(tx, [match.episodeId]);

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
        await upsertProviderMetadataUnlessLocked(tx, match.episodeId, 'tmdb', {
            still_path: stillPath,
        });
    }

    // User state (watch flags, ratings, playlist membership) migrates onto the
    // file-backed row, and the ghost's slot is vacated. The merge opens no
    // transaction of its own; its lifecycle hooks run after our commit.
    const mergeStats = await MediaDeletionService.mergeIntoTx(tx, match.episodeId, match.ghostId);

    const moved = await tx<{ id: string }[]>`
        UPDATE media_items mi
        SET parent_id = ${match.targetSeasonId},
            season_number = ${match.targetSeasonNumber},
            episode_number = ${match.targetEpisodeNumber},
            updated_at = NOW()
        WHERE mi.id = ${match.episodeId}
          AND NOT mi.metadata_locked
        RETURNING mi.id
    `;
    if (moved.length === 0) throw new PairAbortError('episode could not be moved');

    // The old season lost a file-backed episode and the new one gained it.
    await recomputeHasFilesBatch(
        tx,
        [match.episodeId, prev.parent_id, match.targetSeasonId].filter(
            (id): id is string => id !== null,
        ),
    );

    const moveId = await insertReconciliationMove(tx, {
        seriesId: seriesMediaId,
        episodeId: match.episodeId,
        service: 'absolute-numbering',
        evidence: match.evidence,
        ghostId: match.ghostId,
        tmdbEpisodeId: match.tmdbEpisodeId,
        fromParentId: prev.parent_id,
        fromSeason: prev.season_number,
        fromEpisode: prev.episode_number,
        toParentId: match.targetSeasonId,
        toSeason: match.targetSeasonNumber,
        toEpisode: match.targetEpisodeNumber,
        prevTitleBinding: prev.title_binding,
        prevTitle: prev.title,
        prevOverview: prev.overview,
        prevStillPath: prev.still_path,
        mergeStats: { ...mergeStats },
    });
    return { moveId, itemsDeleted: mergeStats.itemsDeleted, moved: moved.length };
}

/**
 * Everything an applied pair does after its transaction committed: hooks must
 * not see rows that may still roll back. Failures are logged, never thrown.
 */
async function runPostCommit(
    sql: postgres.Sql,
    seriesMediaId: string,
    applied: { episodeId: string; ghostId: string }[],
): Promise<void> {
    for (const match of applied) {
        try {
            await MediaDeletionService.runMergeHooks(sql, match.episodeId, match.ghostId);
        } catch (err) {
            logger.warn('Merge hooks failed post-commit (non-fatal)', {
                episodeId: match.episodeId,
                ghostId: match.ghostId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
        try {
            await MediaLifecycleService.afterMetadataChanged(
                match.episodeId,
                ['title', 'overview'],
                sql,
            );
        } catch (err) {
            logger.warn('afterMetadataChanged failed post-commit (non-fatal)', {
                episodeId: match.episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    if (applied.length > 0) {
        try {
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
}

/**
 * Bind identity onto each file row, merge its ghost away and move the file row
 * into the canonical position the ghost vacated. One pair is one unit of work:
 * all of it commits, or none of it (see the file header).
 *
 * Detection is re-run under the series lock. A pair is applied only while the
 * fresh detection still reports it with the SAME evidence and the settings still
 * let that evidence apply on its own (the caller may have decided minutes ago,
 * the setting may have changed, the file name's title may no longer agree).
 * At most `maxPairsPerSync` pairs are applied; the valid rest is deferred to the
 * next sync and counted in the result.
 */
export async function applyAbsoluteNumberingFix(
    sql: postgres.Sql,
    detection: AbsoluteNumberingDetection,
    deps: AbsoluteNumberingDeps = {},
): Promise<AbsoluteNumberingApplyResult> {
    const { seriesMediaId } = detection;
    if (deps.signal?.aborted) return emptyResult();

    const catalog = deps.catalog ?? (await loadTmdbCatalog(sql, seriesMediaId));
    const catalogById = new Map(catalog.map((c) => [c.tmdbEpisodeId, c]));
    const policy = applyPolicy(deps);
    const cap = deps.maxPairsPerSync ?? MAX_APPLIED_PAIRS_PER_SYNC;

    let skipped = 0;
    let deferred = 0;
    let ghostsDeleted = 0;
    let moved = 0;
    const applied: AbsoluteNumberingMatch[] = [];

    await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Serialize with the other per-series reconciliation applies.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesMediaId})::bigint)`;

        // Re-run detection under the lock: a sync that added an E1 to the
        // target season, or another carrier of the number, since detection
        // voids that pair. So does an orphan locked or bound meanwhile, a pair
        // an admin rejected meanwhile, or a file-name title that stopped
        // agreeing (the evidence is part of the key).
        const fresh = await detectAbsoluteNumberingFix(tx, seriesMediaId, {
            getCatalog: async () => catalog,
        });
        const freshEvidence = new Map(
            (fresh?.matches ?? []).map((m) => [`${m.episodeId}:${m.ghostId}`, m.evidence]),
        );

        const episodeIds = detection.matches.map((m) => m.episodeId);
        // Staleness re-check: a concurrent reconciliation may have bound one of
        // these rows since detection — never overwrite a fresh binding.
        const alreadyBoundRows = await tx<{ media_id: string }[]>`
            SELECT media_id FROM external_ids
            WHERE media_id = ANY(${episodeIds}::uuid[])
              AND provider = 'tmdb'
              AND media_type = 'episode'
        `;
        const alreadyBound = new Set(alreadyBoundRows.map((r) => r.media_id));

        for (const match of detection.matches) {
            const current = freshEvidence.get(`${match.episodeId}:${match.ghostId}`);
            if (
                alreadyBound.has(match.episodeId) ||
                current === undefined ||
                current !== match.evidence ||
                !appliesOnItsOwn(current, policy)
            ) {
                skipped++;
                continue;
            }
            if (applied.length >= cap) {
                deferred++;
                continue;
            }

            const outcome = await inSavepoint(tx, (pairTx) =>
                applyPair(pairTx, seriesMediaId, match, catalogById.get(match.tmdbEpisodeId)),
            );
            if (outcome.ok) {
                applied.push(match);
                ghostsDeleted += outcome.value.itemsDeleted;
                moved += outcome.value.moved;
                continue;
            }
            skipped++;
            const skipInfo = {
                seriesMediaId,
                episodeId: match.episodeId,
                ghostId: match.ghostId,
                target: `${match.targetSeasonNumber}:${match.targetEpisodeNumber}`,
                reason:
                    outcome.error instanceof Error ? outcome.error.message : String(outcome.error),
            };
            if (outcome.error instanceof PairAbortError) {
                logger.info(
                    'Skipped absolute-numbering pair; nothing was written for it',
                    skipInfo,
                );
            } else {
                logger.warn('Absolute-numbering pair failed; nothing was written for it', skipInfo);
            }
        }
    });

    await runPostCommit(sql, seriesMediaId, applied);

    if (deferred > 0) {
        logger.warn('Absolute-numbering pairs deferred to the next sync (per-sync cap reached)', {
            seriesMediaId,
            deferred,
            cap,
        });
    }
    logger.info('Applied absolute-numbering fix', {
        seriesMediaId,
        bound: applied.length,
        skipped,
        deferred,
        // Every rebinding, so a wrong move can be traced; the undo records in
        // episode_reconciliation_moves are the way back.
        pairs: applied.map(
            (m) =>
                `S${m.seasonNumber}E${m.episodeNumber} -> S${m.targetSeasonNumber}E${m.targetEpisodeNumber} tmdb ${m.tmdbEpisodeId} (${m.episodeId}, ${m.evidence})`,
        ),
    });

    return {
        bound: applied.length,
        skipped,
        ghostsDeleted,
        moved,
        proposed: 0,
        deferred,
    };
}

// =============================================================================
// Apply or dismiss one proposal (admin action)
// =============================================================================

export type ProposalActionErrorCode = 'not-found' | 'already-resolved' | 'stale';

/** Why an admin's apply or dismiss of a proposal did not go through (endpoint: 404/409). */
export class ProposalActionError extends Error {
    readonly code: ProposalActionErrorCode;
    constructor(code: ProposalActionErrorCode, message: string) {
        super(message);
        this.name = 'ProposalActionError';
        this.code = code;
    }
}

export interface AppliedProposal {
    quarantineId: string;
    /** The undo record of the applied pair */
    moveId: string;
    episodeId: string;
    seasonNumber: number;
    episodeNumber: number;
}

interface ProposalPayload {
    seriesMediaId: string;
    episodeId: string;
    tmdbEpisodeId: string;
    fromSeason: number | null;
    fromEpisode: number | null;
    toSeason: number;
    toEpisode: number;
}

async function loadProposalEntry(
    sql: postgres.Sql,
    quarantineId: string,
): Promise<QuarantineEntry> {
    const entry = await getQuarantineById(sql, quarantineId);
    if (
        !entry ||
        entry.provider !== ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER ||
        entry.reason !== ABSOLUTE_NUMBERING_PROPOSED_REASON
    ) {
        throw new ProposalActionError('not-found', 'Proposal not found');
    }
    return entry;
}

function parseProposal(entry: QuarantineEntry): ProposalPayload {
    const p = entry.payload;
    const seriesMediaId =
        entry.expectedSeriesId ?? (typeof p.seriesMediaId === 'string' ? p.seriesMediaId : null);
    const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
    const toSeason = num(p.toSeason);
    const toEpisode = num(p.toEpisode);
    if (
        !seriesMediaId ||
        typeof p.episodeId !== 'string' ||
        typeof p.tmdbEpisodeId !== 'string' ||
        toSeason === null ||
        toEpisode === null
    ) {
        throw new ProposalActionError('stale', 'The proposal is incomplete and cannot be applied');
    }
    return {
        seriesMediaId,
        episodeId: p.episodeId,
        tmdbEpisodeId: p.tmdbEpisodeId,
        fromSeason: num(p.fromSeason),
        fromEpisode: num(p.fromEpisode),
        toSeason,
        toEpisode,
    };
}

/** Name the first precondition of a proposal that no longer holds. */
async function explainStaleProposal(tx: postgres.Sql, p: ProposalPayload): Promise<string> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal re-check keyed by a specific episode UUID; not user-facing
    const [ep] = await tx<
        {
            has_files: boolean;
            metadata_locked: boolean;
            title_binding: string | null;
            season_number: number;
            episode_number: number;
            tmdb_id: string | null;
        }[]
    >`
        SELECT mi.has_files, mi.metadata_locked, mi.title_binding, mi.season_number,
               mi.episode_number,
               (SELECT external_id FROM external_ids
                WHERE media_id = mi.id AND provider = 'tmdb' AND media_type = 'episode') AS tmdb_id
        FROM media_items mi
        WHERE mi.id = ${p.episodeId} AND mi.media_type = 'episode'
    `;
    if (!ep) return 'The episode no longer exists';
    if (ep.tmdb_id) return 'The episode has been bound to a TMDB episode since';
    if (!ep.has_files) return 'The episode no longer has a file';
    if (ep.metadata_locked || ep.title_binding === 'manual') return 'The episode is locked';
    if (
        (p.fromSeason !== null && ep.season_number !== p.fromSeason) ||
        (p.fromEpisode !== null && ep.episode_number !== p.fromEpisode)
    ) {
        return `The episode now sits at S${ep.season_number}E${ep.episode_number}`;
    }

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal re-check keyed by a TMDB episode id within one series; not user-facing
    const [ghost] = await tx<
        {
            has_files: boolean;
            metadata_locked: boolean;
            season_number: number;
            episode_number: number;
        }[]
    >`
        SELECT mi.has_files, mi.metadata_locked, mi.season_number, mi.episode_number
        FROM media_items mi
        JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
        JOIN external_ids ei
            ON ei.media_id = mi.id AND ei.provider = 'tmdb' AND ei.media_type = 'episode'
        WHERE s.parent_id = ${p.seriesMediaId}
          AND mi.media_type = 'episode'
          AND ei.external_id = ${p.tmdbEpisodeId}
        LIMIT 1
    `;
    if (!ghost) return 'The proposed TMDB episode is no longer in the library';
    if (ghost.has_files) return 'The proposed target episode has a file now';
    if (ghost.metadata_locked) return 'The proposed target episode is locked';
    if (ghost.season_number !== p.toSeason || ghost.episode_number !== p.toEpisode) {
        return `The proposed target moved to S${ghost.season_number}E${ghost.episode_number}`;
    }
    return 'The match does not hold any more (another episode carries the number, the season gained an E1, or the title no longer matches)';
}

/**
 * Apply one open `absolute-numbering:proposed` proposal on an admin's say-so.
 *
 * Runs the same unit of work as the automatic apply ({@link applyPair}: bind,
 * ghost merge, move and undo record in one savepoint) under the same per-series
 * advisory lock, after re-running detection under that lock: the pair must still
 * be a valid match for the proposed TMDB episode and positions, or nothing is
 * written and the proposal stays open ({@link ProposalActionError} 'stale').
 * The proposal is resolved in the same transaction as `reattached`; lifecycle
 * hooks and cache clears run after the commit.
 *
 * The ghost id of the payload is not trusted: it is the one detection finds now
 * (a sync may have recreated the ghost under a new id).
 */
export async function applyAbsoluteNumberingProposal(
    sql: postgres.Sql,
    quarantineId: string,
    resolvedBy: string,
    deps: Pick<AbsoluteNumberingDeps, 'catalog'> = {},
): Promise<AppliedProposal> {
    const entry = await loadProposalEntry(sql, quarantineId);
    if (entry.resolvedAt) {
        throw new ProposalActionError('already-resolved', 'The proposal is already resolved');
    }
    const proposal = parseProposal(entry);
    const { seriesMediaId } = proposal;

    const catalog = deps.catalog ?? (await loadTmdbCatalog(sql, seriesMediaId));
    const catalogById = new Map(catalog.map((c) => [c.tmdbEpisodeId, c]));

    const done = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${seriesMediaId})::bigint)`;

        const [row] = await tx<{ resolved_at: Date | null }[]>`
            SELECT resolved_at FROM sync_quarantine WHERE id = ${quarantineId} FOR UPDATE
        `;
        if (!row || row.resolved_at) {
            throw new ProposalActionError('already-resolved', 'The proposal is already resolved');
        }

        const fresh = await detectAbsoluteNumberingFix(tx, seriesMediaId, {
            getCatalog: async () => catalog,
        });
        const match = fresh?.matches.find(
            (m) =>
                m.episodeId === proposal.episodeId &&
                m.tmdbEpisodeId === proposal.tmdbEpisodeId &&
                m.targetSeasonNumber === proposal.toSeason &&
                m.targetEpisodeNumber === proposal.toEpisode &&
                (proposal.fromSeason === null || m.seasonNumber === proposal.fromSeason) &&
                (proposal.fromEpisode === null || m.episodeNumber === proposal.fromEpisode),
        );
        if (!match) {
            throw new ProposalActionError('stale', await explainStaleProposal(tx, proposal));
        }

        const outcome = await inSavepoint(tx, (pairTx) =>
            applyPair(pairTx, seriesMediaId, match, catalogById.get(match.tmdbEpisodeId)),
        );
        if (!outcome.ok) {
            if (outcome.error instanceof PairAbortError) {
                throw new ProposalActionError(
                    'stale',
                    `Nothing was changed: ${outcome.error.message}`,
                );
            }
            throw outcome.error;
        }

        await resolveQuarantine(tx, quarantineId, { resolvedBy, resolution: 'reattached' });
        return { match, moveId: outcome.value.moveId };
    });

    await runPostCommit(sql, seriesMediaId, [done.match]);
    logger.info('Applied absolute-numbering proposal', {
        seriesMediaId,
        quarantineId,
        resolvedBy,
        episodeId: done.match.episodeId,
        target: `S${done.match.targetSeasonNumber}E${done.match.targetEpisodeNumber}`,
        tmdbEpisodeId: done.match.tmdbEpisodeId,
        evidence: done.match.evidence,
    });

    return {
        quarantineId,
        moveId: done.moveId,
        episodeId: done.match.episodeId,
        seasonNumber: done.match.targetSeasonNumber,
        episodeNumber: done.match.targetEpisodeNumber,
    };
}

/**
 * Dismiss one open proposal. The resolved `dismissed` row is the block detection
 * consults, so neither the apply nor a new proposal is made for the pair again.
 */
export async function dismissAbsoluteNumberingProposal(
    sql: postgres.Sql,
    quarantineId: string,
    resolvedBy: string,
): Promise<void> {
    const entry = await loadProposalEntry(sql, quarantineId);
    if (entry.resolvedAt) {
        throw new ProposalActionError('already-resolved', 'The proposal is already resolved');
    }
    try {
        await resolveQuarantine(sql, quarantineId, { resolvedBy, resolution: 'dismissed' });
    } catch (err) {
        // resolveQuarantine fails with this message when another admin got there first.
        if (err instanceof Error && err.message.includes('already resolved')) {
            throw new ProposalActionError('already-resolved', 'The proposal is already resolved');
        }
        throw err;
    }
}

// =============================================================================
// Proposals
// =============================================================================

/** Who resolves a proposal the sync itself found obsolete. */
const SYSTEM_RESOLVER = 'system:reconciliation';

/**
 * Write each match as an unresolved `absolute-numbering:proposed` row, one per
 * (episode, TMDB episode) pair. A pair that already has an unresolved row is left
 * alone, so a sync does not re-stamp it every hour. A resolved row is never
 * resurrected: `dismissed` and `reattached` are an admin's decision. (A
 * dismissed pair never gets here anyway: detection excludes it.) The one
 * exception is `recreated`, which only the sync itself writes when it found a
 * proposal obsolete; if the same pair is detected again, it is proposed again.
 * Returns how many rows were written.
 */
async function proposeMatches(
    sql: postgres.Sql,
    seriesMediaId: string,
    matches: AbsoluteNumberingMatch[],
    catalogById: Map<string, TmdbCatalogEpisode>,
): Promise<number> {
    if (matches.length === 0) return 0;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal read keyed by explicit episode UUIDs; not user-facing
    const titleRows = await sql<{ id: string; title: string | null }[]>`
        SELECT id, title FROM media_items WHERE id = ANY(${matches.map((m) => m.episodeId)}::uuid[])
    `;
    const titleById = new Map(titleRows.map((r) => [r.id, r.title]));

    let written = 0;
    for (const match of matches) {
        try {
            const key = {
                provider: ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER,
                externalId: reconciliationPairKey(match.episodeId, match.tmdbEpisodeId),
                mediaType: 'episode',
            };
            const existing = await getQuarantineByKey(sql, key);
            if (existing && !(existing.resolvedAt && existing.resolution === 'recreated')) {
                continue;
            }
            // A row written before the key held the target: keyed by the episode
            // alone. Still open for this very pair means it is already proposed.
            const legacy = await getQuarantineByKey(sql, {
                ...key,
                externalId: match.episodeId,
            });
            if (
                legacy &&
                !legacy.resolvedAt &&
                legacy.payload.tmdbEpisodeId === match.tmdbEpisodeId
            ) {
                continue;
            }
            await quarantineWrite(sql, {
                ...key,
                expectedSeriesId: seriesMediaId,
                payload: {
                    seriesMediaId,
                    episodeId: match.episodeId,
                    ghostId: match.ghostId,
                    tmdbEpisodeId: match.tmdbEpisodeId,
                    fromSeason: match.seasonNumber,
                    fromEpisode: match.episodeNumber,
                    toSeason: match.targetSeasonNumber,
                    toEpisode: match.targetEpisodeNumber,
                    evidence: match.evidence,
                    currentTitle: titleById.get(match.episodeId) ?? null,
                    proposedTitle: catalogById.get(match.tmdbEpisodeId)?.name ?? null,
                },
                reason: ABSOLUTE_NUMBERING_PROPOSED_REASON,
                source: QUARANTINE_SOURCE,
            });
            written++;
        } catch (err) {
            logger.warn('Failed to write absolute-numbering proposal (non-fatal)', {
                seriesMediaId,
                episodeId: match.episodeId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return written;
}

/**
 * Resolve the open proposals of one series that no longer describe a pair the
 * sync would make: the pair is not detected any more (a file renamed, a season
 * gained an E1, the TMDB catalog changed), or the episode has an identity now.
 *
 * `QuarantineResolution` has no "superseded" value, and `dismissed` is out (it
 * is the block marker detection obeys). So:
 * - the episode carries a TMDB id now: `reattached` (it got its identity);
 * - the pair is no longer detected: `recreated` (the situation changed under the
 *   proposal; the only resolution that blocks nothing). {@link proposeMatches}
 *   treats it as reopenable.
 * Returns how many proposals were resolved.
 */
async function resolveStaleProposals(
    sql: postgres.Sql,
    seriesMediaId: string,
    detectedPairs: Set<string>,
): Promise<number> {
    const open = await listUnresolvedQuarantineByReason(sql, {
        provider: ABSOLUTE_NUMBERING_QUARANTINE_PROVIDER,
        reason: ABSOLUTE_NUMBERING_PROPOSED_REASON,
        seriesId: seriesMediaId,
        limit: 1000,
    });
    if (open.length === 0) return 0;

    const episodeIds = open
        .map((e) => e.payload.episodeId)
        .filter((id): id is string => typeof id === 'string');
    const boundRows = await sql<{ media_id: string }[]>`
        SELECT media_id FROM external_ids
        WHERE media_id = ANY(${episodeIds}::uuid[])
          AND provider = 'tmdb'
          AND media_type = 'episode'
    `;
    const bound = new Set(boundRows.map((r) => r.media_id));

    let resolved = 0;
    for (const entry of open) {
        const { episodeId, tmdbEpisodeId } = entry.payload;
        if (typeof episodeId !== 'string' || typeof tmdbEpisodeId !== 'string') continue;
        const resolution = bound.has(episodeId)
            ? 'reattached'
            : detectedPairs.has(reconciliationPairKey(episodeId, tmdbEpisodeId))
              ? null
              : 'recreated';
        if (!resolution) continue;
        try {
            await resolveQuarantine(sql, entry.id, { resolvedBy: SYSTEM_RESOLVER, resolution });
            resolved++;
        } catch {
            // Resolved by an admin in the meantime: theirs stands.
        }
    }
    if (resolved > 0) {
        logger.info('Resolved obsolete absolute-numbering proposals', { seriesMediaId, resolved });
    }
    return resolved;
}

// =============================================================================
// Auto entry point (metadata-sync hook)
// =============================================================================

/**
 * Detection is a single query and touches no provider API, so unlike the
 * season-structure hook this needs no cheap gate or negative-result backoff.
 *
 * Matches backed only by matching numbers (`number-match`) are applied when
 * RECONCILE_AUTO_APPLY_NUMBER_MATCHES is on and proposed otherwise; file-name
 * matches (`filename-absolute`, `filename-absolute-corroborated`) are applied
 * when RECONCILE_AUTO_APPLY_FILENAME_MATCHES is on and proposed otherwise;
 * untitled file-name matches are always proposed. Afterwards the open proposals
 * that went obsolete are resolved.
 */
export async function maybeAutoFixAbsoluteNumbering(
    sql: postgres.Sql,
    seriesMediaId: string,
    deps: AbsoluteNumberingDeps = {},
): Promise<AbsoluteNumberingApplyResult | null> {
    let loaded: Promise<TmdbCatalogEpisode[]> | null = null;
    const getCatalog = (): Promise<TmdbCatalogEpisode[]> =>
        (loaded ??= deps.catalog
            ? Promise.resolve(deps.catalog)
            : loadTmdbCatalog(sql, seriesMediaId));
    const detection = await detectAbsoluteNumberingFix(sql, seriesMediaId, { getCatalog });

    let result: AbsoluteNumberingApplyResult | null = null;
    if (detection) result = await actOnDetection(sql, detection, deps, getCatalog);

    if (!deps.signal?.aborted) {
        try {
            await resolveStaleProposals(
                sql,
                seriesMediaId,
                new Set(
                    (detection?.matches ?? []).map((m) =>
                        reconciliationPairKey(m.episodeId, m.tmdbEpisodeId),
                    ),
                ),
            );
        } catch (err) {
            logger.warn('Resolving obsolete proposals failed (non-fatal)', {
                seriesMediaId,
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }
    return result;
}

async function actOnDetection(
    sql: postgres.Sql,
    detection: AbsoluteNumberingDetection,
    deps: AbsoluteNumberingDeps,
    getCatalog: () => Promise<TmdbCatalogEpisode[]>,
): Promise<AbsoluteNumberingApplyResult | null> {
    const { seriesMediaId } = detection;
    const policy = applyPolicy(deps);
    const toApply = detection.matches.filter((m) => appliesOnItsOwn(m.evidence, policy));
    const toPropose = detection.matches.filter((m) => !appliesOnItsOwn(m.evidence, policy));

    let proposed = 0;
    if (toPropose.length > 0 && !deps.signal?.aborted) {
        const catalog = await getCatalog();
        proposed = await proposeMatches(
            sql,
            seriesMediaId,
            toPropose,
            new Map(catalog.map((c) => [c.tmdbEpisodeId, c])),
        );
    }

    if (toApply.length === 0) {
        return proposed > 0 ? { ...emptyResult(), proposed } : null;
    }

    logger.info('Absolute-numbering mismatch detected, auto-applying', {
        seriesMediaId,
        matches: toApply.length,
        proposed,
    });

    // The apply re-checks the policy under the lock, with the same settings.
    const result = await applyAbsoluteNumberingFix(
        sql,
        { seriesMediaId, matches: toApply },
        {
            ...deps,
            autoApplyNumberMatches: policy.numberMatches,
            autoApplyFilenameMatches: policy.filenameMatches,
        },
    );
    return { ...result, proposed };
}
