// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integrity Scanner — native defineTask implementation.
 *
 * Daily background scan that surfaces structural integrity violations across
 * the catalog. Each scan is a focused SQL probe for one named rule; findings
 * are upserted into `integrity_violations` and admins triage them via
 * `/api/admin/integrity`.
 *
 * Idempotency: every scan calls `recordViolation` (upsert on the open row)
 * followed by `reconcileViolationsForRule` to auto-resolve findings the
 * latest pass no longer surfaces. Re-running the task on a stable database
 * does not duplicate rows.
 *
 * Configuration:
 * - SYNC_INTEGRITY_SCANNER_INTERVAL: Duration-string override for the default
 *   24h cadence (e.g. '6h', '12h'). Read via schedule.envOverride.
 * - DISABLE_INTEGRITY_SCANNER: Set to 'true' to disable.
 */

import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask, TaskError } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import {
    recordViolation,
    reconcileViolationsForRule,
    countOpenViolationsByRule,
    type IntegritySeverity,
} from '../../../database/queries/integrity-violations.queries.js';
import {
    markFailedPermanentBatch,
    markCompletedBatch,
} from '../../../database/queries/stage-state.queries.js';
import { countDistinctSeriesWithUnresolvedQuarantine } from '../../../database/queries/sync-quarantine.queries.js';
import { registry } from '../../registry.js';
import { INTEGRITY_MAX_FINDINGS_PER_RULE } from '$lib/server/config.js';
import { classifyInfraError } from '../../infra-retry.js';

// =============================================================================
// Constants
// =============================================================================

// Cap probe scans so a single broken table can't unbounded-scan during a
// rolling outage. 2026-05-24: bumped default 1000→5000 because the
// `integrity-file-present` rule on preprod accumulated 108k pending stage
// rows that drained at 1000/day (≈108 days to clear). 5000/day clears the
// same backlog in ≈22 days. Operators with bigger libraries can override
// via INTEGRITY_MAX_FINDINGS_PER_RULE in config.ts. The cap still bounds
// per-run wall-clock and memory — applyRuleFindings does N upserts per
// finding.
// Read per use (a live config binding): a saved cap applies to the next scan.
const maxFindingsPerRule = (): number => INTEGRITY_MAX_FINDINGS_PER_RULE;

// Threshold for the global quarantine-backlog rule — a count of DISTINCT
// SERIES carrying unresolved sync_quarantine rows, not raw rows. Quarantine
// rows concentrate in a small number of series (one reconciliation-backfill
// run over one series can quarantine dozens of episodes at once), so a
// raw-row threshold read a bounded problem ("20 series need review") as an
// unbounded one ("thousands of rows") and never cleared even after the
// per-series triage UI (/admin/library/quarantine) closed most series out.
const QUARANTINE_BACKLOG_SERIES_THRESHOLD = 10;
// Escalate only when the actionable backlog itself has remained unreviewed.
const QUARANTINE_BACKLOG_WARNING_AGE_DAYS = 14;

// =============================================================================
// Rule identifiers (kebab-case, used as the persisted `rule` column)
// =============================================================================

const RULE_EPISODE_JF_ONLY = 'episode-jellyfin-only-under-tmdb-series';
const RULE_FILES_NO_DEFAULT = 'media-item-files-without-default';
const RULE_EPISODE_BAD_PARENT = 'episode-parent-not-season';
const RULE_SEASON_BAD_PARENT = 'season-parent-invalid';

/**
 * Container media types under which a `season` row is legitimate. `tv` is the
 * canonical case; `home_video`, `educational`, `training`, `personal`, `extra`
 * are the personal-collection types Lumastra supports for non-TMDB libraries.
 * Anything else as a parent is a structural bug.
 */
const SEASON_VALID_PARENT_TYPES = [
    'tv',
    'home_video',
    'educational',
    'training',
    'personal',
    'extra',
] as const;
const RULE_UNPROBED_STALE = 'unprobed-files-stale';
const RULE_QUARANTINE_BACKLOG = 'quarantine-backlog-large';

// Stage ID driven by this task's coversStages declaration.
const STAGE_INTEGRITY_FILE_PRESENT = 'integrity-file-present';

// Batch size for stage-state writes to avoid oversized UPDATE statements.
const STAGE_STATE_BATCH_SIZE = 500;

