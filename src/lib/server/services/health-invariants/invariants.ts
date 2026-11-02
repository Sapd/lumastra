// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import {
    refreshSplitAlbumHealth,
    listSplitAlbumHealth,
} from '../../database/queries/album-split-health.queries.js';
import { actionableTaskFailure } from '../../database/queries/fragments/task-failure.fragments.js';
import {
    countFailedSessions24h,
    topFailingEncoders24h,
} from '../../database/queries/transcode-failure-events.queries.js';
import { registry } from '$lib/server/tasks/registry.js';
import type {
    StageTerminalDisposition,
    StageDispositionFragmentBuilder,
} from '$lib/types/pipeline.js';
import { checkMetadataStorageWritability } from './metadata-storage-writability.js';
import {
    countUnconfirmedCleanupHolds,
    listCleanupHolds,
} from '../../database/queries/library-cleanup-holds.queries.js';
import {
    buildQuietUpstreamFragment,
    buildUpstreamRunFragment,
} from '$lib/server/tasks/stage-disposition-runner.js';
import { taskDisplayName } from '$lib/utils/admin/task-names.js';
import { getJellyfinPairingStatus } from '../jellyfin-pairing-status.service.js';
import { features } from '../../config.js';
import { stat } from 'node:fs/promises';

/**
 * Declarative Stage Contract — wedge-guard tuning constants (Invariant 2).
 *
 * `stage-sweep` runs every 60s. A `self-terminal` stage promises it terminally
 * writes EVERY candidate it is handed. A row that is still `pending` with a
 * non-trivial attempt count, long after it was first enqueued, means the task
 * is being handed work it neither completes nor disposes — a forming wedge.
 *
 * - `WEDGE_MIN_ATTEMPTS` (N): the row has been picked up at least this many
 *   times without reaching a terminal status (3 ≈ past transient flakiness).
 * - `WEDGE_STALE_MINUTES` (K cycles, expressed as minutes): the row has been
 *   sitting at least this long (30 min ≈ 30 sweep cycles), well past any
 *   normal retry/backoff window.
 */
const WEDGE_MIN_ATTEMPTS = 3;
const WEDGE_STALE_MINUTES = 30;

/**
 * Dispose-coverage grace for Check 1a/1b (predicate/eligibility disposition).
 *
 * Those checks assume "after the disposition has run, the out-of-domain
 * intersection is empty". That held when stage-sweep disposed EVERY stage every
 * 60s tick — but the sweep now ROTATES its starting task per tick (D1 fairness)
 * and bails at the soft-timeout, so a given stage's bulk eligibility-dispose
 * runs roughly once per full rotation (~tens of minutes), NOT every tick. During
 * a bulk discovery/metadata import that seeds thousands of file-less episodes
 * (each transiently out-of-domain for the file stages until the next rotation
 * disposes it), the intersection is legitimately non-empty for that window, so
 * the un-gated checks false-fire CRITICAL on normal operation (observed 430→1273
 * in 16 min on a prod import, all `has_files=false` discovery episodes that the
 * next sweep disposes to skipped_permanent).
 *
 * Gate both checks on row age: only count a sweepable out-of-domain row whose
 * `updated_at` is older than this grace — i.e. one the rotation SHOULD have
 * disposed by now but didn't. Comfortably exceeds the rotation period so a
 * transient burst row is never counted, while a genuinely-wedged row (a stale
 * fragment the dispose can't drain) still surfaces once it ages past the grace.
 */
const WEDGE_DISPOSE_GRACE_MINUTES = 60;

/**
 * Outbox-pending overdue grace. The dispatcher clears a healthy backlog within
 * seconds-to-minutes, so an event still unprocessed past this is a sign it is
 * genuinely falling behind — not a transient burst it is actively draining.
 * Counting only overdue events stops the warning from firing on a large but
 * fast-draining import backlog (which raw depth did). Comfortably above the
 * dispatcher's normal per-event latency.
 */
const OUTBOX_OVERDUE_GRACE_MINUTES = 15;

/**
 * Enumerate registered enqueueable stages whose declared `terminalDisposition`
 * includes a variant of the given kind. Returns `{ stageId, disposition }`
 * pairs for the matching variants. Drives the wedge-guard invariants below
 * from the declarations (not a hand-maintained list).
 */
function stagesWithDispositionKind(
    kind: StageTerminalDisposition['kind'],
): Array<{ stageId: string; disposition: StageTerminalDisposition }> {
    const out: Array<{
        stageId: string;
        disposition: StageTerminalDisposition;
    }> = [];
    for (const task of registry.getAllTasks()) {
        for (const stage of task.coversStages ?? []) {
            if (stage.enqueueable !== true) continue;
            const decl = stage.terminalDisposition;
            if (decl === undefined) continue;
            const list: ReadonlyArray<StageTerminalDisposition> = Array.isArray(decl)
                ? decl
                : [decl];
            for (const d of list) {
                if (d.kind === kind) out.push({ stageId: stage.id, disposition: d });
            }
        }
    }
    return out;
}

/**
 * Enumerate registered enqueueable stages that declare `eligibility.sql` AND
 * whose generic `NOT(sql)` dispose is active (i.e. `skipAutoDispose` is NOT
 * set). Drives the eligibility-coverage fragment of Check 1 so the monitor
 * extends to domain restrictions migrated from `predicate` into `eligibility`.
 *
 * Stages with `skipAutoDispose: true` are intentionally excluded — their
 * generic `NOT(sql)` dispose is suppressed (stage-sweep.ts:523); their domain
 * dispose is expressed by an explicit predicate, which is still covered by the
 * predicate loop of Check 1.
 */
function stagesWithEligibilitySql(): Array<{
    stageId: string;
    eligibilitySql: StageDispositionFragmentBuilder;
}> {
    const out: Array<{ stageId: string; eligibilitySql: StageDispositionFragmentBuilder }> = [];
    for (const task of registry.getAllTasks()) {
        for (const stage of task.coversStages ?? []) {
            if (stage.enqueueable !== true) continue;
            const elig = stage.eligibility;
            if (!elig?.sql) continue;
            if (elig.skipAutoDispose === true) continue;
            out.push({ stageId: stage.id, eligibilitySql: elig.sql });
        }
    }
    return out;
}

/**
 * One actionable target surfaced under a finding — "here is the specific
 * thing to open", not prose telling the operator to go hunt for it. `count`
 * is the per-target contribution to the finding's total (e.g. pending items
 * for this one stage, or failures for this one task); `href` deep-links
 * straight to the affected task's page when the target maps to a registered
 * task.
 */
export interface InvariantDetailLink {
    label: string;
    sublabel?: string;
    count?: number;
    href?: string;
}

export interface Invariant {
    id: string;
    label: string;
    description: string;
    remediation: string;
    thresholdAmber: number;
    thresholdRed: number;
    query: (sql: postgres.Sql) => Promise<number>;
    /**
     * Optional per-finding breakdown computed only when the finding is
     * amber/red (see the health-invariants task runner). Must not throw in a
     * way that fails the finding — the runner wraps this in its own
     * try/catch and stores `null` on failure.
     */
    details?: (sql: postgres.Sql) => Promise<InvariantDetailLink[]>;
    /**
     * False when NOTHING the operator can do from the admin UI resolves this —
     * a code defect that needs a source change, not an operational fault.
     *
     * Such a finding is capped at AMBER however far past its red threshold it
     * goes. A red an operator cannot clear sits at the top of their dashboard
     * permanently (observed on preprod: `stage-version-ledger-drift`, Critical,
     * first seen 5h earlier, with remediation reading "nothing you can do from
     * here fixes it"), and a board that reads nonzero forever stops being read
     * at all — the exact decay the red budget exists to prevent.
     *
     * Amber, not green: it is still real, still worth reporting, and the
     * remediation text asks the operator to report it. It just is not an
     * emergency addressed to them.
     */
    operatorActionable?: boolean;
}

/**
 * Every (stage, media_type) pair the registry says should have a coverage row,
 * as two flat parallel arrays ready to `unnest` into SQL.
 *
 * 🔴 Two translations are load-bearing, and getting either wrong turns this
 * invariant into a false-alarm generator rather than a signal:
 *
 *  - `'series'` → `'tv'`. Declarations use `'series'`; `media_items.media_type`
 *    stores the legacy `'tv'`. A raw comparison matches nothing, so a
 *    series-scoped stage would report its entire population as a gap forever.
 *  - The types must come from the REGISTRY, never from a hand-maintained list.
 *    Checked while building this: guessing `metadata-update` as
 *    `['movie','tv','episode']` when it actually declares `['movie','series']`
 *    produced a phantom gap of 85,710 against a true gap of 16.
 *
 * Deduplicated because a stage may repeat a type, and a duplicated pair would
 * count the same item twice.
 */
function coverageExpectations(): { stageIds: string[]; mediaTypes: string[] } {
    const seen = new Set<string>();
    const stageIds: string[] = [];
    const mediaTypes: string[] = [];
    for (const task of registry.getAllTasks()) {
        for (const stage of task.coversStages ?? []) {
            for (const declared of stage.appliesTo) {
                const mediaType = declared === 'series' ? 'tv' : declared;
                const key = `${stage.id}\u0000${mediaType}`;
                if (seen.has(key)) continue;
                seen.add(key);
                stageIds.push(stage.id);
                mediaTypes.push(mediaType);
            }
        }
    }
    return { stageIds, mediaTypes };
}

/**
 * Items that should hold a coverage row for a stage and hold none at all,
 * per stage. Exact, not estimated — measured at ~1.1s across nine stages on a
 * 158k-item production catalogue, which is affordable at the invariant cadence.
 *
 * Computed as eligible items per type minus items of that type that already
 * hold a row for the stage (the primary key allows one per item and stage).
 * The old per-item anti join spilled its hash to disk on prod (up to 1.8 s).
 * HAVING > 0 keeps the old result shape: stages without a gap are not listed.
 */