// =============================================================================
// Types
// =============================================================================

const inputSchema = z.object({}).passthrough();

type IntegrityScannerInput = z.infer<typeof inputSchema>;

interface IntegrityScannerResult {
    totalOpen: number;
    totalRecorded: number;
    totalReconciled: number;
    stageFailed: number;
    stageCompleted: number;
    errors: string[];
}

// =============================================================================
// Helpers
// =============================================================================

interface ScanFinding {
    mediaId: string | null;
    severity: IntegritySeverity;
    details: Record<string, unknown>;
}

/**
 * Persist findings + reconcile auto-resolved rows for a single rule.
 *
 * `findings` is the authoritative current set: anything in `integrity_violations`
 * for this rule that is NOT in this set gets stamped resolved. Pass an empty
 * array to clear the rule entirely.
 *
 * Cap detection uses the "fetch one extra" trick: scans LIMIT to
 * `maxFindingsPerRule() + 1` so we can distinguish a true count of exactly
 * maxFindingsPerRule() (no cap hit) from a true count > maxFindingsPerRule()
 * (cap hit). Without the +1, a rule whose true count happens to equal the cap
 * would be misclassified as capped and never reconcile.
 */
async function applyRuleFindings(
    sql: postgres.Sql,
    rule: string,
    findings: ScanFinding[],
    logger: { warn(msg: string): void },
): Promise<{ recorded: number; reconciled: number }> {
    // Detect cap before recording: if findings.length > maxFindingsPerRule(),
    // the scan returned the sentinel extra row that proves the true count
    // exceeds the cap. Trim back to maxFindingsPerRule() for recording so
    // we never persist the sentinel. When findings.length <= cap, the true
    // count is exactly findings.length and reconciliation is safe.
    const cappedHit = findings.length > maxFindingsPerRule();
    const recordSet = cappedHit ? findings.slice(0, maxFindingsPerRule()) : findings;

    const seenMediaIds: string[] = [];
    let seenGlobal = false;

    for (const finding of recordSet) {
        await recordViolation(sql, {
            rule,
            severity: finding.severity,
            mediaId: finding.mediaId,
            details: finding.details,
        });
        if (finding.mediaId === null) {
            seenGlobal = true;
        } else {
            seenMediaIds.push(finding.mediaId);
        }
    }

    // When the cap is hit we do not have the complete set of violations, so
    // reconciliation would incorrectly auto-resolve findings beyond the cap on
    // every run. Skip it — open violations stay open until a future run where
    // true count falls at or below maxFindingsPerRule().
    let reconciled = 0;
    if (!cappedHit) {
        reconciled = await reconcileViolationsForRule(sql, rule, seenMediaIds, seenGlobal);
    } else {
        logger.warn(
            `Rule ${rule} hit ${maxFindingsPerRule()}-finding cap; reconciliation skipped (true count is higher)`,
        );
    }

    return { recorded: recordSet.length, reconciled };
}

// =============================================================================
// Scan implementations
// =============================================================================

/**
 * Episodes whose only external_id is jellyfin while the parent series has a
 * TMDB primary. These are the W2.2 "phantom episode" rows the rework should
 * have prevented; they need to be auto-identified or quarantined.
 */
async function scanEpisodeJellyfinOnly(sql: postgres.Sql): Promise<ScanFinding[]> {
    // LIMIT cap+1 so applyRuleFindings can distinguish true-count==cap from
    // true-count>cap (see fetch-one-extra trick in applyRuleFindings).
    const rows = await sql<
        Array<{
            media_id: string;
            series_id: string;
            series_tmdb: string | null;
        }>
    >`
        SELECT e.id AS media_id,
               season.parent_id AS series_id,
               (
                   SELECT external_id
                   FROM external_ids
                   WHERE media_id = season.parent_id
                     AND provider = 'tmdb'
                     AND is_primary = TRUE
                   LIMIT 1
               ) AS series_tmdb
        FROM media_items e
        JOIN media_items season
            ON season.id = e.parent_id
           AND season.media_type = 'season'
        JOIN external_ids series_ei
            ON series_ei.media_id = season.parent_id
           AND series_ei.provider = 'tmdb'
           AND series_ei.is_primary = TRUE
        WHERE e.media_type = 'episode'
          AND NOT e.is_dismissed
          AND e.status != 'deleted'
          AND EXISTS (
              SELECT 1 FROM external_ids
              WHERE media_id = e.id AND provider = 'jellyfin'
          )
          AND NOT EXISTS (
              SELECT 1 FROM external_ids
              WHERE media_id = e.id AND provider = 'tmdb'
          )
          -- Contamination shape: no canonical id (tmdb or imdb) AND no files.
          -- Episodes with files but no canonical id are usually a TMDB metadata
          -- gap (long-running anime where local files outnumber TMDB's catalog),
          -- not contamination — operators accept those as-is. The pure phantom
          -- shape we want to surface is "Jellyfin says it exists but there's
          -- nothing on disk to back it up and no TMDB to identify it."
          AND NOT EXISTS (
              SELECT 1 FROM external_ids
              WHERE media_id = e.id AND provider = 'imdb'
          )
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items WHERE media_item_id = e.id
          )
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((row) => ({
        mediaId: row.media_id,
        severity: 'high' as const,
        details: {
            seriesId: row.series_id,
            seriesTmdbId: row.series_tmdb,
        },
    }));
}

/**
 * Media items with at least one file but no `is_default=TRUE` row. The W3.1
 * sibling-promotion fix should keep this empty; surfacing it catches any
 * regression in the default-promotion code path.
 *
 * Soft-dismissed media items are excluded — admins have already triaged
 * those rows, so flagging their missing-default files would be noise.
 */
async function scanFilesWithoutDefault(sql: postgres.Sql): Promise<ScanFinding[]> {
    const rows = await sql<Array<{ media_id: string; file_count: string }>>`
        SELECT mfi.media_item_id AS media_id,
               COUNT(*)::text AS file_count
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE NOT mi.is_dismissed
          AND mi.status != 'deleted'
        GROUP BY mfi.media_item_id
        HAVING SUM(CASE WHEN mfi.is_default THEN 1 ELSE 0 END) = 0
           AND COUNT(*) > 0
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((row) => ({
        mediaId: row.media_id,
        severity: 'high' as const,
        details: {
            fileCount: parseInt(row.file_count, 10),
        },
    }));
}

/**
 * Episode rows whose parent is not a season. The hierarchy invariants
 * (migration 12.66.0) should make this impossible going forward; this scan
 * catches any pre-trigger rows that slipped through.
 *
 * LEFT JOIN catches the orphan case where parent_id IS NULL or points to a
 * deleted parent; INNER JOIN would silently drop those rows from the result
 * set even though they are exactly the violations we want to surface.
 * Parent-missing rows surface with `parent_type='<NULL>'`.
 */
async function scanEpisodeBadParent(sql: postgres.Sql): Promise<ScanFinding[]> {
    const rows = await sql<
        Array<{
            media_id: string;
            parent_id: string | null;
            parent_type: string | null;
        }>
    >`
        SELECT e.id AS media_id,
               e.parent_id,
               p.media_type AS parent_type
        FROM media_items e
        LEFT JOIN media_items p ON p.id = e.parent_id
        WHERE e.media_type = 'episode'
          AND NOT e.is_dismissed
          AND e.status != 'deleted'
          AND (p.id IS NULL OR p.media_type != 'season')
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((row) => ({
        mediaId: row.media_id,
        severity: 'critical' as const,
        details: {
            parentId: row.parent_id,
            parentType: row.parent_type ?? '<NULL>',
        },
    }));
}

/**
 * Season rows whose parent is not a tv. Same invariant as above; this is the
 * other half of the hierarchy check.
 *
 * LEFT JOIN: same orphan rationale as scanEpisodeBadParent — a season with
 * parent_id IS NULL (or pointing at a deleted series row) must surface as a
 * finding rather than silently disappear from the result set.
 */
async function scanSeasonBadParent(sql: postgres.Sql): Promise<ScanFinding[]> {
    const rows = await sql<
        Array<{
            media_id: string;
            parent_id: string | null;
            parent_type: string | null;
        }>
    >`
        SELECT s.id AS media_id,
               s.parent_id,
               p.media_type AS parent_type
        FROM media_items s
        LEFT JOIN media_items p ON p.id = s.parent_id
        WHERE s.media_type = 'season'
          AND NOT s.is_dismissed
          AND s.status != 'deleted'
          AND (p.id IS NULL OR p.media_type != ALL(${SEASON_VALID_PARENT_TYPES as unknown as string[]}::text[]))
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((row) => ({
        mediaId: row.media_id,
        severity: 'critical' as const,
        details: {
            parentId: row.parent_id,
            parentType: row.parent_type ?? '<NULL>',
        },
    }));
}