async function stageCoverageGaps(
    sql: postgres.Sql,
): Promise<Array<{ stage_id: string; gap: number }>> {
    const { stageIds, mediaTypes } = coverageExpectations();
    // An unloaded registry (a process that never ran loadBuiltins) would
    // otherwise report zero expectations and therefore a clean bill of health
    // — or, if inverted later, the whole catalogue as missing. Say nothing
    // rather than something wrong.
    if (stageIds.length === 0) return [];
    // System health query — counts the whole catalogue's coverage, never
    // returns media to a user, so no per-user library/age gate applies.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return await sql<Array<{ stage_id: string; gap: number }>>`
        WITH stage_types(stage_id, media_type) AS (
            SELECT * FROM unnest(${sql.array(stageIds)}::text[], ${sql.array(mediaTypes)}::text[])
        ),
        eligible_counts AS (
            SELECT media_type, count(*) AS n
              FROM media_items
             WHERE status = 'active'
               AND COALESCE(is_dismissed, false) = false
             GROUP BY media_type
        ),
        covered_counts AS (
            SELECT ms.stage_id, mi.media_type, count(*) AS n
              FROM media_item_stage_state ms
              JOIN media_items mi ON mi.id = ms.media_item_id
             WHERE mi.status = 'active'
               AND COALESCE(mi.is_dismissed, false) = false
               AND ms.stage_id = ANY(${sql.array(stageIds)}::text[])
             GROUP BY ms.stage_id, mi.media_type
        )
        SELECT st.stage_id,
               SUM(COALESCE(ec.n, 0) - COALESCE(cc.n, 0))::int AS gap
          FROM stage_types st
          LEFT JOIN eligible_counts ec ON ec.media_type = st.media_type
          LEFT JOIN covered_counts cc
                 ON cc.stage_id = st.stage_id AND cc.media_type = st.media_type
         GROUP BY 1
        HAVING SUM(COALESCE(ec.n, 0) - COALESCE(cc.n, 0)) > 0
         ORDER BY 2 DESC
    `;
}

/**
 * Stages whose version ledger disagrees with the version stamped on their own
 * completed rows.
 *
 * 🔴 `detectVersionBumps` decides what is stale by comparing a declared version
 * against `stage_version_state`. If the ledger and the rows have drifted, that
 * comparison is meaningless in BOTH directions — a real bump marks nothing
 * obsolete, and an unrelated bump can mark everything obsolete. On prod this
 * found exactly one stage library-wide (`lumastra-intro-analyzer:visual`,
 * ledger 4 against 14,651 rows at 5), which is the defect that motivated it.
 *
 * Compares only `completed` rows: those are the ones the version gate is used
 * to skip, and the only ones whose staleness the ledger is claiming to know.
 */
async function stageVersionLedgerDrift(
    sql: postgres.Sql,
): Promise<Array<{ stage_id: string; observed_version: number; max_completed_pv: number }>> {
    return await sql<
        Array<{ stage_id: string; observed_version: number; max_completed_pv: number }>
    >`
        SELECT v.stage_id,
               v.observed_version,
               max(m.processing_version) AS max_completed_pv
          FROM stage_version_state v
          JOIN media_item_stage_state m
            ON m.stage_id = v.stage_id
           AND m.status = 'completed'
         GROUP BY v.stage_id, v.observed_version
        HAVING max(m.processing_version) <> v.observed_version
         ORDER BY v.stage_id
    `;
}

/**
 * Rows whose `stage_id` no task declares any more, per stage id.
 *
 * 🔴 A retired stage id is invisible to every WRITE path — sweep, heal,
 * disposition and enqueue all iterate `registry.getAllTasks()` — while the READ
 * paths keep rendering it. That asymmetry is what let the pre-split
 * `lumastra-intro-analyzer` id sit on 85,749 rows with the admin progress bar
 * frozen at 19.6% for three days. The rows are inert; the surfaces keyed to
 * them are not.
 *
 * Same unloaded-registry guard as {@link stageCoverageGaps}, and for a much
 * sharper reason: with no declared stages EVERY row looks orphaned, and this
 * invariant would report the entire table. Say nothing rather than something
 * catastrophically wrong.
 */
/**
 * Stage ids that are WRITTEN on purpose but deliberately not declared in any
 * task's `coversStages`, and are therefore not orphans.
 *
 * There is exactly one today. `lumastra-intro-analyzer:acoustic` is
 * season-scoped work owned by the analyzer's own drain loop: its eligibility
 * is computed from row ABSENCE in `getUnanalyzedSeasons`, so seeding pending
 * rows for it — which declaring it would do — is precisely wrong. Declaring it
 * is also not a free "documentation" move: `runner.ts` only wraps coverage for
 * a task with EXACTLY ONE covered stage (the Phase 1a single-stage limit), so
 * a second entry would silently stop recording transitions for the analyzer's
 * `:visual` stage, which is the one the sweep and the headline progress bar
 * both read.
 *
 * So the exception lives here instead. Without it `orphan-stage-rows` is RED
 * from the moment it ships — migration 16.222.0 alone repaired 76,582
 * `:visual`/`:acoustic` rows — and a permanently red invariant turns the whole
 * system health verdict permanently `error`, which is the alarm fatigue that
 * would mask the genuine future rename this invariant exists to catch.
 *
 * `stage-id-mirrors.test.ts` asserts every entry here is still a real stage id
 * and still undeclared, so this list cannot outlive its reason.
 */
export const UNDECLARED_BY_DESIGN_STAGE_IDS = ['lumastra-intro-analyzer:acoustic'] as const;

async function orphanStageRows(
    sql: postgres.Sql,
): Promise<Array<{ stage_id: string; rows: number }>> {
    const declared = [...registry.allStageIds(), ...UNDECLARED_BY_DESIGN_STAGE_IDS];
    // The guard is on the REGISTRY half only: an unloaded registry is what
    // makes every row look orphaned, and the allowlist alone would not save us
    // from reporting the entire table.
    if (registry.allStageIds().length === 0) return [];
    return await sql<Array<{ stage_id: string; rows: number }>>`
        SELECT stage_id, count(*)::int AS rows
          FROM media_item_stage_state
         WHERE NOT (stage_id = ANY(${sql.array(declared)}::text[]))
         GROUP BY 1
         ORDER BY 2 DESC
    `;
}

/** Cap on how many per-finding detail rows we ever store/render. */
const MAX_DETAIL_LINKS = 10;

/**
 * Map every enqueueable stage id to the task that declared it via
 * `coversStages`, plus how many stages that task covers (so callers can
 * decide whether the stage id itself is useful context — a single-stage task
 * doesn't need it repeated as a sublabel, a multi-stage task does).
 */
function stageOwnerMap(): Map<
    string,
    { taskId: string; taskName: string; siblingStageCount: number }
> {
    const map = new Map<string, { taskId: string; taskName: string; siblingStageCount: number }>();
    for (const task of registry.getAllTasks()) {
        const stages = task.coversStages ?? [];
        for (const stage of stages) {
            map.set(stage.id, {
                taskId: task.id,
                taskName: task.name,
                siblingStageCount: stages.length,
            });
        }
    }
    return map;
}

/**
 * Shared fragment for `dormant-stage-with-backlog`: stages with a pending
 * backlog over 1,000 that have not completed anything in the last 24 hours.
 * Emits `stage_id`, `pending_count`, and `newest_completion_at` per stage so
 * both the summary `query` (SUMs pending_count) and the per-stage `details`
 * breakdown project from the exact same rows — no risk of the two drifting.
 * See the inline comments on the invariant's `query` for why the
 * threshold/window values were chosen.
 */
function dormantStagesFragment(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT
            stage_id,
            COUNT(*) FILTER (WHERE status = 'pending') AS pending_count,
            MAX(CASE WHEN status = 'completed' THEN COALESCE(completed_at, updated_at) END) AS newest_completion_at
          FROM media_item_stage_state
         WHERE status IN ('pending', 'completed')
         GROUP BY stage_id
        HAVING COUNT(*) FILTER (WHERE status = 'pending') > 1000
           -- A stage with NO completion at all has never finished a row: it is
           -- still draining for the first time (cold start), not dormant.
           -- Require at least one completion before flagging as a backlog that
           -- should be draining. Recency via COALESCE(completed_at, updated_at):
           -- a legacy completed row whose completed_at is NULL still counts as
           -- a real completion, else a genuinely dormant stage with such rows
           -- would be a false NEGATIVE (review fix).
           AND MAX(CASE WHEN status = 'completed' THEN COALESCE(completed_at, updated_at) END) IS NOT NULL
           AND MAX(CASE WHEN status = 'completed' THEN COALESCE(completed_at, updated_at) END) < NOW() - INTERVAL '24 hours'
    `;
}