/**
 * Files that have been sitting unprobed for more than 7 days. Indicates the
 * probe pipeline is stuck (worker dead, lock held, fetch error loop). The
 * `media_id` column on `integrity_violations` isn't FK-constrained so it's OK
 * to use the file UUID here — the admin UI links straight to the file row.
 *
 * Files with a non-empty `health_issues` array are excluded: they can never be
 * probed and are already explained by that permanent entry on the file-health
 * alert (prod: 7 of 7 such rows were explained files, container_unreadable or
 * episode_number_unparsed). Counting them here double-reports them and wrongly
 * suggests the probe queue is stuck. The CASE guard keeps a non-array value
 * from making jsonb_array_length raise.
 */
async function scanUnprobedStale(sql: postgres.Sql): Promise<ScanFinding[]> {
    const rows = await sql<Array<{ media_id: string; file_path: string; age_days: string }>>`
        SELECT mf.id AS media_id,
               mf.file_path,
               EXTRACT(EPOCH FROM (NOW() - mf.created_at)) / 86400 AS age_days
        FROM media_files mf
        WHERE mf.probed_at IS NULL
          AND mf.is_missing = FALSE
          AND mf.created_at < NOW() - INTERVAL '7 days'
          AND CASE WHEN jsonb_typeof(mf.health_issues) = 'array'
                   THEN jsonb_array_length(mf.health_issues)
                   ELSE 0 END = 0
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((row) => ({
        mediaId: row.media_id,
        severity: 'medium' as const,
        details: {
            filePath: row.file_path,
            ageDays: Math.round(parseFloat(row.age_days) * 10) / 10,
        },
    }));
}

/**
 * Global rule (NULL media_id): trips when the number of DISTINCT series
 * carrying actionable unresolved sync_quarantine rows exceeds the threshold.
 * Young backlogs are informational; only aged actionable rows spanning more
 * than the same series threshold escalate to a warning. Counts describe
 * series to triage via `/admin/library/quarantine`, rather than raw rows.
 */
async function scanQuarantineBacklog(sql: postgres.Sql): Promise<ScanFinding[]> {
    const seriesCount = await countDistinctSeriesWithUnresolvedQuarantine(sql);
    if (seriesCount <= QUARANTINE_BACKLOG_SERIES_THRESHOLD) return [];
    const olderThan = new Date(
        Date.now() - QUARANTINE_BACKLOG_WARNING_AGE_DAYS * 24 * 60 * 60 * 1000,
    );
    const agedSeriesCount = await countDistinctSeriesWithUnresolvedQuarantine(sql, olderThan);
    return [
        {
            mediaId: null,
            severity: agedSeriesCount > QUARANTINE_BACKLOG_SERIES_THRESHOLD ? 'medium' : 'low',
            details: {
                seriesCount,
                agedSeriesCount,
                threshold: QUARANTINE_BACKLOG_SERIES_THRESHOLD,
                warningAgeDays: QUARANTINE_BACKLOG_WARNING_AGE_DAYS,
            },
        },
    ];
}

/**
 * Media items (movie / episode / track) whose default file is marked
 * `is_missing = TRUE`. These are the items that should land as
 * `failed_permanent` on the `integrity-file-present` stage.
 *
 * Only considers non-dismissed items that have a coverage row for the stage
 * (i.e. `afterCreated` has already seeded the row). Items without a coverage
 * row are not yet eligible — they will be seeded on the next lifecycle event.
 *
 * LIMIT cap+1 trick for consistent cap-detection with applyRuleFindings.
 */
async function scanMissingDefaultFiles(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<Array<{ media_item_id: string }>>`
        SELECT mfi.media_item_id
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        JOIN media_item_stage_state miss
          ON miss.media_item_id = mfi.media_item_id
         AND miss.stage_id = ${STAGE_INTEGRITY_FILE_PRESENT}
        WHERE mfi.is_default = TRUE
          AND mf.is_missing = TRUE
          AND NOT mi.is_dismissed
          AND mi.status != 'deleted'
          AND mi.media_type IN ('movie', 'episode', 'track')
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((r) => r.media_item_id);
}

/**
 * Media items (movie / episode / track) whose default file is present
 * (`is_missing = FALSE`, `probed_at IS NOT NULL`) and have a coverage row for
 * `integrity-file-present` that is not already `completed`. These are
 * candidates to be marked `completed` once the file is confirmed reachable.
 *
 * LIMIT cap+1 for consistency, though in practice this set is only relevant
 * for rows that were previously `failed_permanent` and now need clearing.
 */
async function scanPresentDefaultFiles(sql: postgres.Sql): Promise<string[]> {
    const rows = await sql<Array<{ media_item_id: string }>>`
        SELECT mfi.media_item_id
        FROM media_file_items mfi
        JOIN media_files mf ON mf.id = mfi.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        JOIN media_item_stage_state miss
          ON miss.media_item_id = mfi.media_item_id
         AND miss.stage_id = ${STAGE_INTEGRITY_FILE_PRESENT}
        WHERE mfi.is_default = TRUE
          AND mf.is_missing = FALSE
          AND mf.probed_at IS NOT NULL
          AND NOT mi.is_dismissed
          AND mi.status != 'deleted'
          AND mi.media_type IN ('movie', 'episode', 'track')
          AND miss.status != 'completed'
        LIMIT ${maxFindingsPerRule() + 1}
    `;
    return rows.map((r) => r.media_item_id);
}

/**
 * Write `integrity-file-present` stage-state rows for a batch of item IDs.
 * Chunks the input to avoid oversized UPDATE statements.
 */
async function writeStageStateBatch(
    sql: postgres.Sql,
    missingIds: string[],
    presentIds: string[],
    logger: { warn(msg: string): void; debug(msg: string, meta?: object): void },
): Promise<{ stageFailed: number; stageCompleted: number }> {
    let stageFailed = 0;
    let stageCompleted = 0;

    const fileMissingError = {
        code: 'file-missing',
        message: 'Default file unreachable',
        retryable: false,
    };

    for (let i = 0; i < missingIds.length; i += STAGE_STATE_BATCH_SIZE) {
        const chunk = missingIds.slice(i, i + STAGE_STATE_BATCH_SIZE);
        stageFailed += await markFailedPermanentBatch(sql, {
            stageId: STAGE_INTEGRITY_FILE_PRESENT,
            mediaItemIds: chunk,
            error: fileMissingError,
        });
    }

    for (let i = 0; i < presentIds.length; i += STAGE_STATE_BATCH_SIZE) {
        const chunk = presentIds.slice(i, i + STAGE_STATE_BATCH_SIZE);
        stageCompleted += await markCompletedBatch(sql, {
            stageId: STAGE_INTEGRITY_FILE_PRESENT,
            mediaItemIds: chunk,
        });
    }

    logger.debug('integrity-file-present stage-state writes', {
        stageFailed,
        stageCompleted,
    });

    return { stageFailed, stageCompleted };
}

// =============================================================================
// Task definition
// =============================================================================