export const INVARIANTS: Invariant[] = [
    {
        id: 'jellyfin-unpaired-watch-records',
        label: 'Some Jellyfin titles are still not paired',
        description:
            'Titles have remained unpaired for at least 15 minutes. Their watched status and resume position cannot sync.',
        remediation:
            'Open /admin/settings/connections?category=conn-jellyfin to see example titles. Check the relative file paths and file sizes in both libraries. Duplicate matches and multi-episode files stay unpaired. Pairing is checked automatically; Jellyfin file evidence refreshes at most every 30 minutes.',
        thresholdAmber: 0,
        thresholdRed: Number.MAX_SAFE_INTEGER,
        query: async (sql) =>
            features.jellyfinSync ? (await getJellyfinPairingStatus(sql, 15)).count : 0,
        details: async (sql) =>
            (await getJellyfinPairingStatus(sql, 15)).examples.map((label) => ({
                label,
                href: '/admin/settings/connections?category=conn-jellyfin',
            })),
    },
    {
        id: 'possible-split-albums',
        label: 'Possible split albums',
        description:
            'Different album rows have files in the same library and album folder, with matching album tags and album artist credits. Disc folders are treated as one album folder. Checks rotate through 100 albums per run, with up to 1000 files per album and folder probe.',
        remediation:
            'Open a pair below, inspect the merge preview and choose which album to keep. Duplicate candidates keep both tracks and all files.',
        thresholdAmber: 0,
        thresholdRed: Number.MAX_SAFE_INTEGER,
        query: refreshSplitAlbumHealth,
        details: async (sql): Promise<InvariantDetailLink[]> =>
            (await listSplitAlbumHealth(sql)).map((pair) => ({
                label: `${pair.title_a} / ${pair.title_b}`,
                href: `/admin/library/media/${pair.album_a}?mergeWith=${pair.album_b}`,
                count: 1,
            })),
    },
    {
        id: 'jsonb-as-string-result',
        label: 'Internal data format error',
        description:
            'A few background-job records from the last 7 days were saved in the wrong internal format. This is a software bug, not anything you configured.',
        remediation:
            "No operator action is needed. If this number keeps climbing, please report it on the project's issue tracker and mention 'jsonb-as-string-result'.",
        thresholdAmber: 1,
        thresholdRed: 100,
        query: async (sql: postgres.Sql): Promise<number> => {
            // Bounded to the last 7 days of terminal runs so it rides
            // idx_task_history_terminal_completed: unbounded, jsonb_typeof()
            // over every row was a 0.7-1.4 s parallel seq scan of prod's
            // 3.7M-row task_history (2026-09-26); bounded, 84 ms. A regression
            // shows up in new rows, and `result` is only written at a terminal
            // transition, so nothing the check exists to catch falls outside.
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM task_history
                 WHERE state IN ('completed', 'failed', 'cancelled')
                   AND completed_at > NOW() - INTERVAL '7 days'
                   AND jsonb_typeof(result) = 'string'
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        id: 'outbox-pending',
        label: 'Internal updates are running late',
        description:
            'How many internal events are OVERDUE — still unprocessed more than ' +
            `${OUTBOX_OVERDUE_GRACE_MINUTES} minutes after they were created. This counts ` +
            'only events the dispatcher should already have handled, so a brief burst it ' +
            'is actively clearing does not register — a non-zero number means it is ' +
            'genuinely falling behind, not merely busy.',
        remediation:
            'Background events are not being processed in time. Make sure the worker ' +
            'container is running and healthy. If it is up and the number stays high or ' +
            'climbs, the server is under sustained heavy load — give it time to catch up, ' +
            'or reduce how much is being imported at once.',
        thresholdAmber: 1000,
        thresholdRed: 100000,
        query: async (sql: postgres.Sql): Promise<number> => {
            // Count OVERDUE events, not raw depth. A healthy dispatcher clears a
            // burst within seconds-to-minutes, so a large but fast-draining
            // backlog (e.g. a bulk import seeding events the dispatcher is keeping
            // up with) is NOT a problem and must not warn — raw depth conflated
            // "catching up" with "falling behind". An event still unprocessed past
            // the grace means the dispatcher genuinely is not keeping up.
            // Exclusions: dead_letter (separate invariant) and rows in exponential
            // back-off (next_retry_at in the future — legitimately deferred).
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM event_outbox
                 WHERE consumed_at IS NULL
                   AND NOT dead_letter
                   AND (next_retry_at IS NULL OR next_retry_at <= now())
                   AND created_at < now() - make_interval(mins => ${OUTBOX_OVERDUE_GRACE_MINUTES})
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        id: 'outbox-dead-letter',
        label: 'Internal updates that were given up on',
        description:
            'How many internal events failed to be processed after several retries and were set aside.',
        remediation:
            'Some background events could not be processed after repeated attempts. Open the ' +
            "Operations panel (bell icon in the admin header) and check 'Needs attention' — " +
            'dead-lettered events show up there with a retry action. Retrying is safe: these ' +
            'events are set aside, not lost. If the same events keep dead-lettering after a ' +
            'retry, that is a bug rather than a configuration problem — report it and mention ' +
            "'outbox-dead-letter'.",
        thresholdAmber: 1,
        thresholdRed: 100,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM event_outbox
                 WHERE dead_letter = true
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        id: 'duplicate-artist-groups',
        label: 'The same artist appears more than once',
        description:
            'How many artists in your library share the same name and look like duplicates.',
        remediation:
            "Run the database-cleanup job (Tasks → /admin/tasks/database-cleanup) to merge them, and it should go to zero and stay there. These are one artist split across several rows by a race during library scans; the database has prevented new ones since 16.77.0, so anything still showing here is a straggler from before that. If the count comes back after the cleanup job, that is a bug — please report it and mention 'duplicate-artist-groups'.",
        thresholdAmber: 1,
        thresholdRed: 50,
        query: async (sql: postgres.Sql): Promise<number> => {
            // Rows are grouped by the `is_various_artists` flag (set by
            // migration 16.132.0 and maintained on write) rather than an
            // inline VA name-regex, so ALL flagged VA rows — including
            // foreign-language buckets the old English-only regex missed —
            // collapse into the single 'various-artists' group instead of
            // each forming its own separate (mis-detected) duplicate group.
            //
            // System health count over the whole catalog — no per-user access
            // scoping applies (same rationale as findSweepCandidates).
            // eslint-disable-next-line callback-safety/no-unscoped-media-items
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM (
                      SELECT CASE
                          WHEN is_various_artists THEN 'various-artists'
                          ELSE LOWER(TRIM(title))
                      END AS norm_title
                        FROM media_items
                       WHERE parent_id IS NULL
                         AND status = 'active'
                         AND media_type = 'artist'
                       GROUP BY norm_title
                      HAVING COUNT(*) > 1
                  ) dupes
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        // Renamed from 'leaked-class-budget' — the old id did not describe what
        // is measured; 'wedged-running-stages' matches the label and the
        // reconciler method name (reclaimWedgedRunningStageRows).
        id: 'wedged-running-stages',
        label: 'Items stuck mid-processing',
        description:
            'How many library items have been stuck partway through a processing step for over 15 minutes, with no job actually working on them.',
        remediation:
            "Usually nothing to do — the system clears these by itself within about a minute, so a small number that keeps changing is the recovery working. If the count stays high for more than a few minutes, restart the worker container. If it comes straight back after a restart, that is an internal pipeline bug rather than anything you configured: please report it on the project's issue tracker and mention 'wedged-running-stages'.",
        thresholdAmber: 10,
        thresholdRed: 100,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM media_item_stage_state s
                 WHERE s.status = 'running'
                   AND s.updated_at < NOW() - INTERVAL '15 minutes'
                   AND NOT EXISTS (
                       -- task_history uses column "state", not "status". The
                       -- valid "still alive" set is the three transient
                       -- states; everything else is terminal and means the
                       -- owning run is gone, so the stage row is wedged.
                       SELECT 1
                         FROM task_history th
                        WHERE th.id = s.last_run_id
                          AND th.state IN ('pending', 'active', 'cancelling')
                   )
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        id: 'dormant-stage-with-backlog',
        label: 'A processing step has stalled',
        description:
            'A processing step has more than 1,000 items waiting but has not finished any of them in the last 24 hours.',
        // Fallback context only — the finding's own `details` rows link straight
        // to the specific stalled task, so this text no longer sends the operator
        // on a manual hunt through a stale "Operations → Jobs" IA name.
        remediation:
            'The usual causes: the task is failing (open it below to see its errors), or it ' +
            'needs an integration you have not set up. If it only waits on an optional ' +
            'integration you do not use, it is safe to ignore.',
        thresholdAmber: 1000,
        thresholdRed: 10000,
        query: async (sql: postgres.Sql): Promise<number> => {
            // NOTE: optional-integration stages (Last.fm/Discogs/MDBList) are
            // drained to skipped_transient by their tasks' global-guard when the
            // integration's key is absent, so their rows no longer count as
            // `pending` here and do not light this signal on an unconfigured
            // install. We deliberately do NOT add a broad suppression to the
            // query below — the global-guard drain is the correct root-cause fix
            // and this invariant must keep firing on a genuinely dormant stage.
            //
            // 24h window absorbs every periodic task cadence the codebase
            // currently ships: mdblist-sync (12h), mal-anime-id-enrichment
            // (24h), artist-enrichment (24h), database-cleanup (24h). A
            // 6h window mis-fired on mdblist-sync's 12h cadence whenever
            // the invariant landed between its fires. fribb-anime-sync's
            // 48h cadence is still longer than the window, but that task
            // intentionally drains everything in one pass so a stale
            // 24h+ gap on it IS a dormancy signal.
            const rows = await sql<[{ count: string }]>`
                WITH dormant_stages AS (${dormantStagesFragment(sql)})
                SELECT COALESCE(SUM(pending_count), 0)::TEXT AS count
                  FROM dormant_stages
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
        // Per-stage breakdown so the finding can deep-link straight to the
        // owning task instead of leaving the operator to hunt for "the job for
        // this step" — reuses the exact same dormant_stages CTE the query above
        // uses, just projected per-stage instead of summed.
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const rows = await sql<{ stage_id: string; pending_count: string }[]>`
                WITH dormant_stages AS (${dormantStagesFragment(sql)})
                SELECT stage_id, pending_count::TEXT AS pending_count
                  FROM dormant_stages
                 ORDER BY pending_count DESC
                 LIMIT ${MAX_DETAIL_LINKS}
            `;
            const owners = stageOwnerMap();
            return rows.map((row): InvariantDetailLink => {
                const count = parseInt(row.pending_count, 10);
                const owner = owners.get(row.stage_id);
                if (!owner) {
                    // No registered task claims this stage id (shouldn't happen
                    // in practice) — show the raw id with no link rather than
                    // silently dropping the row.
                    return { label: row.stage_id, count };
                }
                return {
                    label: owner.taskName,
                    sublabel: owner.siblingStageCount > 1 ? row.stage_id : undefined,
                    count,
                    href: `/admin/tasks/${encodeURIComponent(owner.taskId)}?tab=failures`,
                };
            });
        },
    },
    {
        id: 'duplicate-external-ids',
        label: 'Duplicate media identity',
        description:
            'Two or more library items claim the same provider ID (for example the same TMDB or IMDb entry), which can mix up their details.',
        remediation:
            "This usually needs a maintainer to resolve. Please report it on the project's issue tracker and mention 'duplicate-external-ids'. Advanced operators can fix it with a manual database merge — see the troubleshooting docs.",
        thresholdAmber: 1,
        thresholdRed: 100,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM (
                      SELECT provider, external_id, media_type
                        FROM external_ids
                       GROUP BY provider, external_id, media_type
                      HAVING COUNT(DISTINCT media_id) > 1
                  ) dupes
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        id: 'task-recent-failures',
        label: 'Background tasks that failed and need a person',
        description:
            'Task failures in the last 24h that need a human. Deploy/restart interruptions, lost scheduling races, and concurrency throttling are excluded — those retry automatically. What remains is a real problem: provider outage, task bug, timeout, or task-Valkey capacity. Same set as the "Recently failed" lane badge on Tasks.',
        remediation:
            'Open Tasks (/admin/tasks): each failing task is listed under "Needs attention" with its latest error, and its row opens the run history. If an error says "OOM" or "used memory > maxmemory", the task/coordination Valkey is full and rejecting task-run writes: increase that instance\'s maxmemory/RAM or reduce its retained task data. When TASK_CACHE_URL is configured, this is the dedicated task Valkey, not the general CACHE_URL instance. Otherwise investigate the repeated task error. A brief post-deploy spike is normal and clears within 24h.',
        // classifyStatus uses strict `>`; amber fires ABOVE thresholdAmber. A few
        // SELF-HEALING failures (cold-start hard-timeouts on the first big sync,
        // provider blips, deploy churn) are normal on a healthy self-hosted install
        // and should read GREEN — not a perpetual yellow. So tolerate up to 10 in
        // 24h before amber; a genuinely-broken task accrues failures far faster and
        // still trips amber (>10) then red (>20). (Was 0 = "even one is yellow",
        // which made every fresh-install cold-start show a false warning.)
        thresholdAmber: 10,
        thresholdRed: 20,
        query: async (sql: postgres.Sql): Promise<number> => {
            // The exclusion predicate is the shared actionableTaskFailure()
            // fragment in task-failure.fragments.ts — both this invariant and
            // lane-data.ts delegate to that single source. New infra-noise
            // patterns (scheduler bookkeeping, stall-out-of-race, etc.) go in
            // that fragment, not here.
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM task_history
                 WHERE ${actionableTaskFailure(sql)}
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
        // Per-task breakdown so the finding links straight to the specific
        // failing task instead of sending the operator to scan the whole Tasks
        // catalog for the "Recently failed" badge.
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const rows = await sql<{ task_id: string; count: string }[]>`
                SELECT task_id, COUNT(*)::TEXT AS count
                  FROM task_history
                 WHERE ${actionableTaskFailure(sql)}
                 GROUP BY task_id
                 ORDER BY COUNT(*) DESC
                 LIMIT ${MAX_DETAIL_LINKS}
            `;
            return rows.map((row): InvariantDetailLink => {
                const task = registry.getTask(row.task_id);
                return {
                    label: taskDisplayName(row.task_id, task?.name),
                    count: parseInt(row.count, 10),
                    href: `/admin/tasks/${encodeURIComponent(row.task_id)}?tab=failures`,
                };
            });
        },
    },
    {
        id: 'stage-wedge-guard',
        label: 'Items a step can neither finish nor skip',
        description:
            'An internal consistency check for the processing pipeline. It counts ' +
            'library items that a processing step can neither finish nor skip — for ' +
            `example items still waiting after ${WEDGE_MIN_ATTEMPTS}+ attempts for over ` +
            `${WEDGE_STALE_MINUTES} minutes. A non-zero count points to a software bug ` +
            'in a processing step, not a setting you can change.',
        remediation:
            'If this stays above zero, restart the worker container. If it persists ' +
            "after a restart, please report it on the project's issue tracker and " +
            "mention 'stage-wedge-guard' — it is an internal pipeline bug, not " +
            'something you can fix from the admin settings.',
        // A real wedge (a stale fragment) grows fast, so tolerate a tiny residual
        // — a few genuinely-out-of-domain rows a disposer hasn't swept yet (e.g.
        // library-embeddings edge cases) — before amber; a single stray row isn't
        // worth a warning. Red unchanged. (Was 0; with the probe-gating fix above
        // the cold-start false-positives are gone, but amber-at-1 still flagged a
        // tiny benign residual as a perpetual yellow on healthy installs.)
        thresholdAmber: 5,
        thresholdRed: 50,
        query: async (sql: postgres.Sql): Promise<number> => {
            let total = 0;

            // --- Check 1a: predicate disposition coverage (under-disposal) ---
            // For every enqueueable predicate stage, count rows that the
            // sweeper would still select (findSweepCandidates predicate) AND
            // that ALSO satisfy the declared `excludes` fragment. After the
            // framework disposition has run, that intersection must be empty;
            // a non-zero count means the fragment failed to dispose a row it
            // claims to exclude (stale/wrong declaration).
            for (const { stageId, disposition } of stagesWithDispositionKind('predicate')) {
                if (disposition.kind !== 'predicate') continue;
                // Build the fragment with this connection's sql (the disposition
                // declares `excludes` as a builder; see StageDispositionFragmentBuilder).
                // Mirror the SAME gates `stage-disposition-runner.ts::runPredicate`
                // AND-composes before it will actually dispose a row —
                // `requiresQuietUpstream` / `requiresUpstreamRun` — otherwise this
                // check asks "is the row out-of-domain?" instead of "would the real
                // disposer have cleared it by now?" and false-fires on rows that are
                // correctly waiting on a slow feeder stage (e.g. mal-anime-id-
                // enrichment's `not-in-anime-catalog` rule waiting on mdblist-sync).
                let excludes = disposition.excludes(sql);
                if (disposition.requiresQuietUpstream) {
                    excludes = sql`(${excludes}) AND (${buildQuietUpstreamFragment(sql, disposition.requiresQuietUpstream)})`;
                }
                if (disposition.requiresUpstreamRun) {
                    excludes = sql`(${excludes}) AND (${buildUpstreamRunFragment(sql, disposition.requiresUpstreamRun)})`;
                }
                // Status set MATCHES the disposition runner's SWEEPABLE_STATUSES
                // (pending/failed_transient/skipped_transient — NOT 'obsolete').
                // The runner deliberately does not dispose `obsolete` rows (they
                // are reprocessed by the task), so flagging them here would be a
                // false positive.
                // eslint-disable-next-line callback-safety/no-unscoped-media-items
                const rows = await sql<[{ count: string }]>`
                    SELECT COUNT(*)::TEXT AS count
                      FROM media_item_stage_state s
                      JOIN media_items mi ON mi.id = s.media_item_id
                     WHERE s.stage_id = ${stageId}
                       AND s.status IN ('pending', 'failed_transient', 'skipped_transient')
                       AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
                       AND COALESCE(mi.is_dismissed, false) = false
                       AND mi.status = 'active'
                       -- Probe-gated transient guard: skip items whose file is
                       -- still AWAITING PROBE. Their domain is undetermined — the
                       -- content stages (media-probe-b / trickplay / intro) require
                       -- a video stream that only exists after media-probe-a runs,
                       -- so a pre-probe row reads out-of-domain PURELY TRANSIENTLY
                       -- and is NOT a wedge (file.probed re-evaluates it the instant
                       -- the file is probed). Without this, the guard false-fires
                       -- across the entire pre-probe backlog of a cold-start import.
                       -- A GENUINE stale fragment is still caught once the file is
                       -- probed and this exclusion lifts. (#3 "monitor Check 1b".)
                       AND NOT EXISTS (
                           SELECT 1 FROM media_file_items mfi
                             JOIN media_files mf ON mf.id = mfi.file_id
                            WHERE mfi.media_item_id = s.media_item_id
                              AND NOT mf.is_missing
                              AND mf.probed_at IS NULL
                       )
                       -- Dispose-coverage grace: the rotating sweep disposes a
                       -- stage roughly once per full rotation, so only flag a row
                       -- the rotation SHOULD have disposed by now (older than the
                       -- grace) — never a transient burst row a discovery import
                       -- just seeded. See WEDGE_DISPOSE_GRACE_MINUTES.
                       AND s.updated_at < now() - make_interval(mins => ${WEDGE_DISPOSE_GRACE_MINUTES})
                       AND ${excludes}
                `;
                total += parseInt(rows[0]?.count ?? '0', 10);
            }

            // --- Check 1b: eligibility domain coverage (eligibility-drift) ---
            // For every enqueueable stage that declares eligibility.sql (and
            // whose generic NOT(sql) dispose is active — skipAutoDispose stages
            // are excluded because their dispose is handled by explicit predicates
            // already counted above), count rows where the eligibility fragment
            // says the item is out-of-domain (NOT sql) but that are still
            // sweepable. After runEligibilityDispose has run, that intersection
            // must be 0; a non-zero count means the eligibility sql failed to
            // drain those rows (eligibility-fragment drift). Identical status set,
            // guards, and precision as Check 1a — never a table-wide stale COUNT.
            for (const { stageId, eligibilitySql } of stagesWithEligibilitySql()) {
                const domainFrag = eligibilitySql(sql);
                // eslint-disable-next-line callback-safety/no-unscoped-media-items
                const rows = await sql<[{ count: string }]>`
                    SELECT COUNT(*)::TEXT AS count
                      FROM media_item_stage_state s
                      JOIN media_items mi ON mi.id = s.media_item_id
                     WHERE s.stage_id = ${stageId}
                       AND s.status IN ('pending', 'failed_transient', 'skipped_transient')
                       AND (s.next_eligible_at IS NULL OR s.next_eligible_at <= now())
                       AND COALESCE(mi.is_dismissed, false) = false
                       AND mi.status = 'active'
                       -- Probe-gated transient guard (see Check 1a above): an item
                       -- whose file is still awaiting probe is domain-undetermined,
                       -- not wedged — exclude it so the guard doesn't false-fire on
                       -- the pre-probe backlog of a cold-start import.
                       AND NOT EXISTS (
                           SELECT 1 FROM media_file_items mfi
                             JOIN media_files mf ON mf.id = mfi.file_id
                            WHERE mfi.media_item_id = s.media_item_id
                              AND NOT mf.is_missing
                              AND mf.probed_at IS NULL
                       )
                       -- Dispose-coverage grace (see Check 1a + WEDGE_DISPOSE_GRACE_MINUTES):
                       -- only flag a row the rotating sweep should have disposed
                       -- by now, not a transient burst row awaiting the next rotation.
                       AND s.updated_at < now() - make_interval(mins => ${WEDGE_DISPOSE_GRACE_MINUTES})
                       AND NOT (${domainFrag})
                `;
                total += parseInt(rows[0]?.count ?? '0', 10);
            }

            // --- Check 2: self-terminal liveness (forming wedge) ---
            const selfTerminalStages = stagesWithDispositionKind('self-terminal').map(
                (s) => s.stageId,
            );
            if (selfTerminalStages.length > 0) {
                // eslint-disable-next-line callback-safety/no-unscoped-media-items
                const rows = await sql<[{ count: string }]>`
                    SELECT COUNT(*)::TEXT AS count
                      FROM media_item_stage_state s
                      JOIN media_items mi ON mi.id = s.media_item_id
                     WHERE s.stage_id = ANY(${selfTerminalStages}::text[])
                       AND s.status = 'pending'
                       AND s.attempt >= ${WEDGE_MIN_ATTEMPTS}
                       AND s.updated_at < NOW() - make_interval(mins => ${WEDGE_STALE_MINUTES})
                       AND COALESCE(mi.is_dismissed, false) = false
                       AND mi.status = 'active'
                `;
                total += parseInt(rows[0]?.count ?? '0', 10);
            }

            return total;
        },
    },
    {
        id: 'failed-transient-stale',
        label: 'Items failing for over a week',
        description:
            'How many library items have been retried and kept failing for more than 7 days.',
        remediation:
            'Open Operations → Jobs and check the recent errors for these items. If they are all the same provider error (for example a TMDB "not found"), the item is likely identified incorrectly — fix or re-match its provider ID.',
        thresholdAmber: 100,
        thresholdRed: 1000,
        query: async (sql: postgres.Sql): Promise<number> => {
            // Exclude WEDGED_RUNNING_RECOVERY rows: the wedge fairness fix
            // resets `updated_at = COALESCE(started_at, updated_at)` so a row
            // wedged moments ago can legitimately carry an old `updated_at`
            // (the original ready time). Counting those as "stale" would
            // false-positive every wedge-and-recover cycle. The reaper is
            // doing its job — these rows are eligible again, just FIFO-aged.
            const rows = await sql<[{ count: string }]>`
                SELECT COUNT(*)::TEXT AS count
                  FROM media_item_stage_state
                 WHERE status = 'failed_transient'
                   AND updated_at < NOW() - INTERVAL '7 days'
                   AND COALESCE(last_error->>'code', '') <> 'WEDGED_RUNNING_RECOVERY'
            `;
            return parseInt(rows[0]?.count ?? '0', 10);
        },
    },
    {
        id: 'metadata-storage-writability',
        label: 'A library folder cannot be written to',
        description:
            'How many active library roots need on-disk metadata writes (thumbnails, ' +
            'trickplay, lyrics) but are mounted read-only, given the current ' +
            "METADATA_STORAGE_LOCATION setting. In 'alongside' mode this means those " +
            "writes definitely FAIL (red); in 'alongside-prefer' mode they silently fall " +
            'back to central storage instead of living next to the media (amber). ' +
            'ALSO checks the central metadata root itself (BASE_PATH, default /data): ' +
            'that directory is the fallback target for any item with no derivable media ' +
            "folder, so an unwritable one fails those writes in EVERY mode — red in 'central' " +
            'mode (nothing can be written at all), amber otherwise (only the fallback path).',
        remediation:
            // Rewritten for a self-hoster. The previous version opened on `:ro` bind
            // mount flags and named METADATA_STORAGE_LOCATION with three enum
            // values, BASE_PATH and container uids — ninety words of SRE
            // detail, unbroken, on the home page of someone who mounted a
            // folder read-only by accident. Lead with the one-line fix and the
            // one-click alternative; the container specifics follow for the
            // reader who needs them.
            'Lumastra saves artwork and previews next to your media, and one of your library ' +
            'folders is read-only, so those saves fail. Two ways out: make the folder ' +
            'writable, or switch Lumastra to keeping that data in its own folder instead ' +
            "(Settings → Media → where to store artwork; the 'central' option never writes " +
            'to your library at all). Nothing already saved is affected either way. ' +
            'If you run in Docker, the usual cause is a `:ro` bind mount — that reports ' +
            'normal-looking permissions while every write still fails, so check the mount ' +
            'flags, not just the file permissions.',
        // Mode-aware severity encoded as a single number so this reuses the
        // shared red/amber/green threshold contract without changing the
        // Invariant shape. 'central', or "all roots writable", always yields 0
        // (green). A read-only root under 'alongside-prefer' yields the small
        // readOnlyRoots count — > thresholdAmber but nowhere near thresholdRed
        // (amber only). A read-only root under strict 'alongside' is offset by
        // 1_000_000, guaranteeing it always clears thresholdRed (red),
        // regardless of how many roots are affected. Consequence: the `value`
        // persisted/displayed in strict 'alongside' mode is this sentinel
        // magnitude (e.g. 1_000_001), not the plain read-only-root count —
        // intentional, not a bug, so the admin panel doesn't need a schema
        // change to carry mode alongside the count.
        thresholdAmber: 0,
        thresholdRed: 999_999,
        query: async (sql: postgres.Sql): Promise<number> => {
            const { mode, readOnlyRoots, centralWritable } =
                await checkMetadataStorageWritability(sql);

            // An unwritable CENTRAL root counts as one affected location on top of
            // any read-only library roots. 'unknown' (hung mount) never counts —
            // same rule the root probe uses, so a stalled NFS server can't
            // manufacture a false critical.
            const centralAffected = centralWritable === 'readonly' ? 1 : 0;
            const affected = readOnlyRoots.length + centralAffected;
            if (affected === 0) return 0;

            // Red when writes definitely fail OUTRIGHT, enumerated per mode so the
            // formula never depends on an implicit contract about which fields the
            // probe populates in which mode:
            //
            //  - 'central':          every write goes to central. Broken ⇒ red.
            //  - 'alongside':        strict, no fallback. A read-only root ⇒ red.
            //  - 'alongside-prefer': a read-only root is SUPPOSED to be survivable —
            //                        it falls back to central. That guarantee holds
            //                        only while central is writable. Read-only root
            //                        AND broken central ⇒ the fallback is gone and
            //                        those writes fail exactly as in strict mode ⇒ red.
            //
            // A broken central root on its own, under either alongside mode, degrades
            // only the no-derivable-folder items, so it stays amber.
            const centralBroken = centralAffected > 0;
            const definitelyFails =
                (mode === 'central' && centralBroken) ||
                (mode === 'alongside' && readOnlyRoots.length > 0) ||
                (mode === 'alongside-prefer' && readOnlyRoots.length > 0 && centralBroken);
            return definitelyFails ? 1_000_000 + affected : affected;
        },
    },
    {
        id: 'transcode-failures-24h',
        label: 'Playback failed to convert a video',
        description:
            'Playback sessions in the last 24h whose transcode failed outright, after the GPU recovery ladder had already retried. Counted by distinct session, not by row — a single broken file retrying every 40 seconds is one problem, not thousands. Recovered attempts (retried/bridged) are deliberately excluded; those self-healed.',
        remediation:
            'Open Transcode Failures (/admin/system/transcode-failures). If one file dominates, it is a bad source. If many distinct files share one encoder, it is a GPU or driver problem — the detail view has the exact FFmpeg command and stderr, ready to paste into a bug report.',
        thresholdAmber: 5,
        thresholdRed: 25,
        query: async (sql: postgres.Sql): Promise<number> => countFailedSessions24h(sql),
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const rows = await topFailingEncoders24h(sql, MAX_DETAIL_LINKS);
            return rows.map((row): InvariantDetailLink => ({
                label: row.encoder,
                count: parseInt(row.count, 10),
                href: `/admin/system/transcode-failures?encoder=${encodeURIComponent(row.encoder)}`,
            }));
        },
    },
    {
        id: 'stage-coverage-gap',
        label: 'Some items were never queued for a processing step',
        description:
            'Items that should have been processed by a step have no record of it at all — not waiting, not skipped, simply absent. This is the one failure the queue cannot show you: a missing record is not a backlog, so the step reports itself healthy while the work never happens. Found this way on 2026-08-21: 11,186 items with no trickplay record, 11,238 with no integrity check, 15,836 with no artwork sync, unnoticed for ten weeks.',
        remediation:
            'It repairs itself — the library sweep creates the missing records steadily and the work then runs normally, so a large number after an upgrade is the backlog being discovered, not a fault. To tell healthy from stuck: open Jobs and look at the library sweep. If it reports creating records on each run, this is draining and needs nothing from you — the breakdown below shows which steps are still waiting their turn, and they are worked one at a time in priority order. Act only if the sweep is not running at all, or this number has not moved in several hours while the server is idle.',
        // 🔴 A WARNING, not a critical, and the thresholds say so deliberately.
        //
        // Shipped on 2026-08-21 at amber 500 / red 5,000 against a real gap of
        // ~358,000 — so it went critical immediately and stayed critical for a
        // day while doing exactly what its own remediation text promised:
        // repairing itself, at ~146,000 rows a day. A critical that resolves
        // without anyone touching it is the same cry-wolf failure as the
        // repeated-recovery alert fixed hours earlier, and it teaches operators
        // to scroll past the panel — which costs more than the alert earns.
        //
        // Amber at 1,000: a residual gap on a settled install is worth knowing
        // about. Red at 500,000: beyond any backfill this repair produces, so it
        // means something is genuinely wrong rather than merely large.
        //
        // The sharper signal is a gap that has STOPPED falling — a property of
        // the trend, not the value, needing history this framework does not
        // keep. Deliberately not built; the remediation tells the operator how
        // to check it by hand rather than pretending the number implies it.
        thresholdAmber: 1000,
        thresholdRed: 500_000,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await stageCoverageGaps(sql);
            return rows.reduce((total, row) => total + row.gap, 0);
        },
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const rows = await stageCoverageGaps(sql);
            const owners = stageOwnerMap();
            return rows.slice(0, MAX_DETAIL_LINKS).map((row): InvariantDetailLink => {
                const owner = owners.get(row.stage_id);
                return {
                    label: owner?.taskName ?? row.stage_id,
                    ...(owner && owner.siblingStageCount > 1 ? { sublabel: row.stage_id } : {}),
                    count: row.gap,
                };
            });
        },
    },
    {
        id: 'stage-version-ledger-drift',
        // Remediation is 'report it' — see `operatorActionable`.
        operatorActionable: false,
        label: 'A processing step disagrees with its own records',
        description:
            "A processing step's declared version does not match the version stamped on the work it has already completed. When those two drift apart the step can no longer tell which of its finished work is stale: a genuine change re-processes nothing, and an unrelated change can re-process the entire library. Found this way on 2026-08-21 — the intro detector's ledger read 4 while all 14,651 completed rows carried 5.",
        remediation:
            'This is a code defect, not an operational one, and nothing you can do from here fixes it — the step needs its declared version corrected. Nothing is lost in the meantime; the affected step simply will not notice its own updates. Worth reporting with the step name shown below.',
        // Any drift at all is a bug. There is no healthy non-zero value.
        thresholdAmber: 0,
        thresholdRed: 0,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await stageVersionLedgerDrift(sql);
            return rows.length;
        },
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const rows = await stageVersionLedgerDrift(sql);
            const owners = stageOwnerMap();
            return rows.slice(0, MAX_DETAIL_LINKS).map((row): InvariantDetailLink => ({
                label: owners.get(row.stage_id)?.taskName ?? row.stage_id,
                sublabel: `ledger ${row.observed_version}, rows ${row.max_completed_pv}`,
            }));
        },
    },
    {
        id: 'upload-staging-not-shared',
        label: 'Uploads are staged on a disk other servers cannot see',
        description:
            'An upload in progress keeps its parts in a staging folder. With more than one Lumastra server (replicas, or a separate worker), every server must see that folder, because each part can reach a different server and the server that assembles the file must find all of them. Some active uploads have a staging folder this server cannot see, so those uploads fail when they are finished.',
        remediation:
            'Leave UPLOAD_STAGING_DIR unset, so parts are staged inside the library folder that every server already mounts, or point it at a volume that every server mounts at the same path. Then restart and upload again.',
        thresholdAmber: 0,
        // Never red: an upload failing is serious for that upload only.
        thresholdRed: Number.MAX_SAFE_INTEGER,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await sql<{ staging_dir: string }[]>`
                SELECT staging_dir FROM upload_sessions
                WHERE status = 'uploading'
                  AND staging_dir <> ''
                  AND updated_at > NOW() - INTERVAL '1 hour'
            `;
            let missing = 0;
            for (const row of rows) {
                try {
                    await stat(row.staging_dir);
                } catch (err) {
                    if ((err as { code?: string }).code === 'ENOENT') missing++;
                }
            }
            return missing;
        },
    },
    {
        id: 'orphan-stage-rows',
        // Remediation is 'report it' — see `operatorActionable`.
        operatorActionable: false,
        label: 'Records left behind by a renamed processing step',
        description:
            'Processing records point at a step that no longer exists — usually because a step was renamed or split and its old records were never retired. The records themselves are harmless and do nothing. The risk is on screen: any progress bar or pipeline view still keyed to the old name reads live numbers from records nothing updates, so it shows a figure that is not stale but frozen. That happened here on 2026-08-21, showing 19.6% for three days while the real step was at 95.6%.',
        remediation:
            'Nothing to do from here — retiring the old records needs a migration, and repointing the screens that still name the old step needs a code change. Report it with the step name below. Until then, treat any progress shown for that step as meaningless rather than as bad news.',
        thresholdAmber: 0,
        thresholdRed: 0,
        query: async (sql: postgres.Sql): Promise<number> => {
            const rows = await orphanStageRows(sql);
            return rows.reduce((total, row) => total + row.rows, 0);
        },
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const rows = await orphanStageRows(sql);
            // No stageOwnerMap lookup — by definition no task owns these.
            return rows.slice(0, MAX_DETAIL_LINKS).map((row): InvariantDetailLink => ({
                label: row.stage_id,
                count: row.rows,
            }));
        },
    },
    {
        id: 'library-cleanup-held',
        label: 'Removed files are not being cleaned up in a library',
        description:
            'A library scan found far fewer files in this folder than the library knows (or none), so it removed nothing: that is what an offline or half-mounted share looks like. Every scan since has done the same. If the files really were deleted, their titles stay in the library until you confirm it.',
        remediation:
            'Open "New files are not showing up", check the counts for the folder and that the share is mounted. If the files are really gone, press "Remove missing files"; the next scan removes them once. If the share was offline, fix the mount and the next scan clears this on its own.',
        thresholdAmber: 0,
        // Never red: nothing is lost, the library only keeps dead rows.
        thresholdRed: Number.MAX_SAFE_INTEGER,
        query: countUnconfirmedCleanupHolds,
        details: async (sql: postgres.Sql): Promise<InvariantDetailLink[]> => {
            const holds = await listCleanupHolds(sql);
            return holds
                .filter((h) => h.confirmed_at === null)
                .slice(0, MAX_DETAIL_LINKS)
                .map((h): InvariantDetailLink => ({
                    label: h.path,
                    sublabel: `found ${h.walked} of ${h.known} files`,
                    count: h.known - h.walked,
                    href: '/admin/fix/new-files',
                }));
        },
    },
];