export const integrityScannerTask = defineTask<IntegrityScannerInput, IntegrityScannerResult>({
    id: 'integrity-scanner',
    purpose: 'library',
    confirmBeforeRun: true,
    name: 'Integrity Scanner',
    version: '1.0.0',
    processingVersion: 1,
    minAppVersion: '0.0.0',

    capabilities: { database: true, cache: true },

    // 2026-05-24: dropped 24h → 6h to drain pending integrity-stage backlogs
    // 4× faster. Combined with INTEGRITY_MAX_FINDINGS_PER_RULE bump 5000→25000
    // yields 100k drained per day (5 stages × 25000 ÷ 6h cadence). Per-run
    // wall-clock stays bounded — each rule does at most 25000 cheap upserts.
    // Bonus side effect: new contamination surfaces in /admin/ingest within
    // 6h instead of 24h. Operators can dial back via env override if the
    // 4× scheduler load is unwanted.
    schedule: {
        every: '6h',
        runOnStartup: false,
        envOverride: 'SYNC_INTEGRITY_SCANNER_INTERVAL',
    },

    identityFor: (input) =>
        `global-${typeof (input as Record<string, unknown>).mode === 'string' ? ((input as Record<string, unknown>).mode as string) : 'catchup'}`,
    scope: 'global',
    // File-fast path — operators expect this to surface missing-file events
    // promptly. Moving from `maintenance` (shared with cache cleanup etc.)
    // keeps it from queueing behind unrelated housekeeping.
    resourceClass: 'ingest',

    inputSchema,

    coversStages: [
        {
            id: 'integrity-file-present',
            appliesTo: ['movie', 'episode', 'track'] as const,
            // Fileless items cannot be classified by the default-file scans.
            // Keep the row for reattach recovery; the coverage sweep disposes
            // detached rows without enqueueing this scheduled scanner. The SQL
            // predicate rechecks links atomically when disposing a row.
            eligibility: {
                sql: (sql) => sql`EXISTS (
                    SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id
                )`,
            },
            invalidatedBy: ['file.attached', 'file.detached', 'file.contentChanged'] as const,
            // sweep-style scan — the scanner's own schedule drives classification;
            // per-item enqueue via stage-sweep is not appropriate here.
            enqueueable: false,
        },
    ],

    timeout: { hard: '30m', soft: '25m' },

    retry: {
        attempts: 3,
        backoff: 'exponential',
        retryOn: classifyInfraError,
    },

    async execute(ctx) {
        const { sql, logger, signal } = ctx;

        if (config.DISABLE_INTEGRITY_SCANNER) {
            return {
                success: true,
                itemsProcessed: 0,
                result: {
                    totalOpen: 0,
                    totalRecorded: 0,
                    totalReconciled: 0,
                    stageFailed: 0,
                    stageCompleted: 0,
                    errors: [],
                },
            };
        }

        const startTime = Date.now();

        const scans: Array<{
            rule: string;
            run: (sql: postgres.Sql) => Promise<ScanFinding[]>;
        }> = [
            { rule: RULE_EPISODE_JF_ONLY, run: scanEpisodeJellyfinOnly },
            { rule: RULE_FILES_NO_DEFAULT, run: scanFilesWithoutDefault },
            { rule: RULE_EPISODE_BAD_PARENT, run: scanEpisodeBadParent },
            { rule: RULE_SEASON_BAD_PARENT, run: scanSeasonBadParent },
            { rule: RULE_UNPROBED_STALE, run: scanUnprobedStale },
            { rule: RULE_QUARANTINE_BACKLOG, run: scanQuarantineBacklog },
        ];

        let totalRecorded = 0;
        let totalReconciled = 0;
        const errors: string[] = [];
        const perRule: Record<string, { recorded: number; reconciled: number }> = {};

        for (let i = 0; i < scans.length; i++) {
            if (signal.aborted) {
                logger.info('Integrity scan aborted by user request', {
                    completedScans: i,
                    totalScans: scans.length,
                });
                break;
            }
            const { rule, run } = scans[i];
            if (rule === RULE_QUARANTINE_BACKLOG) {
                try {
                    // Reuse the reconciliation traversal in warning-only mode: no
                    // provider I/O, matching, identity changes or missing-subject inference.
                    const { reevaluateQuarantineBacklog } =
                        await import('../../../services/episode-reconciliation.service.js');
                    const cursorKey = 'v1:quarantine-cleanup:cursor';
                    const after = (await ctx.cache?.get<string>(cursorKey)) ?? undefined;
                    const cleanup = await reevaluateQuarantineBacklog(sql, {
                        cap: 500,
                        after,
                        actor: 'integrity-scanner',
                        warningOnly: true,
                        signal,
                    });
                    if (!signal.aborted) {
                        if (cleanup.continuation)
                            await ctx.cache?.set(
                                cursorKey,
                                cleanup.continuation,
                                30 * 24 * 60 * 60 * 1000,
                            );
                        else await ctx.cache?.del(cursorKey);
                    }
                    logger.info('Quarantine warning cleanup', cleanup);
                } catch (error) {
                    logger.warn('Quarantine warning cleanup failed', {
                        reason: error instanceof Error ? error.message : String(error),
                    });
                }
            }
            try {
                if (signal.aborted) break;
                const findings = await run(sql);
                const result = await applyRuleFindings(sql, rule, findings, logger);
                perRule[rule] = result;
                totalRecorded += result.recorded;
                totalReconciled += result.reconciled;
                logger.debug(`Integrity scan: ${rule}`, {
                    findings: result.recorded,
                    autoResolved: result.reconciled,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn(`Integrity scan: ${rule} failed`, {
                    reason: message,
                });
                errors.push(`${rule}: ${message}`);
            }
            ctx.reportProgress(i + 1, scans.length + 1, rule);
        }

        // Stage-state sweep: classify integrity-file-present rows based on
        // whether each item's default file is present or missing.
        let stageFailed = 0;
        let stageCompleted = 0;

        if (!signal.aborted) {
            try {
                const [missingIds, presentIds] = await Promise.all([
                    scanMissingDefaultFiles(sql),
                    scanPresentDefaultFiles(sql),
                ]);
                const stageResult = await writeStageStateBatch(sql, missingIds, presentIds, logger);
                stageFailed = stageResult.stageFailed;
                stageCompleted = stageResult.stageCompleted;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                logger.warn('Integrity scan: stage-state sweep failed', {
                    reason: message,
                });
                errors.push(`stage-state-sweep: ${message}`);
            }
            ctx.reportProgress(scans.length + 1, scans.length + 1, 'stage-state-sweep');
        }

        // Final summary uses the open-violations counter since `totalRecorded`
        // includes upserts that didn't change anything. Admins want to see
        // "how many open issues right now" not "how many findings did we
        // touch this run".
        let totalOpen = 0;
        try {
            const counts = await countOpenViolationsByRule(sql);
            totalOpen = Object.values(counts).reduce((a, b) => a + b, 0);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.warn('Integrity scan: countOpenViolationsByRule failed', {
                reason: message,
            });
            errors.push(`count-open: ${message}`);
        }

        const duration = Date.now() - startTime;
        const success = errors.length === 0;

        if (
            totalRecorded > 0 ||
            totalReconciled > 0 ||
            totalOpen > 0 ||
            stageFailed > 0 ||
            stageCompleted > 0
        ) {
            logger.info('Integrity scan completed', {
                totalOpen,
                totalRecorded,
                totalReconciled,
                stageFailed,
                stageCompleted,
                errorCount: errors.length,
                duration,
            });
        }

        if (signal.aborted) {
            return {
                success: false,
                itemsProcessed: totalRecorded,
                stopReason: 'aborted',
                result: {
                    totalOpen,
                    totalRecorded,
                    totalReconciled,
                    stageFailed,
                    stageCompleted,
                    errors,
                },
            };
        }

        // False-success guard: `success` above is never read by the runner —
        // it only inspects thrown errors / stopReason to decide run outcome —
        // so a run where every rule scan + the stage-state sweep + the
        // open-violations count all errored (e.g. the DB connection dropped
        // mid-run) previously still returned normally and was recorded
        // 'completed', crediting the circuit breaker despite a total outage.
        // Each probe here is wrapped in its own try/catch specifically so one
        // broken rule can't take down the others — but that per-probe
        // isolation is exactly what let a total outage hide as "0 findings,
        // 0 reconciled, quietly fine". Mirrors the total-outage gate used
        // elsewhere in the false-success cluster (database-cleanup.ts,
        // curated-lists-sync, mdblist-sync, etc.): only throw when NOTHING
        // useful happened this run (no findings recorded/reconciled, no
        // stage-state writes) while errors piled up. A single failed rule
        // among five healthy ones stays non-fatal.
        const producedWork =
            totalRecorded > 0 || totalReconciled > 0 || stageFailed > 0 || stageCompleted > 0;
        if (errors.length > 0 && !producedWork) {
            throw new TaskError({
                message:
                    `integrity-scanner: total failure — 0 findings recorded/reconciled and ` +
                    `0 stage-state writes across ${errors.length} probe error(s): ` +
                    `${errors.slice(0, 3).join('; ')}` +
                    (errors.length > 3 ? ` (+${errors.length - 3} more)` : ''),
                kind: 'transient',
                cause: errors,
            });
        }

        return {
            success,
            itemsProcessed: totalRecorded,
            result: {
                totalOpen,
                totalRecorded,
                totalReconciled,
                stageFailed,
                stageCompleted,
                errors,
            },
        };
    },
});

registry.registerTask(integrityScannerTask);
