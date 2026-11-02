// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { CircuitFleet } from '$lib/server/tasks/observability/circuit-fleet.service.js';
import type {
    DeadLetterRow,
    StuckItemRow,
} from '$lib/server/database/queries/ingest-map.queries.js';
import type { DeadLetterEventSummaryRow } from '$lib/server/database/queries/event-outbox.queries.js';
import type { OnboardingState } from '$lib/server/database/queries/onboarding.queries.js';
import type {
    FailedRunSpikeRow,
    RepeatedSubsystemEventRow,
} from '$lib/server/database/queries/attention.queries.js';
import type { LiveTvAvailability } from '$lib/schemas/livetv-availability.js';
import type { LiveTvSourceSafeRow } from '$lib/server/database/queries/livetv-sources.queries.js';
import type { ScheduleOverdueView, HealthReason } from '$lib/schemas/task-system-health.schema.js';
import type { DependencyFinding } from '$lib/server/preflight/dependency-checks.js';
import { countBucket } from './count-bucket.js';
import { redactLiveTvUrlsInText } from '$lib/shared/livetv-url-redaction.js';
import type { DerivedAlert } from './types.js';
import type { MasterKeyBackupState } from '$lib/server/crypto/master-key.js';
import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
import {
    decideProxyCompat,
    type AppProxyExpectation,
} from '$lib/server/services/livetv/proxy-compat.js';
import type { DeclineLoopRow } from '$lib/server/database/queries/attention.queries.js';
import {
    ADMIN_FILE_HEALTH_PATH,
    ADMIN_MEDIA_FILE_ISSUES_PATH,
    buildMusicHygieneLink,
    buildScanAddedSinceLink,
} from '$lib/shared/admin-media-links.js';
import {
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
    MUSIC_ATTENTION_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    isHeuristicMusicHygieneFinding,
    type MusicHygieneFinding,
} from '$lib/shared/music-hygiene.js';
import type { MusicHygieneCounts } from '$lib/server/database/queries/music-hygiene.queries.js';
import type { VolumeHeadroom } from '$lib/server/utils/artwork-volume-headroom.js';
import type { LibraryVolumeGrowth } from '$lib/schemas/admin-library-storage-growth.js';
import type { PluginUpdateRow } from '$lib/server/database/queries/plugin-repositories.queries.js';
import type { UpdateEvaluation } from '$lib/server/services/lumastra-update/version.js';
import { LUMASTRA_SECURITY_UPDATE_ATTENTION_ID } from '$lib/shared/attention-persistent.js';
import type { PluginFailureCountRow } from '$lib/server/database/queries/plugin-failure-events.queries.js';
import {
    ABANDONED_RUN_ERRORS_SENTINEL,
    type ScannerRunSummary,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { formatRelativeTime } from '$lib/utils/time-formatting.js';
import {
    containerMemoryLevel,
    containerPeakLevel,
    hostMemoryLevel,
} from '$lib/utils/admin/cluster-glance.js';
import { isPressureClock, type PressureClock } from './pressure-since.js';
import { formatBinaryBytes } from '$lib/utils/admin/cluster-node-resources.js';
import type { IntegritySeverity } from '$lib/server/database/queries/integrity-violations.queries.js';
import type { UncleanExitRow } from '$lib/server/database/queries/attention.queries.js';

/** Where a capacity problem is investigated. */
const ADMIN_SYSTEM_HEALTH_PATH = '/admin/system/health';

/** Where plugins are installed, enabled and updated. */
const ADMIN_PLUGINS_PATH = '/admin/settings/plugins';
const ADMIN_INSTANCE_UPDATES_PATH = '/admin/system/instance#updates';
/** How long the update check may fail before admins are told. */
export const UPDATE_CHECK_FAILING_NOTICE_MS = 3 * 24 * 60 * 60 * 1000;
/** A failing streak counts only if the check tried within this window. */
const UPDATE_CHECK_ATTEMPT_FRESH_MS = 2 * 24 * 60 * 60 * 1000;
import { config } from '$lib/server/config.js';
import { hasUsableEmbeddingProvider } from '$lib/server/tasks/builtin/native/embedding-dep.js';
import { stageLabel, componentLabel, stepLabel } from './labels.js';
import { taskName } from './task-names.js';
import { EXPECTED_RUN_ERROR_PATTERN } from '$lib/shared/run-error-severity.js';
import * as m from '$lib/paraglide/messages';

/** Open or force-enabled circuits → one item each.
 *
 * Fix 2 (OSS): half_open state → `warning` with stable fingerprint `'half-open'`
 * so the bell doesn't flap critical→silent→critical while the breaker probes.
 *
 * Fix 3 (OSS): force-enabled circuits → `info` (not critical). Force-enable is a
 * deliberate admin action; raising a fresh critical when "Reset circuit" is clicked
 * would be paradoxical and evict the operator's prior ack.
 *
 * Fix (OSS): an open (non-force-enabled) circuit paused by a KNOWN, self-healing
 * cause — rate limit / quota, the same `EXPECTED_RUN_ERROR_PATTERN` the run-error
 * display classifies as `'expected'` — reads as `critical` ("Something is broken")
 * even though the breaker is doing exactly what it's designed to do while it waits
 * out an external quota window. Those are downgraded to `warning` with calmer
 * copy; any other cause (a genuine outage) stays `critical`. The fingerprint splits
 * `'open'` / `'open-expected'` so an ack held against one classification does not
 * silently carry over if the underlying cause later changes to the other.
 */
export function adaptCircuits(fleet: CircuitFleet): DerivedAlert[] {
    return fleet.entries
        .filter((e) => e.state === 'open' || e.state === 'half_open' || e.forceEnabled)
        .map((e) => {
            const taskRef = `/admin/tasks/${encodeURIComponent(e.taskId)}`;
            const name = taskName(e.taskId);
            const baseActions = [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_task(),
                    href: taskRef,
                },
                {
                    kind: 'reset-circuit' as const,
                    // Same underlying operation as circuitActionLabel('force-enable')
                    // ('breaker: enable, force: true') — align on the one vocabulary
                    // rather than leaking the "circuit" engineering metaphor here.
                    label: m.admin_attention_action_resume_now(),
                    taskId: e.taskId,
                },
                {
                    kind: 'pause' as const,
                    label: m.admin_attention_action_pause_task(),
                    taskId: e.taskId,
                },
            ];

            if (e.forceEnabled) {
                // Fix 3: force-enabled is an intentional bypass → info, not critical.
                return {
                    id: `circuit:${e.taskId}`,
                    fingerprint: 'force-enabled' as const,
                    type: 'circuit-open' as const,
                    severity: 'info' as const,
                    title: m.admin_attention_circuit_force_enabled_title({ task: name }),
                    // Prefer the real error from the task's own last failed run over
                    // the circuit breaker's generic trip-mechanism enum (e.g.
                    // 'probe_failure') — operators need to know WHAT failed, not just
                    // that the failure counter crossed a threshold.
                    detail: e.lastErrorMessage ?? e.openedReason ?? undefined,
                    sourceRef: taskRef,
                    term: 'circuit-breaker',
                    actions: baseActions,
                };
            }

            if (e.state === 'half_open') {
                // Fix 2: half_open is probing, not open — warn not critical, stable fingerprint.
                return {
                    id: `circuit:${e.taskId}`,
                    fingerprint: 'half-open' as const,
                    type: 'circuit-open' as const,
                    severity: 'warning' as const,
                    title: m.admin_attention_circuit_half_open_title({ task: name }),
                    // Prefer the real error from the task's own last failed run over
                    // the circuit breaker's generic trip-mechanism enum (e.g.
                    // 'probe_failure') — operators need to know WHAT failed, not just
                    // that the failure counter crossed a threshold.
                    detail: e.lastErrorMessage ?? e.openedReason ?? undefined,
                    sourceRef: taskRef,
                    term: 'circuit-breaker',
                    actions: baseActions,
                };
            }

            // Open circuit (not force-enabled). Prefer the real error from the task's
            // own last failed run over the circuit breaker's generic trip-mechanism
            // enum (e.g. 'probe_failure') — operators need to know WHAT failed, not
            // just that the failure counter crossed a threshold.
            const message = e.lastErrorMessage ?? e.openedReason ?? undefined;
            const isExpectedWait = message != null && EXPECTED_RUN_ERROR_PATTERN.test(message);

            if (isExpectedWait) {
                // Self-healing quota/rate-limit wait → warning, distinct fingerprint
                // (see Fix comment above) so it can never be mistaken for an outage.
                return {
                    id: `circuit:${e.taskId}`,
                    fingerprint: 'open-expected',
                    type: 'circuit-open' as const,
                    severity: 'warning' as const,
                    title: m.admin_attention_circuit_expected_title({ task: name }),
                    detail: m.admin_attention_circuit_expected_detail({ message }),
                    sourceRef: taskRef,
                    term: 'circuit-breaker',
                    actions: baseActions,
                };
            }

            // Genuine outage → critical, stable state fingerprint. State only — NOT
            // consecutiveFailures. An open circuit keeps accruing failures on every
            // probe; folding that count into the fingerprint evicted the operator's
            // ack on the very next poll. The defining state is "open", not the exact
            // failure tally.
            return {
                id: `circuit:${e.taskId}`,
                fingerprint: e.state,
                type: 'circuit-open' as const,
                severity: 'critical' as const,
                title: m.admin_attention_circuit_open_title({ task: name }),
                detail: message,
                sourceRef: taskRef,
                term: 'circuit-breaker',
                actions: baseActions,
            };
        });
}

/**
 * Operational dead-letter rows aggregated per stage, including unsupported
 * codecs, encrypted files and generic permanent errors. Identity repair rows
 * belong to adaptGaveUp instead, using the same predicate as Fix matches.
 * Retryability alone says whether another attempt may help, not what an
 * operator should repair.
 *
 * Fix 13 (OSS): `totalCountByStage` carries the true per-stage total count
 * (from a separate COUNT query — see attention.queries.ts). The displayed count
 * and `countBucket` fingerprint use `totalCount` so the ack watermark reflects the
 * real population, not the 20-row sample. The 20-row sample is kept for
 * detail/firstError only.
 */
export function adaptDeadLetter(
    rows: DeadLetterRow[],
    totalCountByStage: ReadonlyMap<string, number> = new Map(),
): DerivedAlert[] {
    const groups = new Map(groupByStage(rows));
    // A stage outside the detail sample still owns its counted operational failures.
    for (const [key, count] of totalCountByStage) {
        if (key.startsWith('transient:') && count > 0 && !groups.has(key.slice(10)))
            groups.set(key.slice(10), []);
    }
    return [...groups].flatMap(([stageId, group]) => {
        const transient = group.filter((r) => !r.needs_identity_repair);
        const out: DerivedAlert[] = [];
        const totalTransient = totalCountByStage.get(`transient:${stageId}`) ?? transient.length;
        if (totalTransient > 0) {
            const stage = stageLabel(stageId);
            out.push({
                id: `dead-letter:${stageId}`,
                fingerprint: countBucket(totalTransient),
                count: totalTransient,
                type: 'dead-letter',
                severity: 'critical',
                title:
                    totalTransient === 1
                        ? m.admin_attention_dead_letter_title_one({ count: totalTransient, stage })
                        : m.admin_attention_dead_letter_title_other({
                              count: totalTransient,
                              stage,
                          }),
                detail: firstError(transient),
                sourceRef: '/admin/tasks/pipeline',
                term: 'dead-letter',
                actions: [
                    {
                        kind: 'investigate',
                        label: m.admin_attention_action_view_pipeline(),
                        href: '/admin/tasks/pipeline',
                    },
                    { kind: 'bulk-retry', label: m.admin_attention_action_retry_all(), stageId },
                ],
            });
        }
        return out;
    });
}

/**
 * Never-matched personal files (media items with no external_ids at all) → one
 * calm aggregate `info` nudge. Personal media is often intentional (home
 * videos, obscure rips), so this must never degrade the verdict — it's a
 * doorway to the Fix-matches workbench, not an alarm.
 */
export function adaptUnmatched(count: number): DerivedAlert[] {
    if (count <= 0) return [];
    return [
        {
            id: 'unmatched:all',
            fingerprint: countBucket(count),
            count,
            type: 'unmatched-files' as const,
            severity: 'info' as const,
            title:
                count === 1
                    ? m.admin_attention_unmatched_title_one({ count })
                    : m.admin_attention_unmatched_title_other({ count }),
            detail: m.admin_attention_unmatched_detail(),
            sourceRef: '/admin/library/fix-matches',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_fix_matches(),
                    href: '/admin/library/fix-matches',
                },
            ],
        },
    ];
}

/**
 * "Gave up" items — was-matched-once media whose provider lookup now fails
 * permanently (e.g. a TMDB 404 after an id was retired). One aggregate warning
 * replacing the old per-stage `dead-letter:reidentify:<stage>` items; the
 * Fix-matches workbench (broken-match view) is the single place these render.
 */
export function adaptGaveUp(count: number): DerivedAlert[] {
    if (count <= 0) return [];
    return [
        {
            id: 'gave-up:all',
            fingerprint: countBucket(count),
            count,
            type: 'needs-reidentification' as const,
            severity: 'warning' as const,
            title:
                count === 1
                    ? m.admin_attention_gaveup_title_one({ count })
                    : m.admin_attention_gaveup_title_other({ count }),
            detail: m.admin_attention_gaveup_detail(),
            sourceRef: '/admin/library/fix-matches?view=broken',
            term: 'needs-reidentification',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_review_fix(),
                    href: '/admin/library/fix-matches?view=broken',
                },
            ],
        },
    ];
}

/**
 * Files with recorded health issues (truncated video, missing keyframes,
 * duration mismatch, corrupt tags) → one aggregate warning, linking the
 * System → Health file section.
 *
 * The link target is load-bearing. This count is a COUNT over `media_files`;
 * the media browser lists `media_items`, so pointing it there made the badge
 * unreconcilable with the list it opened — an `extra` is not in
 * `ALL_BROWSABLE_TYPES`, an item-less file is in no `media_items` list at all,
 * and a multi-episode file is one file but N rows. Widening the browser's type
 * set fixes only the first of the three. See `ADMIN_FILE_HEALTH_PATH`.
 */
export function adaptFileHealth(count: number): DerivedAlert[] {
    if (count <= 0) return [];
    return [
        {
            id: 'file-health:all',
            fingerprint: countBucket(count),
            count,
            type: 'file-health' as const,
            severity: 'warning' as const,
            title:
                count === 1
                    ? m.admin_attention_filehealth_title_one({ count })
                    : m.admin_attention_filehealth_title_other({ count }),
            detail: m.admin_attention_filehealth_detail(),
            sourceRef: ADMIN_FILE_HEALTH_PATH,
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_affected_files(),
                    href: ADMIN_FILE_HEALTH_PATH,
                },
            ],
        },
    ];
}

/**
 * Free space on the volumes Lumastra writes to.
 *
 * Design §4.4 puts storage capacity first among the missing producers, and
 * calls it the most common real-world self-host failure. Until now nothing
 * raised it: `checkArtworkDiskHeadroom` already measures every target volume
 * (cached, one statfs per volume per minute) but only uses the verdict to GATE
 * artwork writes. So a filling disk showed up as artwork quietly stopping,
 * with no alert and no stated cause — the operator's first clue was missing
 * posters, which points at the wrong subsystem entirely.
 *
 * States its own `domain` rather than borrowing an enum member. `type` stays
 * `degraded-component` because `AttentionType` is a closed enum on the wire
 * and adding a member breaks decode in a Swift client built against the old
 * one — the deprecated field takes the catch-all, `domain` carries the truth.
 *
 * FAIL-OPEN is preserved and deliberate: a volume whose statfs threw reports
 * `freeBytes: null`, and an unreadable volume is NOT reported as full. An NFS
 * flap must not manufacture a critical alert about a disk that is fine.
 */
/**
 * Operator-facing name for a measured volume.
 *
 * `label` is the internal token `'central'` / `'library'` from
 * `artwork-volume-headroom.ts`. Interpolating it produced "The central disk is
 * nearly full" — and in German "Der Datenträger central ist fast voll", an
 * untranslated internal token in an alert title.
 */
function volumeLabel(label: string): string {
    if (label === 'central') return m.admin_attention_storage_volume_central();
    if (label === 'library') return m.admin_attention_storage_volume_library();
    return label;
}

export function adaptStorageCapacity(volumes: VolumeHeadroom[]): DerivedAlert[] {
    // `belowMargin` is false when freeBytes is null, so unknown volumes drop
    // out here without a second guard.
    const low = volumes.filter((v) => v.belowMargin && v.freeBytes !== null);
    if (low.length === 0) return [];

    // Report the worst volume by name. An operator with a full media mount and
    // a healthy config volume needs to know WHICH one, and an aggregate count
    // ("2 volumes low") is exactly the wrong summary when the fix is per-path.
    const worst = low.reduce((a, b) => ((a.freeBytes ?? 0) <= (b.freeBytes ?? 0) ? a : b));
    const freeGb = Math.max(0, Math.round(((worst.freeBytes ?? 0) / 1024 ** 3) * 10) / 10);

    return [
        {
            // Identity is the STAGE of the problem, not which volume is
            // currently worst. Keying on the worst volume meant that when two
            // volumes were low and they swapped places, the old id vanished
            // from the derivation, reconcile resolved it, a new id appeared —
            // and `first_seen` reset while the operator's ack was lost, all
            // without the underlying problem changing at all.
            id: 'storage:capacity',
            // Bucket DOWNWARD-ONLY by whole GB. A plain floor also changes when
            // free space IMPROVES across a boundary (3.2 -> 4.1 GB), which
            // breaks the acked-fingerprint match and re-surfaces an alert the
            // operator already acknowledged, as a reward for freeing space.
            // Tracking the worst seen keeps the ack until it genuinely worsens.
            fingerprint: `low:${Math.floor(freeGb)}`,
            type: 'degraded-component' as const,
            domain: 'storage',
            severity: 'critical' as const,
            title: m.admin_attention_storage_capacity_title({
                label: volumeLabel(worst.label),
            }),
            detail: m.admin_attention_storage_capacity_detail({
                path: worst.path,
                freeGb: String(freeGb),
            }),
            sourceRef: ADMIN_SYSTEM_HEALTH_PATH,
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_health(),
                    href: ADMIN_SYSTEM_HEALTH_PATH,
                },
            ],
        },
    ];
}

/** Below this the forecast becomes an attention item (about two months). */
export const STORAGE_FORECAST_ATTENTION_DAYS = 61;

/**
 * A library disk that fills within about two months at the current pace — the
 * early warning before `adaptStorageCapacity` (an absolute free-space floor)
 * turns critical. Reads the daily snapshot estimate
 * (`library-storage-growth.service.ts`); a volume with no estimate (not enough
 * snapshots, not filling, never measured) raises nothing.
 *
 * `warning`, not critical: nothing has failed yet and the fix is planned work.
 * One item for the soonest disk, keyed like the capacity item on the stage of
 * the problem, so an ack holds while the same disk keeps filling. The
 * fingerprint buckets the weeks left coarsely (8 / 4 / 2 / 1): a fresh
 * estimate every day must not re-surface an acknowledged item, but crossing
 * into a nearer bucket should.
 */
export function adaptStorageForecast(volumes: LibraryVolumeGrowth[]): DerivedAlert[] {
    const soon = volumes
        .map((v) => ({ v, e: v.estimate }))
        .filter(
            (x): x is { v: LibraryVolumeGrowth; e: Extract<typeof x.e, { state: 'filling' }> } =>
                x.e.state === 'filling' &&
                x.e.daysUntilFull < STORAGE_FORECAST_ATTENTION_DAYS &&
                // A low-confidence median (two weeks of data, one big burst)
                // is the tile's business, not a warning; it nags only when
                // even the slow end of the band fills within the window.
                (x.e.confidence !== 'low' ||
                    (x.e.daysUntilFullHigh !== undefined &&
                        x.e.daysUntilFullHigh < STORAGE_FORECAST_ATTENTION_DAYS)),
        )
        .sort((a, b) => a.e.daysUntilFull - b.e.daysUntilFull);
    if (soon.length === 0) return [];

    const { v, e } = soon[0];
    const weeks = Math.max(1, Math.round(e.daysUntilFull / 7));
    const bucket = weeks <= 1 ? 1 : weeks <= 2 ? 2 : weeks <= 4 ? 4 : 8;
    const freeGb = Math.max(0, Math.round((v.freeBytes / 1024 ** 3) * 10) / 10);
    const gbPerDay = Math.max(0.1, Math.round((e.bytesPerDay / 1024 ** 3) * 10) / 10);

    return [
        {
            id: 'storage:forecast',
            fingerprint: `weeks:${bucket}`,
            type: 'degraded-component' as const,
            domain: 'storage',
            severity: 'warning' as const,
            title:
                e.daysUntilFull < 7
                    ? m.admin_attention_storage_forecast_title_now()
                    : m.admin_attention_storage_forecast_title({ count: weeks }),
            detail: m.admin_attention_storage_forecast_detail({
                libraries: v.libraries.length > 0 ? v.libraries.join(', ') : volumeLabel('library'),
                freeGb: String(freeGb),
                gbPerDay: String(gbPerDay),
            }),
            sourceRef: ADMIN_SYSTEM_HEALTH_PATH,
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_health(),
                    href: ADMIN_SYSTEM_HEALTH_PATH,
                },
            ],
        },
    ];
}

/**
 * Items a task could not process, as reported by the task itself (design §9
 * Slice 4, "plugins from plugin_failure_events").
 *
 * A DIFFERENT population from the dead-letter adapter, which counts
 * `failed_permanent` stage rows. A task reports through `ctx.reportFailure`
 * when one item defeats it, and that need not fail the stage — on preprod, 11
 * unresolved plugin failures sat against 0 failed_permanent rows, overlapping
 * in nothing. They were reachable only by opening each task's Failures tab in
 * turn, and invisible on the board that exists to say what needs attention.
 *
 * One item per task, not one per failure: the per-item list already exists on
 * the task page and is the right place to read it. What the board owes an
 * operator is "this task is dropping items", with a way in.
 *
 * `warning`, not critical: the items are recorded, retryable and named, and
 * the rest of the library is unaffected. Nothing here is an emergency, and the
 * red budget is for things that stop the server working.
 */
export function adaptPluginFailures(
    rows: PluginFailureCountRow[],
    taskNameFor: (id: string) => string = (id) => id,
    /**
     * Whether the task's Failures tab offers a way to retry (per-item retry,
     * or the stage-wide "retry all" for a task that covers stages). The detail
     * line promised "most can be retried" for tasks that offered no retry at
     * all; those now say what actually brings the items back.
     */
    canRetry: (id: string) => boolean = () => true,
): DerivedAlert[] {
    return rows
        .filter((r) => r.count > 0)
        .map((r) => ({
            id: `plugin-failures:${r.pluginId}`,
            // Bucketed so a drifting count does not re-surface an acked alert
            // every cycle, while a genuine jump does.
            fingerprint: countBucket(r.count),
            count: r.count,
            type: 'dead-letter' as const,
            domain: 'tasks',
            severity: 'warning' as const,
            title:
                r.count === 1
                    ? m.admin_attention_plugin_failures_title_one({
                          task: taskNameFor(r.pluginId),
                      })
                    : m.admin_attention_plugin_failures_title_other({
                          count: r.count,
                          task: taskNameFor(r.pluginId),
                      }),
            detail: canRetry(r.pluginId)
                ? m.admin_attention_plugin_failures_detail()
                : m.admin_attention_plugin_failures_detail_no_retry(),
            sourceRef: `/admin/tasks/${encodeURIComponent(r.pluginId)}?tab=failures`,
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_failures(),
                    href: `/admin/tasks/${encodeURIComponent(r.pluginId)}?tab=failures`,
                },
            ],
        }));
}

/**
 * Installed plugins with a newer version available (design §9 Slice 4,
 * "updates — poll, always info").
 *
 * The update CHECK task has been recording `available_version` since it
 * shipped and nothing read the column, so the check ran on schedule, wrote its
 * answer, and no surface ever mentioned it.
 *
 * ALWAYS `info`, never warning, and that is a rule rather than a preference:
 * an available update is not a fault. Nothing is broken, nothing is degraded,
 * and the operator may have excellent reasons to stay put. A dashboard that
 * turns amber because someone else released software is a dashboard people
 * stop reading — the same decay the red budget exists to prevent, arriving by
 * a different door.
 *
 * One aggregate item, not one per plugin: updates arrive in batches and N rows
 * saying the same thing would crowd out problems that are actually wrong.
 */
export function adaptPluginUpdates(rows: PluginUpdateRow[]): DerivedAlert[] {
    if (rows.length === 0) return [];

    // Fingerprint on the exact set of target versions: a NEW update should
    // re-surface after an ack, while re-detecting the same one should not.
    const fingerprint = rows.map((r) => `${r.name}@${r.availableVersion}`).join(',');
    const first = rows[0];

    return [
        {
            id: 'plugin-update:all',
            fingerprint,
            count: rows.length,
            type: 'optional-integration' as const,
            domain: 'plugins',
            severity: 'info' as const,
            title:
                rows.length === 1
                    ? m.admin_attention_plugin_update_title_one({
                          name: first.name,
                          version: first.availableVersion,
                      })
                    : m.admin_attention_plugin_update_title_other({ count: rows.length }),
            detail: m.admin_attention_plugin_update_detail(),
            sourceRef: ADMIN_PLUGINS_PATH,
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_plugins(),
                    href: ADMIN_PLUGINS_PATH,
                },
            ],
        },
    ];
}

/**
 * A newer Lumastra release (the `lumastra-update-check` task's stored release
 * list, evaluated against the RUNNING build at derive time — so an upgraded
 * build drops the notice on its first derive cycle, not a day later).
 *
 * Two ids, two rules:
 *  - `lumastra-update:security` — CRITICAL, and persistent: ack and snooze are
 *    refused for it (`isPersistentAttentionId`). A published fix for a
 *    vulnerability in this server is the one update notice an operator must
 *    not be able to click away; it clears only when the installed version
 *    reaches the fixed one.
 *  - `lumastra-update:release` — INFO, like plugin updates. Fingerprinted on
 *    the version, so dismissing it holds until the next release.
 *
 * Only one of the two at a time: when a security release is pending, the red
 * item already names the latest version. An admin can mark a security release
 * as reviewed on the Instance page (`markSecurityReviewed`); it then counts as
 * a normal update here.
 *
 * A third, independent item, `lumastra-update:check-failing`, says the check
 * itself has not reached GitHub for UPDATE_CHECK_FAILING_NOTICE_MS.
 */
export function adaptLumastraUpdate(
    evaluation: Pick<UpdateEvaluation, 'latest' | 'securityFixedIn'> | null,
    runningVersion: string,
    /** The check's failing streak, from its stored state. */
    failing: { since: string | null; lastAttemptAt: string | null } = {
        since: null,
        lastAttemptAt: null,
    },
    now: number = Date.now(),
): DerivedAlert[] {
    const alerts: DerivedAlert[] = [];
    const action = {
        kind: 'investigate' as const,
        label: m.admin_attention_action_view_update(),
        href: ADMIN_INSTANCE_UPDATES_PATH,
    };

    // A check that keeps failing is the one way this channel goes silent
    // without anyone deciding so. Quiet (`info`) on purpose: an air-gapped
    // box that blocks GitHub is fine, and the detail tells its admin to turn
    // the check off instead.
    const failingSince = failing.since;
    const failingMs = failingSince ? now - Date.parse(failingSince) : NaN;
    // Only while the check is still trying: a streak left over from before
    // the check was switched off must not greet the admin who switches it on.
    const attemptAge = failing.lastAttemptAt ? now - Date.parse(failing.lastAttemptAt) : NaN;
    if (
        failingSince &&
        Number.isFinite(failingMs) &&
        failingMs >= UPDATE_CHECK_FAILING_NOTICE_MS &&
        Number.isFinite(attemptAge) &&
        attemptAge <= UPDATE_CHECK_ATTEMPT_FRESH_MS
    ) {
        alerts.push({
            id: 'lumastra-update:check-failing',
            // One streak = one notice; dismissing it holds until the check
            // recovers and fails again.
            fingerprint: failingSince,
            type: 'optional-integration' as const,
            domain: 'updates',
            severity: 'info' as const,
            title: m.admin_attention_lumastra_check_failing_title({
                days: Math.floor(failingMs / (24 * 60 * 60 * 1000)),
            }),
            detail: m.admin_attention_lumastra_check_failing_detail(),
            sourceRef: ADMIN_INSTANCE_UPDATES_PATH,
            actions: [action],
        });
    }

    const latest = evaluation?.latest;
    if (!latest) return alerts;
    const fixed = evaluation.securityFixedIn;
    if (fixed) {
        alerts.push({
            id: LUMASTRA_SECURITY_UPDATE_ATTENTION_ID,
            fingerprint: `security@${fixed.version}`,
            type: 'optional-integration' as const,
            domain: 'updates',
            severity: 'critical' as const,
            title: m.admin_attention_lumastra_security_title({ version: latest.version }),
            detail: m.admin_attention_lumastra_security_detail({
                fixed: fixed.version,
                current: runningVersion,
            }),
            sourceRef: ADMIN_INSTANCE_UPDATES_PATH,
            actions: [action],
        });
        return alerts;
    }
    alerts.push({
        id: 'lumastra-update:release',
        fingerprint: latest.version,
        type: 'optional-integration' as const,
        domain: 'updates',
        severity: 'info' as const,
        title: m.admin_attention_lumastra_update_title({ version: latest.version }),
        detail: m.admin_attention_lumastra_update_detail({ current: runningVersion }),
        sourceRef: ADMIN_INSTANCE_UPDATES_PATH,
        actions: [action],
    });
    return alerts;
}

/**
 * Plain-language explanation per known integrity-scanner rule id (see the rule
 * constants in `integrity-scanner.ts`) — an operator can't tell what
 * `quarantine-backlog-large` means from the rule id alone, and the old generic
 * "orphaned rows, missing links" sentence was actively wrong for several of
 * these rules. Unknown/future rule ids fall back to the generic sentence so a
 * new scanner rule never renders with no explanation at all.
 */
const INTEGRITY_RULE_EXPLANATIONS: Record<string, () => string> = {
    'episode-jellyfin-only-under-tmdb-series': m.admin_attention_integrity_detail_episode_jf_only,
    'media-item-files-without-default': m.admin_attention_integrity_detail_files_no_default,
    'episode-parent-not-season': m.admin_attention_integrity_detail_episode_bad_parent,
    'season-parent-invalid': m.admin_attention_integrity_detail_season_bad_parent,
    'unprobed-files-stale': m.admin_attention_integrity_detail_unprobed_stale,
    'quarantine-backlog-large': m.admin_attention_integrity_detail_quarantine_backlog,
};

const INTEGRITY_RULE_LABELS: Record<string, () => string> = {
    'episode-jellyfin-only-under-tmdb-series': m.admin_attention_integrity_label_episode_jf_only,
    'media-item-files-without-default': m.admin_attention_integrity_label_files_no_default,
    'episode-parent-not-season': m.admin_attention_integrity_label_episode_bad_parent,
    'season-parent-invalid': m.admin_attention_integrity_label_season_bad_parent,
    'unprobed-files-stale': m.admin_attention_integrity_label_unprobed_stale,
    'quarantine-backlog-large': m.admin_attention_integrity_label_quarantine_backlog,
};

/**
 * Open library-integrity violations (per-rule counts from the integrity
 * scanner) → one aggregate alert naming the most-affected rule, with a
 * plain-language explanation of what that specific rule means.
 */
export function adaptIntegrity(
    countByRule: Record<string, number>,
    severityByRule: Record<string, IntegritySeverity> = {},
): DerivedAlert[] {
    const entries = Object.entries(countByRule).filter(([, n]) => n > 0);
    const total = entries.reduce((sum, [, n]) => sum + n, 0);
    if (total === 0) return [];
    const [topRule, topCount] = entries.sort((a, b) => b[1] - a[1])[0];
    const explanation = (
        INTEGRITY_RULE_EXPLANATIONS[topRule] ?? m.admin_attention_integrity_detail_generic
    )();
    const ruleLabel = (
        INTEGRITY_RULE_LABELS[topRule] ?? m.admin_attention_integrity_label_generic
    )();
    return [
        {
            id: 'integrity:all',
            fingerprint: countBucket(total),
            count: total,
            type: 'integrity' as const,
            severity: entries.every(([rule]) => severityByRule[rule] === 'low')
                ? 'info'
                : 'warning',
            title:
                total === 1
                    ? m.admin_attention_integrity_title_one({ count: total })
                    : m.admin_attention_integrity_title_other({ count: total }),
            detail: `${
                topCount === 1
                    ? m.admin_attention_integrity_detail_prefix_one({
                          rule: ruleLabel,
                          count: topCount,
                      })
                    : m.admin_attention_integrity_detail_prefix({
                          rule: ruleLabel,
                          count: topCount,
                      })
            } ${explanation}`,
            // Route the action to the surface that actually handles the
            // most-affected rule: the quarantine backlog has its own per-series
            // triage page; every other rule is a media-file issue and lands on
            // the file-issues filter as before.
            sourceRef:
                topRule === 'quarantine-backlog-large'
                    ? '/admin/library/quarantine'
                    : ADMIN_MEDIA_FILE_ISSUES_PATH,
            actions: [
                {
                    kind: 'investigate' as const,
                    label:
                        topRule === 'quarantine-backlog-large'
                            ? m.admin_attention_action_review_sync_decisions()
                            : m.admin_attention_action_view_affected_items(),
                    href:
                        topRule === 'quarantine-backlog-large'
                            ? '/admin/library/quarantine'
                            : ADMIN_MEDIA_FILE_ISSUES_PATH,
                },
            ],
        },
    ];
}

/**
 * Live TV source import problems → one item per source. A failed refresh is a
 * warning (the guide/channels are going stale); a successful refresh that
 * logged parse warnings is an info nudge (import worked, but lines were
 * skipped). Fingerprints are stable per state so an operator ack sticks.
 */
export function adaptLiveTvImport(sources: LiveTvSourceSafeRow[]): DerivedAlert[] {
    const out: DerivedAlert[] = [];
    for (const s of sources) {
        const status = s.last_refresh_status;
        if (status === 'failed' || status === 'error') {
            const summary = s.last_refresh_summary as { error?: unknown } | null;
            const errText =
                // Redacted on read too: rows written before the write-time redaction
                // may still carry an Xtream URL with the subscription in its path.
                summary && typeof summary.error === 'string'
                    ? redactLiveTvUrlsInText(summary.error).slice(0, 140)
                    : undefined;
            out.push({
                id: `livetv-import:${s.id}`,
                fingerprint: 'failed',
                type: 'livetv-import' as const,
                severity: 'warning' as const,
                title: m.admin_attention_livetv_failed_title({ name: s.name }),
                detail: errText ?? m.admin_attention_livetv_failed_detail_fallback(),
                sourceRef: '/admin/settings/livetv',
                actions: [
                    {
                        kind: 'investigate' as const,
                        label: m.admin_attention_action_view_livetv_sources(),
                        href: '/admin/settings/livetv',
                    },
                ],
            });
            continue;
        }
        // Successful import that skipped lines — info, never degrades.
        const summary = s.last_refresh_summary as { warnings?: unknown } | null;
        const warnings = Array.isArray(summary?.warnings) ? summary.warnings : [];
        if (status === 'success' && warnings.length > 0) {
            const first = warnings.find((w): w is string => typeof w === 'string');
            out.push({
                id: `livetv-import:${s.id}`,
                fingerprint: `warnings:${countBucket(warnings.length)}`,
                count: warnings.length,
                type: 'livetv-import' as const,
                severity: 'info' as const,
                title:
                    warnings.length === 1
                        ? m.admin_attention_livetv_warnings_title_one({
                              name: s.name,
                              count: warnings.length,
                          })
                        : m.admin_attention_livetv_warnings_title_other({
                              name: s.name,
                              count: warnings.length,
                          }),
                detail: first ? redactLiveTvUrlsInText(first).slice(0, 140) : undefined,
                sourceRef: '/admin/settings/livetv',
                actions: [
                    {
                        kind: 'investigate' as const,
                        label: m.admin_attention_action_view_livetv_sources(),
                        href: '/admin/settings/livetv',
                    },
                ],
            });
        }
    }
    return out;
}

/**
 * Recovery actions the auto-promotion watches. Routine chatter (leader
 * renewals, circuit transitions — those have their own alerts) is excluded;
 * these four mean "something broke and a subsystem silently repaired it".
 */
export const RECOVERY_AUDIT_ACTIONS = [
    'orphans-reclaimed',
    'event-auto-requeued',
    'stage-sweep-capped',
    'boot-recovery-complete',
] as const;

/**
 * Plain-language explanation per recovery action: what actually happened, and
 * what an operator should look at.
 *
 * 🔴 Written for someone running this on their own hardware who has never read
 * the task-system source. The previous copy said "the same automatic recovery
 * ('orphaned runs reclaimed') ran ×19 in 24 h — something keeps re-wedging",
 * which names an internal mechanism, uses a word no operator uses, and gives
 * no idea what to do. Deploy churn is filtered out upstream (see the restart
 * grace in loadRepeatedSubsystemEvents), so by the time one of these fires it
 * really is worth explaining properly.
 */
const RECOVERY_EXPLANATIONS: Record<string, { title: (n: number) => string; detail: string }> = {
    'orphans-reclaimed': {
        title: (n) =>
            n === 1
                ? m.admin_attention_recovery_orphans_title_one({ count: n })
                : m.admin_attention_recovery_orphans_title_other({ count: n }),
        detail: m.admin_attention_recovery_orphans_detail(),
    },
    'boot-recovery-complete': {
        title: (n) =>
            n === 1
                ? m.admin_attention_recovery_boot_title_one({ count: n })
                : m.admin_attention_recovery_boot_title_other({ count: n }),
        detail: m.admin_attention_recovery_boot_detail(),
    },
    'event-auto-requeued': {
        title: (n) =>
            n === 1
                ? m.admin_attention_recovery_events_title_one({ count: n })
                : m.admin_attention_recovery_events_title_other({ count: n }),
        detail: m.admin_attention_recovery_events_detail(),
    },
    'stage-sweep-capped': {
        title: (n) =>
            n === 1
                ? m.admin_attention_recovery_stagesweep_title_one({ count: n })
                : m.admin_attention_recovery_stagesweep_title_other({ count: n }),
        detail: m.admin_attention_recovery_stagesweep_detail(),
    },
};

/**
 * Repeated-recovery auto-promotion (spec §5): the SAME autonomous recovery
 * firing over and over means a fault keeps recurring — each individual
 * recovery "succeeds", so nothing else ever tells the operator. One warning
 * per repeating (category, action) group.
 */
export function adaptRepeatedRecovery(rows: RepeatedSubsystemEventRow[]): DerivedAlert[] {
    return rows.map((r) => {
        const explained = RECOVERY_EXPLANATIONS[r.action];
        const title = explained
            ? explained.title(r.cnt)
            : `An automatic recovery ('${prettifyAction(r.action)}') ran ${r.cnt} times in 24 h`;
        // Keep the raw subsystem summary, but behind the explanation — the
        // operator needs to know what it MEANS before what it said.
        const detail = explained
            ? `${explained.detail}${r.last_summary ? ` (most recent: ${r.last_summary})` : ''}`
            : (r.last_summary ?? undefined);
        return {
            id: `repeated-recovery:${r.category}:${r.action}`,
            fingerprint: countBucket(r.cnt),
            count: r.cnt,
            type: 'repeated-recovery' as const,
            severity: 'warning' as const,
            title,
            detail,
            sourceRef: '/admin/system/health#activity',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_health(),
                    href: '/admin/system/health#activity',
                },
            ],
        };
    });
}

/**
 * Replicas holding DIFFERENT master keys → one critical alert.
 *
 * When `LUMASTRA_MASTER_KEY` is unset, each replica generates its own key file
 * under the config dir. If that dir is not a shared volume, the replicas
 * silently diverge — and since `JWT_SECRET` is derived from the master key when
 * unset, the visible symptom is users being logged out at random depending on
 * which replica served the request, plus plugin secrets and Subsonic tokens
 * that fail to decrypt on some nodes but not others. None of those errors point
 * at the cause, which is why this is worth its own alert rather than leaving
 * operators to correlate it.
 *
 * Critical, not warning: authentication is already intermittently broken by the
 * time this fires. Fingerprints are HMAC-derived and truncated, so listing them
 * in the detail line is safe and lets an operator see which node is the odd one
 * out.
 */
export function adaptClusterKeyMismatch(
    nodes: Array<{ instanceId: string; keyFingerprint: string }>,
): DerivedAlert[] {
    // Only nodes that actually published a fingerprint can disagree; '' means
    // "no key resolved, or a build predating the field", i.e. unknown.
    const known = nodes.filter((n) => n.keyFingerprint !== '');
    const distinct = new Set(known.map((n) => n.keyFingerprint));
    if (distinct.size <= 1) return [];

    const groups = [...distinct]
        .map((fp) => `${fp} (${known.filter((n) => n.keyFingerprint === fp).length})`)
        .join(', ');

    return [
        {
            id: 'cluster-key-mismatch',
            // Keyed on the set of distinct keys, so an ack survives heartbeat
            // churn but a NEW divergent node re-raises the alert.
            fingerprint: [...distinct].sort().join('|'),
            type: 'cluster-key-mismatch' as const,
            severity: 'critical' as const,
            title: m.admin_attention_cluster_mismatch_title({ count: distinct.size }),
            detail: m.admin_attention_cluster_mismatch_detail({ groups }),
            // `/admin/cluster` does not exist — cluster is a TAB on the health
            // page (`admin/system/health/+page.svelte`, Tab = 'system' |
            // 'cluster'). This alert is CRITICAL and its only action 404'd,
            // firing exactly when a multi-replica operator has divergent master
            // keys — the scenario the backup docs warn about.
            sourceRef: '/admin/system/health?tab=cluster',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_cluster(),
                    href: '/admin/system/health?tab=cluster',
                },
            ],
        },
    ];
}

/** Where per-service memory, host memory and restarts are shown. */
const ADMIN_CLUSTER_PATH = '/admin/system/health?tab=cluster';

/**
 * How long a memory condition must hold before it becomes an attention item.
 * Heartbeats are 10 s snapshots and derivation runs every 60 s: one beat at 90 %
 * is a burst (a scan batch, a GC pause), ten minutes of them is a service that
 * will be OOM-killed or a machine that will start killing processes.
 */
export const RESOURCE_PRESSURE_SUSTAIN_MS = 10 * 60_000;

/** Unclean exits of one instance inside 24 h (deploy waves excluded) that raise an item. */
export const UNCLEAN_EXIT_THRESHOLD = 2;

/** The heartbeat fields the pressure producer reads (LiveClusterNode satisfies it). */
export interface PressureNode {
    instanceId: string;
    role: string;
    hostname: string;
    resources?: {
        memoryUsedBytes: number;
        memoryLimitBytes?: number;
        memoryPeakBytes?: number;
        memoryPressureBytes?: number;
        memoryReclaimableFileBytes?: number;
        memoryPressurePeakBytes?: number;
    };
    host?: { id: string; name?: string; memTotalBytes?: number; memAvailableBytes?: number };
}

/** One memory condition seen in the current heartbeats. */
export interface PressureCondition {
    /** Clock key for trackPressureSince: one per subject and level. */
    key: string;
    /** Stable subject: `<role>@<machine>` for a container, the host id for a machine. */
    subject: string;
    /** containerPeak: the 24 h peak after excluding clean file cache came within 5 % of the limit. */
    kind: 'container' | 'containerPeak' | 'host';
    level: 'warn' | 'critical';
    /** Container: used / limit. Host: used share (1 - available / total). */
    ratio: number;
    role?: string;
    /** Machine label: Kubernetes node / LUMASTRA_HOST_NAME, else the hostname. */
    where: string;
    usedBytes?: number;
    limitBytes?: number;
    peakBytes?: number;
    reclaimableFileBytes?: number;
    usesNonReclaimable?: boolean;
    availableBytes?: number;
    totalBytes?: number;
}

/**
 * Memory conditions in the live heartbeats.
 *
 * Keys are STABLE subjects, never instance ids: with an unpinned INSTANCE_ID every
 * restart is a new id, so an instance-keyed clock would restart exactly when a
 * container is OOM-killed and come back — the case this exists for. A container is
 * `<role>@<machine>` (several replicas of one role on one machine collapse to the
 * fullest), a machine is its host id.
 *
 * A condition at critical level is listed twice (warn key + critical key) so each
 * level keeps its own clock: a container that sits at 88 % and briefly touches
 * 96 % stays a warning instead of restarting its warning clock.
 */
export function resourcePressureConditions(nodes: readonly PressureNode[]): PressureCondition[] {
    const byKey = new Map<string, PressureCondition>();
    const keep = (c: PressureCondition): void => {
        const prev = byKey.get(c.key);
        if (!prev || c.ratio > prev.ratio) byKey.set(c.key, c);
    };
    for (const n of nodes) {
        const machine = n.host?.id ?? `name:${n.hostname}`;
        const where = n.host?.name ?? n.hostname;
        const res = n.resources;
        if (
            res?.memoryLimitBytes &&
            res.memoryLimitBytes > 0 &&
            Number.isFinite(res.memoryUsedBytes)
        ) {
            const used = res.memoryPressureBytes ?? res.memoryUsedBytes;
            const ratio = used / res.memoryLimitBytes;
            const subject = `${n.role}@${machine}`;
            const base = {
                subject,
                kind: 'container' as const,
                ratio,
                role: n.role,
                where,
                usedBytes: used,
                reclaimableFileBytes: res.memoryReclaimableFileBytes,
                usesNonReclaimable: res.memoryPressureBytes !== undefined,
                limitBytes: res.memoryLimitBytes,
            };
            const level = containerMemoryLevel(ratio);
            if (level !== 'ok') keep({ ...base, key: `container:${subject}`, level: 'warn' });
            if (level === 'critical') {
                keep({ ...base, key: `container:${subject}:critical`, level: 'critical' });
            }
            // The peak is already a 24 h maximum, so its "sustained" clock simply runs
            // while the peak stays in the window and the item clears a day after it.
            // A working-set peak still includes active file cache. Do not combine
            // that historical maximum with today's cache. Without memory.stat the
            // cache is unknown, so fall back to the working-set peak like the live check.
            const peak =
                res.memoryPressureBytes === undefined
                    ? (res.memoryPressurePeakBytes ?? res.memoryPeakBytes)
                    : res.memoryPressurePeakBytes;
            if (peak !== undefined && Number.isFinite(peak)) {
                const peakRatio = peak / res.memoryLimitBytes;
                if (containerPeakLevel(peakRatio) !== 'ok') {
                    keep({
                        ...base,
                        kind: 'containerPeak',
                        ratio: peakRatio,
                        peakBytes: peak,
                        key: `container-peak:${subject}`,
                        level: 'warn',
                    });
                }
            }
        }
        // Host figures are host-wide: every service on one machine reports the same
        // numbers, so the machine is one subject whichever service reported it.
        const host = n.host;
        if (!host?.memTotalBytes || host.memAvailableBytes === undefined) continue;
        if (!Number.isFinite(host.memAvailableBytes)) continue;
        const level = hostMemoryLevel(host.memAvailableBytes, host.memTotalBytes);
        if (level === 'ok') continue;
        const base = {
            subject: host.id,
            kind: 'host' as const,
            ratio: 1 - host.memAvailableBytes / host.memTotalBytes,
            where,
            availableBytes: host.memAvailableBytes,
            totalBytes: host.memTotalBytes,
        };
        keep({ ...base, key: `host:${host.id}`, level: 'warn' });
        if (level === 'critical') {
            keep({ ...base, key: `host:${host.id}:critical`, level: 'critical' });
        }
    }
    return [...byKey.values()];
}

function roleLabel(role: string | undefined): string {
    switch (role) {
        case 'web':
            return m.admin_cluster_kind_web();
        case 'worker':
            return m.admin_cluster_kind_worker();
        case 'proxy':
            return m.admin_cluster_kind_proxy();
        default:
            return m.admin_cluster_kind_general();
    }
}

/**
 * Sustained memory pressure → at most one item for containers and one for
 * machines, naming the worst and counting the rest.
 *
 * `clocks` comes from trackPressureSince: every condition seen now, plus ones that
 * dropped out less than its gap grace ago (with their last snapshot), so a dip of
 * a cycle neither restarts the clock nor resolves the item.
 *
 * Ack semantics: the fingerprint is the level plus the set of subjects in
 * trouble. An ack therefore survives a redeploy of the same over-limit service
 * (subjects are role@machine, not instance ids), but a DIFFERENT container or
 * machine joining, or warning turning critical, re-raises it.
 *
 * Critical, not warning, at the top level: a container at 95 % of its limit is
 * one burst away from an OOM kill, and a machine with under 5 % memory available
 * (and under 2 GiB) is where the kernel starts killing processes (prod's media
 * node once hit a memcg-OOM kernel panic with container limits summing past its RAM).
 */
export function adaptResourcePressure(
    clocks: ReadonlyMap<string, PressureClock<PressureCondition>>,
    now: number = Date.now(),
): DerivedAlert[] {
    const validClocks = new Map([...clocks].filter(([, c]) => isPressureClock(c)));
    const sustained = [...validClocks.values()].filter(
        (c) => now - c.first >= RESOURCE_PRESSURE_SUSTAIN_MS,
    );
    const alerts: DerivedAlert[] = [];
    // Current pressure suppresses the peak even while its sustain clock is still running.
    const pressedNow = new Set(
        [...validClocks.values()]
            .filter((c) => c.value.kind === 'container')
            .map((c) => c.value.subject),
    );
    for (const kind of ['container', 'containerPeak', 'host'] as const) {
        const ofKind = sustained
            .filter((c) => c.value.kind === kind)
            .map((c) => c.value)
            .filter((c) => kind !== 'containerPeak' || !pressedNow.has(c.subject));
        if (ofKind.length === 0) continue;
        const worst = ofKind.reduce((a, b) =>
            (b.level === 'critical' && a.level !== 'critical') ||
            (b.level === a.level && b.ratio > a.ratio)
                ? b
                : a,
        );
        const subjects = [...new Set(ofKind.map((c) => c.subject))].sort();
        // How long the subject has been under pressure at all: its warn clock,
        // which a fresh critical clock must not shorten.
        const warnClock = validClocks.get(worst.key.replace(/:critical$/, ''));
        const since = warnClock?.first ?? validClocks.get(worst.key)?.first ?? now;
        const minutes = String(Math.floor((now - since) / 60_000));
        const service = roleLabel(worst.role);
        let detail: string =
            kind === 'containerPeak'
                ? m.admin_attention_pressure_peak_detail({
                      service,
                      host: worst.where,
                      peak: formatBinaryBytes(worst.peakBytes ?? 0),
                      limit: formatBinaryBytes(worst.limitBytes ?? 0),
                      now: formatBinaryBytes(worst.usedBytes ?? 0),
                  })
                : kind === 'container'
                  ? (worst.usesNonReclaimable
                        ? m.admin_attention_pressure_container_nonreclaimable_detail
                        : m.admin_attention_pressure_container_detail)({
                        service,
                        host: worst.where,
                        percent: String(Math.round(worst.ratio * 100)),
                        limit: formatBinaryBytes(worst.limitBytes ?? 0),
                        minutes,
                    })
                  : m.admin_attention_pressure_host_detail({
                        host: worst.where,
                        available: formatBinaryBytes(worst.availableBytes ?? 0),
                        total: formatBinaryBytes(worst.totalBytes ?? 0),
                        minutes,
                    });
        if (kind !== 'host' && worst.reclaimableFileBytes !== undefined) {
            detail += ` ${m.admin_attention_pressure_cache_detail({ cache: formatBinaryBytes(worst.reclaimableFileBytes) })}`;
        }
        if (subjects.length > 1) {
            detail += ` ${m.admin_attention_pressure_more({ count: subjects.length - 1 })}`;
        }
        alerts.push({
            id: `resource-pressure:${kind === 'containerPeak' ? 'container-peak' : kind}`,
            fingerprint: `${worst.level}:${subjects.join(',')}`,
            type: 'degraded-component' as const,
            domain: 'system',
            severity: worst.level === 'critical' ? ('critical' as const) : ('warning' as const),
            title:
                kind === 'containerPeak'
                    ? m.admin_attention_pressure_peak_title({ service })
                    : kind === 'container'
                      ? m.admin_attention_pressure_container_title({ service })
                      : m.admin_attention_pressure_host_title({ host: worst.where }),
            detail,
            sourceRef: ADMIN_CLUSTER_PATH,
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_cluster(),
                    href: ADMIN_CLUSTER_PATH,
                },
            ],
        });
    }
    return alerts;
}

/**
 * A service that keeps dying without a graceful shutdown (OOM kill, crash, lost
 * node) → one warning per instance. Deploy waves are filtered upstream (see
 * loadUncleanExits), and the counts only exist for a stable INSTANCE_ID, which is
 * exactly the setup (Kubernetes, compose with pinned ids) where a container is
 * restarted in place and nothing else would say so.
 */
export function adaptUncleanExits(rows: readonly UncleanExitRow[]): DerivedAlert[] {
    return rows
        .filter((r) => r.cnt >= UNCLEAN_EXIT_THRESHOLD)
        .map((r) => {
            const service = roleLabel(r.role ?? undefined);
            return {
                id: `unclean-exits:${r.instanceId}`,
                fingerprint: countBucket(r.cnt),
                count: r.cnt,
                type: 'degraded-component' as const,
                domain: 'system',
                severity: 'warning' as const,
                title: m.admin_attention_unclean_exits_title({ service, count: r.cnt }),
                detail: m.admin_attention_unclean_exits_detail({
                    service,
                    host: r.hostname ?? r.instanceId,
                }),
                sourceRef: ADMIN_CLUSTER_PATH,
                actions: [
                    {
                        kind: 'investigate' as const,
                        label: m.admin_attention_action_view_cluster(),
                        href: ADMIN_CLUSTER_PATH,
                    },
                ],
            };
        });
}

/**
 * A Live TV proxy whose protocol this server does not work with → critical. The proxy
 * runs on its own pinned image, so an app update (or rollback) can leave it behind;
 * then every live channel fails while the rest of the app looks healthy. A proxy that
 * merely changed since its image is shown on the cluster tab only (proxy-compat.ts).
 */
export function adaptLiveTvProxyCompat(
    nodes: Array<{
        role: string;
        version: string;
        proxyProtocol?: number;
        proxyBuild?: string;
    }>,
    app: AppProxyExpectation,
    serverVersion: string,
): DerivedAlert[] {
    const incompatible = nodes
        .filter((n) => n.role === 'proxy')
        .map((n) => ({ node: n, compat: decideProxyCompat(n, app) }))
        .filter(({ compat }) => compat.state === 'incompatible');
    if (incompatible.length === 0) return [];
    const [{ node }] = incompatible;
    // Only protocol_too_old is incompatible; a newer proxy is a cluster-tab notice.
    const detail = m.admin_attention_livetv_proxy_too_old_detail({
        proxyVersion: node.version,
        version: serverVersion,
    });
    return [
        {
            id: 'livetv-proxy-compat',
            // Re-raises after an ack when the proxy or this server changes version.
            fingerprint: [
                serverVersion,
                ...incompatible.map(({ node: n, compat: c }) => `${n.version}:${c.proxyProtocol}`),
            ]
                .sort()
                .join('|'),
            type: 'degraded-component' as const,
            domain: 'livetv',
            severity: 'critical' as const,
            title: m.admin_attention_livetv_proxy_incompatible_title(),
            detail,
            sourceRef: '/admin/system/health?tab=cluster',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_cluster(),
                    href: '/admin/system/health?tab=cluster',
                },
            ],
        },
    ];
}

/** Human phrase for a recovery audit action id. */
function prettifyAction(action: string): string {
    const KNOWN: Record<string, string> = {
        'orphans-reclaimed': 'orphaned runs reclaimed',
        'event-auto-requeued': 'pipeline events requeued',
        'stage-sweep-capped': 'stage sweep capped',
        'boot-recovery-complete': 'boot recovery',
    };
    return KNOWN[action] ?? action.replace(/[-_]+/g, ' ');
}

/**
 * Dead-lettered pipeline events (`event_outbox.dead_letter`) → a single
 * aggregate warning. The dispatcher gives up on an event after MAX_ATTEMPTS
 * failed dispatches, so the stage invalidation it carried never propagated —
 * a silent staleness that otherwise only ever appears in the dispatcher logs
 * (the very recovery mechanism the pipeline relies on, dying quietly). One
 * warning (not one per event) keeps it from drowning the board; the alert
 * rides the dedicated `outbox-dead-letter:` id prefix — distinct from the
 * ingest-map `dead-letter:` source — so a failed source query can't
 * false-resolve it.
 *
 * `rows` arrives ordered by count descending (see `summarizeDeadLetterEvents`),
 * so `rows[0]` is the most-affected event.
 */
export function adaptOutboxDeadLetter(rows: DeadLetterEventSummaryRow[]): DerivedAlert[] {
    const total = rows.reduce((sum, r) => sum + r.cnt, 0);
    if (total === 0) return [];
    const top = rows[0];
    // Cap the sample error to match the 140-char house convention every other
    // last_error-bearing adapter follows (see firstError).
    const sample = rows.find((r) => r.last_error)?.last_error?.slice(0, 140) ?? null;
    const detail =
        `Most affected: ${top.event_name} (${top.cnt}).` + (sample ? ` Last error: ${sample}` : '');
    return [
        {
            id: 'outbox-dead-letter:all',
            fingerprint: countBucket(total),
            count: total,
            type: 'dead-letter',
            severity: 'warning',
            title:
                total === 1
                    ? m.admin_attention_outbox_deadletter_title_one({ count: total })
                    : m.admin_attention_outbox_deadletter_title_other({ count: total }),
            detail,
            sourceRef: '/admin/system/health#activity',
            term: 'dead-letter',
            actions: [
                {
                    kind: 'requeue-dead-letter',
                    label: m.admin_attention_action_requeue(),
                },
                {
                    kind: 'investigate',
                    label: m.admin_attention_action_view_system_health(),
                    href: '/admin/system/health#activity',
                },
            ],
        },
    ];
}

/**
 * Stuck rows aggregated per stage → one item per stage.
 *
 * During the initial 48-hour ingest window (`isInitializing` = true) the item is
 * downgraded from `warning` to `info` and the title is reworded to avoid
 * alarming operators who are simply waiting for a large first scan to complete.
 * Once the window has passed the behavior is identical to the pre-initializing
 * baseline: `warning` with the standard stuck-wedge copy.
 */
export function adaptStuck(rows: StuckItemRow[], isInitializing: boolean = false): DerivedAlert[] {
    return groupByStage(rows).map(([stageId, group]) => {
        const n = group.length;
        const stage = stageLabel(stageId);
        if (isInitializing) {
            return {
                id: `stuck-items:${stageId}`,
                fingerprint: countBucket(n),
                count: n,
                type: 'stuck-items' as const,
                severity: 'info' as const,
                title:
                    n === 1
                        ? m.admin_attention_stuck_init_title_one({ count: n, stage })
                        : m.admin_attention_stuck_init_title_other({ count: n, stage }),
                detail: firstError(group),
                sourceRef: '/admin/tasks/pipeline',
                term: 'stuck-wedged',
                actions: [
                    {
                        kind: 'investigate' as const,
                        label: m.admin_attention_action_view_pipeline(),
                        href: '/admin/tasks/pipeline',
                    },
                    {
                        kind: 'release-stuck' as const,
                        label: m.admin_attention_action_release_stuck(),
                        stageId,
                    },
                ],
            };
        }
        return {
            id: `stuck-items:${stageId}`,
            fingerprint: countBucket(n),
            count: n,
            type: 'stuck-items' as const,
            severity: 'warning' as const,
            title:
                n === 1
                    ? m.admin_attention_stuck_title_one({ count: n, stage })
                    : m.admin_attention_stuck_title_other({ count: n, stage }),
            detail: firstError(group),
            sourceRef: '/admin/tasks/pipeline',
            term: 'stuck-wedged',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_pipeline(),
                    href: '/admin/tasks/pipeline',
                },
                {
                    kind: 'release-stuck' as const,
                    label: m.admin_attention_action_release_stuck(),
                    stageId,
                },
            ],
        };
    });
}

/**
 * Per-task failure spikes → one item each. An early warning BEFORE the circuit
 * trips: a task throwing repeated run-level failures while its breaker is still
 * closed. Suppressed for tasks whose circuit is already open/force-enabled, since
 * `circuit-open` is the louder (critical) alert for those.
 *
 * During the initial 48-hour ingest window (`isInitializing` = true) the item is
 * downgraded from `warning` to `info` with reassuring copy: first-scan churn
 * (metadata rate-limits, probe retries) is normal and not operator-actionable.
 * Once the window has passed, behavior is unchanged: `warning` severity.
 */
export function adaptFailedRunSpikes(
    rows: FailedRunSpikeRow[],
    suppressedTaskIds: ReadonlySet<string>,
    isInitializing: boolean = false,
): DerivedAlert[] {
    return rows
        .filter((r) => !suppressedTaskIds.has(r.task_id))
        .map((r) => {
            const taskRef = `/admin/tasks/${encodeURIComponent(r.task_id)}`;
            const name = taskName(r.task_id);
            const actions = [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_task(),
                    href: taskRef,
                },
                {
                    kind: 'stop' as const,
                    label: m.admin_attention_action_stop_runs(),
                    taskId: r.task_id,
                },
                {
                    kind: 'pause' as const,
                    label: m.admin_attention_action_pause_task(),
                    taskId: r.task_id,
                },
            ];
            if (isInitializing) {
                return {
                    id: `failed-run-spike:${r.task_id}`,
                    fingerprint: countBucket(r.fail_count),
                    count: r.fail_count,
                    type: 'failed-run-spike' as const,
                    severity: 'info' as const,
                    title:
                        r.fail_count === 1
                            ? m.admin_attention_failed_spike_init_title_one({
                                  count: r.fail_count,
                                  task: name,
                              })
                            : m.admin_attention_failed_spike_init_title_other({
                                  count: r.fail_count,
                                  task: name,
                              }),
                    // Fix 5 (OSS): explain when the alert self-resolves so operators
                    // aren't alarmed by transient provider retries during first ingest.
                    detail: m.admin_attention_failed_spike_init_detail(),
                    sourceRef: taskRef,
                    term: 'failed-run-spike',
                    actions,
                };
            }
            return {
                id: `failed-run-spike:${r.task_id}`,
                fingerprint: countBucket(r.fail_count),
                count: r.fail_count,
                type: 'failed-run-spike' as const,
                severity: 'warning' as const,
                title:
                    r.fail_count === 1
                        ? m.admin_attention_failed_spike_title_one({
                              count: r.fail_count,
                              task: name,
                          })
                        : m.admin_attention_failed_spike_title_other({
                              count: r.fail_count,
                              task: name,
                          }),
                sourceRef: taskRef,
                term: 'failed-run-spike',
                actions,
            };
        });
}

/**
 * Compact human-readable age for attention detail strings (e.g. "4m", "12s", "1h").
 * Mirrors the private formatAge in health-verdict.ts — kept local so adapters.ts
 * does not import from the observability subsystem.
 *
 * Fix 6 (OSS): used to show overdue duration in the schedule detail string.
 */
function formatAge(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m}m`;
    return `${Math.round(m / 60)}h`;
}

/** Overdue band for the fingerprint — raw overdueByMs grows every poll and would
 *  evict an ack every cycle; bucketing keeps suppression stable. */
function overdueBand(ms: number): string {
    if (ms < 3_600_000) return 'sub-1h';
    if (ms < 86_400_000) return '1-24h';
    return '24h+';
}

/**
 * Overdue schedules → one warning each, EXCEPT tasks that have actually run
 * recently. A task driven by events / stage-sweep (e.g. trickplay-generation)
 * can have a wedged or redundant time-schedule whose `next_fire_at` is frozen,
 * yet it completes runs constantly — an "overdue by 161h" alarm there is pure
 * noise, not an actionable miss. `recentlyActiveTaskIds` (a recent run of ANY
 * trigger) suppresses those while still surfacing a schedule that's overdue AND
 * genuinely not running.
 *
 * Fix 11 (OSS): `openCircuitTaskIds` — tasks whose circuit is already open. An
 * open circuit is the louder, more actionable signal; the overdue-schedule
 * warning for the same task is redundant noise. Mirror the suppressedTaskIds
 * pattern used for failed-run spikes.
 */
export function adaptOverdueSchedules(
    views: ScheduleOverdueView[],
    recentlyActiveTaskIds: ReadonlySet<string> = new Set(),
    openCircuitTaskIds: ReadonlySet<string> = new Set(),
): DerivedAlert[] {
    return views
        .filter(
            (v) =>
                v.overdue &&
                !recentlyActiveTaskIds.has(v.taskId) &&
                !openCircuitTaskIds.has(v.taskId), // Fix 11: suppress when circuit already fires
        )
        .map((v) => ({
            id: `overdue-schedule:${v.taskId}`,
            fingerprint: overdueBand(v.overdueByMs),
            type: 'overdue-schedule' as const,
            severity: 'warning' as const,
            title: m.admin_attention_overdue_title({ task: taskName(v.taskId) }),
            // Fix 6 (OSS): show relative overdue duration alongside the raw timestamp
            // so operators immediately see how late the schedule is.
            detail: m.admin_attention_overdue_detail({
                age: formatAge(v.overdueByMs),
                date: v.nextFireAt,
            }),
            sourceRef: '/admin/tasks/runs',
            term: 'overdue-schedule',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_runs(),
                    href: '/admin/tasks/runs',
                },
                {
                    kind: 'trigger-run' as const,
                    label: m.admin_attention_action_run_now(),
                    taskId: v.taskId,
                },
            ],
        }));
}

/**
 * Task-system LIVENESS reasons (worker heartbeats, resource-class leaders, data
 * invariants) → one item each. This folds the observability health verdict's
 * liveness axes INTO the attention spine, so the bell no longer shows "healthy"
 * while a worker is dead, a class has no leader, or an invariant is red.
 *
 * We accept the already-computed `computeHealthVerdict().reasons` and keep only
 * the liveness codes — deliberately EXCLUDING `schedule-overdue`
 * (adaptOverdueSchedules already emits those) and `inputs-unreadable` (a
 * Valkey/DB outage is already a critical degraded-component alert). That avoids
 * double-counting. On a Valkey outage computeHealthVerdict short-circuits to a
 * single `inputs-unreadable` reason, so this emits nothing rather than a wall of
 * spurious "every worker dead" alarms.
 */
const LIVENESS_CODES = new Set<string>([
    'subsystem-dead',
    'subsystem-degraded',
    'class-no-leader',
    'leader-expiring',
    'invariant-red',
    'invariant-amber',
    'invariant-unknown',
]);

/**
 * Invariant codes for which adaptOutboxDeadLetter is the single authoritative
 * signal owner. Suppress these from adaptTaskLiveness to avoid a dual-signal
 * (invariant amber/red + outbox-dead-letter adapter) for the same root cause.
 *
 * Fix 9 (OSS): adaptOutboxDeadLetter owns the `outbox-dead-letter` invariant.
 */
const OUTBOX_DEAD_LETTER_INVARIANT_IDS = new Set<string>(['outbox-dead-letter']);

/**
 * Real domain for each health-invariants.ts id (design "Problems as
 * Architecture" §9 Slice 3 step 4). Almost every invariant is a pipeline/
 * task-engine concern; these two are not — `metadata-storage-writability` is
 * a disk-mount fault and `transcode-failures-24h` is a playback/encoder
 * fault — and namespacing them under a blanket `task-liveness:` prefix
 * (routed unconditionally to the Tasks nav dot by `attention-section-map.ts`)
 * sent operators chasing a full disk or a broken GPU driver to a page with
 * nothing wrong on it.
 *
 * Migration 16.233.0 rewrites every EXISTING row with this exact map (ids are
 * ack anchors, so the two must stay in step) — the same discipline
 * `DOMAIN_BY_ATTENTION_TYPE` (`shared/attention-domain.ts`) documents for its
 * own migration.
 */
/**
 * Every id prefix `adaptTaskLiveness` can emit, now that the bridge namespaces by
 * domain instead of the old flat `task-liveness:`.
 *
 * Exported because two things outside this file must stay in step with it, and
 * both fail SILENTLY if they don't:
 *  - `attention-service.ts` protects a source's alerts from auto-resolution when
 *    that source throws. A prefix missing here means a fetch error quietly
 *    resolves a real problem instead of holding it.
 *  - the "derivation failed entirely" path protects everything by prefix.
 * A hardcoded fourth copy of this list is exactly how the old literal got
 * orphaned when the bridge was renamed.
 */
export const LIVENESS_DOMAIN_PREFIXES: readonly string[] = [
    'tasks:',
    'library:',
    'storage:',
    'transcoding:',
    'settings:jellyfin-unpaired-watch-records',
];

const INVARIANT_DOMAIN: Record<string, string> = {
    'duplicate-artist-groups': 'library',
    'duplicate-external-ids': 'library',
    'metadata-storage-writability': 'storage',
    'transcode-failures-24h': 'transcoding',
    'jellyfin-unpaired-watch-records': 'settings',
};

/**
 * The five worker heartbeats (`observability/heartbeat.ts`) — core
 * task-engine liveness, always the `tasks` domain.
 */
const TASK_HEARTBEAT_SUBSYSTEMS = new Set<string>([
    'reconciler',
    'stage-sweep',
    'scheduler',
    'event-dispatcher',
    'pending-write-drain',
]);

/**
 * Domain for a task-liveness reason's `subsystem` — namespaces the bridged id
 * as `${domain}:${subsystem}` instead of a blanket `task-liveness:` prefix.
 * Resource-class leader election (`leader:<class>`) and the five heartbeats
 * are unambiguously task-engine concerns; the 15 health-invariants.ts ids are
 * looked up in `INVARIANT_DOMAIN`, with everything NOT listed there
 * (including a future invariant this map hasn't been updated for yet)
 * defaulting to `tasks` — the liveness axis is overwhelmingly task-shaped,
 * and a wrong `tasks` dot is a far smaller miss than the storage/transcoding
 * bug this function exists to fix.
 */
function domainForLivenessSubsystem(subsystem: string): string {
    if (subsystem.startsWith('leader:') || TASK_HEARTBEAT_SUBSYSTEMS.has(subsystem)) {
        return 'tasks';
    }
    return INVARIANT_DOMAIN[subsystem] ?? 'tasks';
}

function livenessTerm(reason: HealthReason): string | undefined {
    if (reason.code === 'subsystem-dead' || reason.code === 'subsystem-degraded') {
        // subsystem is the heartbeat name (reconciler / stage-sweep / scheduler /
        // event-dispatcher / pending-write-drain) — all glossary keys.
        return reason.subsystem;
    }
    if (reason.code === 'class-no-leader' || reason.code === 'leader-expiring') {
        return 'leader-election';
    }
    return undefined; // invariants have no single glossary term
}

/**
 * Fix 7 (OSS): task IDs that already have a `failed-run-spike:` alert active.
 * Passing this set suppresses the generic `tasks:task-recent-failures`
 * invariant-amber item so the same failure set isn't shown twice. The per-task
 * breakdown in failed-run-spike alerts is the clearer signal.
 */
export function adaptTaskLiveness(reasons: HealthReason[]): DerivedAlert[] {
    return (
        reasons
            // Require a subsystem: it's the per-condition id key, so a falsy one
            // would collapse every such reason into a single `${domain}:` id.
            .filter((r) => LIVENESS_CODES.has(r.code) && Boolean(r.subsystem))
            // Fix 9 (OSS): adaptOutboxDeadLetter is the single owner of the
            // outbox-dead-letter invariant signal. Exclude it here to avoid
            // a dual-signal (invariant amber/red + adapter) for the same root cause.
            .filter((r) => !OUTBOX_DEAD_LETTER_INVARIANT_IDS.has(r.subsystem))
            // NB: we do NOT suppress the aggregate `task-recent-failures` invariant
            // when per-task spike alerts are active. An earlier blanket suppression
            // (Fix 7) HID sub-threshold failures: a task with <10 failures (no spike)
            // went invisible whenever any unrelated task spiked (pass-2 regression).
            // The aggregate item (distinct id `tasks:task-recent-failures`)
            // and the per-task `failed-run-spike:<id>` items are different
            // granularities of the same data, not a duplicate — keep both.
            .map((r) => {
                // Fix 8 (OSS): populate detail from r.detail.remediation for invariant
                // codes so the bell panel shows what's wrong + what to do, and set a
                // glossary term so operators can look up invariant concepts.
                const isInvariant =
                    r.code === 'invariant-red' ||
                    r.code === 'invariant-amber' ||
                    r.code === 'invariant-unknown';
                const remediation =
                    isInvariant && r.detail && typeof r.detail.remediation === 'string'
                        ? r.detail.remediation
                        : undefined;

                const isJellyfinPairing = r.subsystem === 'jellyfin-unpaired-watch-records';
                const unpairedCount =
                    typeof r.detail?.value === 'number' ? r.detail.value : undefined;
                const target = isJellyfinPairing
                    ? '/admin/settings/connections?category=conn-jellyfin'
                    : '/admin/system/health#components';
                return {
                    // Stable per condition (subsystem), so an ack survives. The code lives
                    // in the fingerprint, so an amber→red worsening re-surfaces the item.
                    id: `${domainForLivenessSubsystem(r.subsystem)}:${r.subsystem}`,
                    fingerprint: r.code,
                    type: 'degraded-component' as const,
                    // State the SAME domain the id prefix already encodes.
                    // Without it these resolved through
                    // `domainForType('degraded-component')` = 'system', so a
                    // disk-mount fault carried id `storage:…` and domain
                    // 'system' — the two disagreeing about where it belongs,
                    // which is exactly what migration 16.233.0 renamed the ids
                    // to stop. Only reachable now that reconcile carries a
                    // producer-stated domain at all.
                    domain: domainForLivenessSubsystem(r.subsystem),
                    severity: r.severity === 'error' ? ('critical' as const) : ('warning' as const),
                    title: isJellyfinPairing
                        ? unpairedCount === undefined
                            ? m.admin_jellyfin_not_paired_label()
                            : m.admin_jellyfin_not_paired({ count: unpairedCount })
                        : r.summary,
                    detail: isJellyfinPairing
                        ? m.admin_jellyfin_not_paired_description() +
                          ' ' +
                          m.admin_jellyfin_not_paired_hint()
                        : remediation,
                    sourceRef: target,
                    // Fix 8: use 'health-invariant' glossary key for invariant findings.
                    term: isInvariant ? 'health-invariant' : livenessTerm(r),
                    actions: [
                        {
                            kind: 'investigate' as const,
                            label: isJellyfinPairing
                                ? m.admin_nav_page_settings_connections()
                                : m.admin_attention_action_view_system_health(),
                            href: target,
                        },
                    ],
                };
            })
    );
}

/**
 * Playback-binary availability (ffmpeg / ffprobe) → one warning per unavailable
 * binary. This folds "playback is broken" (no transcode/probe binary on this
 * deployment) INTO the attention spine so the unified verdict reflects it. The
 * fingerprint is stable (`'down'`) so an operator ack survives across cycles —
 * an unavailable binary is binary (present/absent), not a drifting count.
 */
export function adaptLumastraPlayback(checks: {
    ffmpegOk: boolean;
    ffprobeOk: boolean;
    ffmpegDetail?: string;
    ffprobeDetail?: string;
    hwAccelOk?: boolean;
    hwAccelType?: string;
    hwAccelDetail?: string;
}): DerivedAlert[] {
    const out: DerivedAlert[] = [];
    // "Not verified (no absolute path set)" is the soft case: the binary is on a
    // bare-name default (e.g. a non-Docker / `npm run dev` install) and simply
    // wasn't path-configured — that's an INFO nudge, not a `warning` that the
    // playback stack is broken. A genuine "Not found at <abs path>" stays warning.
    const softNotConfigured = (detail?: string): boolean =>
        typeof detail === 'string' && detail.includes('Not verified');
    if (!checks.ffmpegOk) {
        const soft = softNotConfigured(checks.ffmpegDetail);
        out.push({
            id: 'lumastra-playback:ffmpeg',
            fingerprint: 'down',
            type: 'degraded-component',
            severity: soft ? ('info' as const) : ('warning' as const),
            title: soft
                ? m.admin_attention_ffmpeg_soft_title()
                : m.admin_attention_ffmpeg_hard_title(),
            detail: checks.ffmpegDetail,
            sourceRef: '/admin/system/health',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_status(),
                    href: '/admin/system/health',
                },
            ],
        });
    }
    if (!checks.ffprobeOk) {
        const soft = softNotConfigured(checks.ffprobeDetail);
        out.push({
            id: 'lumastra-playback:ffprobe',
            fingerprint: 'down',
            type: 'degraded-component',
            severity: soft ? ('info' as const) : ('warning' as const),
            title: soft
                ? m.admin_attention_ffprobe_soft_title()
                : m.admin_attention_ffprobe_hard_title(),
            detail: checks.ffprobeDetail,
            sourceRef: '/admin/system/health',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_status(),
                    href: '/admin/system/health',
                },
            ],
        });
    }
    // Hardware transcoding (QSV/VAAPI/NVENC) configured but failing to initialise.
    // Warning, not critical: software transcode still works, but the operator
    // expects HW acceleration. Surfaced on the main dashboard via the attention
    // spine so it isn't buried in per-session transcode logs.
    if (checks.hwAccelOk === false) {
        out.push({
            id: 'lumastra-playback:hwaccel',
            fingerprint: 'down',
            type: 'degraded-component',
            severity: 'warning',
            title: m.admin_attention_hwaccel_title({ type: checks.hwAccelType ?? 'GPU' }),
            detail: checks.hwAccelDetail,
            sourceRef: '/admin/system/health',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_status(),
                    href: '/admin/system/health',
                },
            ],
        });
    }
    return out;
}

/** Component-health report (weakly typed) → one item per not-pass component. */
export function adaptComponentHealth(report: Record<string, unknown>): DerivedAlert[] {
    const out: DerivedAlert[] = [];
    const CRITICAL = new Set(['database', 'valkey', 'orchestrator']);
    for (const [key, value] of Object.entries(report)) {
        if (key === 'timestamp' || typeof value !== 'object' || value === null) continue;
        const v = value as Record<string, unknown>;
        // `status` is the canonical health+json vocab (pass|warn|fail).
        if (v.status === 'pass') continue;
        const reason =
            (typeof v.reason === 'string' && v.reason) ||
            (typeof v.error === 'string' && v.error) ||
            undefined;
        out.push({
            id: `degraded-component:${key}`,
            // Fix 1 (OSS): use a constant 'down' fingerprint — not the raw error
            // message — so a transient/variable error string can't evict the
            // operator's ack every derive cycle. Mirrors adaptLumastraPlayback.
            fingerprint: 'down',
            type: 'degraded-component',
            severity: CRITICAL.has(key) ? 'critical' : 'warning',
            title: m.admin_attention_component_degraded_title({ component: componentLabel(key) }),
            detail: reason,
            sourceRef: '/admin/system/health#components',
            term: 'degraded-component',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_health(),
                    href: '/admin/system/health#components',
                },
            ],
        });
    }
    return out;
}

/** Title for one unreachable/failed dependency finding. */
function dependencyAlertTitle(f: DependencyFinding): string {
    if (f.id === 'config-dir') return m.admin_attention_dep_config_dir_title();
    if (f.id.startsWith('media-path:')) return m.admin_attention_dep_media_path_title();
    return m.admin_attention_dep_unreachable_title({ name: f.name });
}

/**
 * Optional-dependency reachability report → one `warning` alert per unreachable
 * (or non-persisting) dependency. Mirrors adaptLumastraPlayback: constant `'down'`
 * fingerprint so a varying `detail` can't evict an operator's ack; recovery makes
 * the finding disappear, reconcile resolves the alert, and the ack clears itself.
 * `pass` findings (including the `media-paths-ok` aggregate) emit nothing.
 *
 * Warning (not critical): an optional dependency being down degrades the board but
 * must never escalate it to critical — core playback is unaffected.
 */
export function adaptDependencyChecks(findings: DependencyFinding[]): DerivedAlert[] {
    const out: DerivedAlert[] = [];
    for (const f of findings) {
        if (f.status !== 'warn') continue;
        out.push({
            id: `optional-dependency:${f.id}`,
            fingerprint: 'down',
            type: 'degraded-component',
            severity: 'warning',
            title: dependencyAlertTitle(f),
            detail: f.url,
            sourceRef: '/admin/system/health#dependencies',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_system_health(),
                    href: '/admin/system/health#dependencies',
                },
            ],
        });
    }
    return out;
}

/**
 * Steps that are bookkeeping flags, not user-facing setup actions. `onboarding_dismissed`
 * only flips to completed/dismissed when the operator explicitly dismisses the onboarding
 * banner — it is never a "next step to do", so it must not drive the setup nudge (otherwise
 * a fully-configured install shows "Setup N of N — next: onboarding_dismissed").
 */
const NON_ACTIONABLE_ONBOARDING_STEPS = new Set([
    'onboarding_dismissed',
    // OPTIONAL integrations are not setup steps. Counting Discogs made a fresh,
    // fully usable install read "Setup 4 of 5 — next: Discogs config" (Windows
    // e2e 2026-09-27); optional keys are listed by the optional-data-sources
    // card instead (see the catalog below).
    'discogs_config',
    // AI is optional too: an install without an AI provider is fully usable, yet
    // counting it read "Setup 3 of 4 — next: configure AI features" (Linux e2e
    // 2026-09-29). The admin home SetupChecklist still lists it as optional.
    'ai_config',
]);

/** Onboarding incomplete (lifecycle tier) → a single info nudge. */
export function adaptOnboarding(state: OnboardingState): DerivedAlert[] {
    if (state.allDismissed) return [];
    // Only real setup actions count — exclude bookkeeping flags like onboarding_dismissed.
    const actionable = state.steps.filter((s) => !NON_ACTIONABLE_ONBOARDING_STEPS.has(s.step_key));
    const pending = actionable.filter((s) => !s.completed && !s.dismissed);
    if (pending.length === 0) return [];
    const next = pending[0].step_key;
    const completed = actionable.filter((s) => s.completed).length;
    return [
        {
            id: 'setup-incomplete',
            fingerprint: `${pending.length}:${next}`,
            type: 'setup-incomplete',
            severity: 'info',
            title: m.admin_attention_setup_title({
                completed,
                total: actionable.length,
                next: stepLabel(next),
            }),
            sourceRef: '/admin/library/sources',
            term: 'setup-incomplete',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_continue_setup(),
                    href: '/admin/library/sources',
                },
            ],
        },
    ];
}

export function adaptAudiobookshelfUnlinkedUsers(
    count: number,
    names: readonly string[],
): DerivedAlert[] {
    if (count <= 0 || names.length === 0) return [];
    const shown = names.slice(0, 5);
    const more = Math.max(0, count - shown.length);
    const nameList =
        more > 0
            ? `${shown.join(', ')} ${m.admin_abs_unlinked_more({ count: more })}`
            : shown.join(', ');
    return [
        {
            id: 'settings:audiobookshelf-unlinked-users',
            fingerprint: `${count}:${shown.join(',')}`,
            count,
            type: 'degraded-component',
            domain: 'settings',
            severity: 'info',
            title: m.admin_abs_unlinked_users_title({ count, names: nameList }),
            detail: m.admin_abs_unlinked_users_detail(),
            sourceRef: '/admin/users',
            actions: [
                {
                    kind: 'investigate',
                    label: m.admin_abs_unlinked_users_action(),
                    href: '/admin/users',
                },
            ],
        },
    ];
}

/** How many Jellyfin usernames the notice lists before "and N more". */
const JELLYFIN_UNLINKED_NAMES_SHOWN = 5;

/**
 * Jellyfin accounts the watch-sync pull skipped because no Lumastra user has
 * the same name (and no manual mapping). Their watched state cannot sync until
 * they are linked. `names` are admin-visible Jellyfin usernames; the list is
 * capped at JELLYFIN_UNLINKED_NAMES_SHOWN with "and N more" for the rest.
 */
export function adaptJellyfinUnlinkedUsers(
    count: number,
    names: readonly string[],
): DerivedAlert[] {
    // No names with a positive count only happens for a run recorded before the
    // names were stored; wait for the next pull instead of showing "users: ."
    if (count <= 0 || names.length === 0) return [];
    const shown = names.slice(0, JELLYFIN_UNLINKED_NAMES_SHOWN);
    const more = Math.max(0, count - shown.length);
    const nameList =
        more > 0
            ? `${shown.join(', ')} ${m.admin_jellyfin_unlinked_more({ count: more })}`
            : shown.join(', ');
    return [
        {
            id: 'settings:jellyfin-unlinked-users',
            fingerprint: `${count}:${shown.join(',')}`,
            count,
            type: 'degraded-component' as const,
            domain: 'settings',
            severity: 'warning' as const,
            title: m.admin_jellyfin_unlinked_users_title({ count, names: nameList }),
            detail: m.admin_jellyfin_unlinked_users_detail(),
            sourceRef: '/admin/users',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_jellyfin_unlinked_users_action(),
                    href: '/admin/users',
                },
            ],
        },
    ];
}

/**
 * Catalog of OPTIONAL third-party data sources. Each enriches metadata but is
 * NOT required for any feature — a correctly set-up install with none of these
 * keys must stay healthy. Deduped so a key shared by two plugins (Discogs is
 * used by both artist-enrichment and album-enrichment) surfaces ONE item.
 *
 * `envConfigured()` covers keys that also accept an env/config fallback
 * (MDBList), so a key supplied via the environment counts as "configured" even
 * though no plugin_secrets row exists.
 */
export interface OptionalIntegration {
    /** Stable id segment for the alert id (`optional-integration:${key}`). */
    key: string;
    friendlyName: string;
    secretKey: string;
    pluginIds: string[];
    /** True when the key is supplied via env/config rather than plugin_secrets. */
    envConfigured: () => boolean;
    capabilityBlurb: string;
    settingsRef: string;
    /**
     * Marks an integration whose whole capability is music-specific (Last.fm,
     * Discogs). The caller (attention-service's `optional-integration:`
     * source) suppresses these unless the install actually has a music
     * library or music content — a Movies & TV-only install has no use for
     * them, so nagging about them is pure noise. Omitted (undefined) means
     * the integration is relevant regardless of library composition (e.g.
     * MDBList, which enriches movies/TV).
     */
    scope?: 'music';
    /**
     * Optional relevance predicate. When it returns false the nudge is
     * suppressed entirely — for a prerequisite of a feature the operator has
     * explicitly switched off, "you haven't configured X" is not a useful
     * thing to say. Omitted (undefined) means always relevant. Same idea as
     * `scope: 'music'`, generalized to any config predicate.
     *
     * Must be a pure config read: it runs inside the attention derive cycle,
     * and a throw here degrades the whole `optional-integration:` source.
     */
    relevantWhen?: () => boolean;
}

// music-popularity / artist-enrichment / album-enrichment are TASK ids —
// their settings live in Task Detail's Settings tab (`/admin/tasks/<id>`),
// not on a plugin-registry page. This used to point at
// `/admin/operations/extensions?settings=<id>` (that page's own settings
// modal); the admin IA redesign deleted that route without a
// `?settings=` successor (Task Detail has no query-driven deep-link to a
// specific tab yet), so the "Configure" action now lands one click away —
// on the task's own page — instead of on a settings modal directly. Left as
// a follow-up: teach TaskDetail a `?tab=` deep-link and restore the
// one-click behavior.
const TASK_SETTINGS_REF = '/admin/tasks';
// MDBList's key is a host setting in the `metadata` section of Settings →
// Metadata (the provider plugin no longer has settings of its own).
const METADATA_SETTINGS_REF =
    '/admin/settings/providers?section=metadata&highlight=MDBLIST_API_KEY';
// All four embedding keys (OPENAI_API_KEY, VOYAGE_API_KEY, EMBEDDING_BASE_URL,
// EMBEDDING_API_KEY) live in schema section 'foryou', rendered by
// /admin/settings/ai (createSettingsPageServer(['foryou', 'ai-assistant'])) —
// NOT /admin/settings/providers, which loads only section 'metadata'.
const AI_SETTINGS_REF = '/admin/settings/ai';

export const OPTIONAL_INTEGRATIONS: OptionalIntegration[] = [
    {
        key: 'lastfm',
        friendlyName: 'Last.fm',
        secretKey: 'LASTFM_API_KEY',
        pluginIds: ['music-popularity'],
        envConfigured: () => false,
        capabilityBlurb: 'music popularity ranking',
        settingsRef: `${TASK_SETTINGS_REF}/music-popularity`,
        // Last.fm only powers music-popularity — irrelevant without music.
        scope: 'music',
    },
    {
        key: 'discogs',
        friendlyName: 'Discogs',
        secretKey: 'DISCOGS_TOKEN',
        pluginIds: ['artist-enrichment', 'album-enrichment'],
        envConfigured: () => false,
        // Discogs is an ADDITIONAL source — artist/album enrichment already
        // works out of the box via the keyless TheAudioDB, so the nudge must
        // not imply enrichment is disabled without a Discogs token.
        capabilityBlurb:
            'Discogs as an extra artist & album enrichment source (TheAudioDB already covers this by default)',
        settingsRef: `${TASK_SETTINGS_REF}/artist-enrichment`,
        // Discogs only enriches artists/albums — irrelevant without music.
        scope: 'music',
    },
    {
        key: 'mdblist',
        friendlyName: 'MDBList',
        secretKey: 'MDBLIST_API_KEY',
        // No plugin ids: the provider reads only the host key now, so a leftover
        // plugin-secret copy must not count as "configured".
        pluginIds: [],
        // `.trim()` to match the mdblist-sync global-guard's check exactly, so a
        // whitespace-only key isn't "configured" to the bell but "unconfigured"
        // to the drain (or vice-versa).
        envConfigured: () => config.MDBLIST_API_KEY.trim().length > 0,
        capabilityBlurb: 'extra ratings (RT/Metacritic/Trakt) + streaming availability',
        settingsRef: METADATA_SETTINGS_REF,
    },
    {
        key: 'embeddings',
        friendlyName: 'AI embeddings provider',
        secretKey: 'VOYAGE_API_KEY',
        // Not a plugin — no plugin_secrets row can ever satisfy this. The
        // empty array makes the caller's `pluginIds.some(...)` check false, so
        // the entry is decided purely by envConfigured() below.
        pluginIds: [],
        // The same check the embedding stages gate on: with
        // EMBEDDING_BASE_URL set but no EMBEDDING_API_KEY, OPENAI_API_KEY alone
        // does not make the stages run, so the nudge must still show.
        envConfigured: () => hasUsableEmbeddingProvider(),
        capabilityBlurb: 'AI recommendations, RAG chat, and similarity search',
        settingsRef: AI_SETTINGS_REF,
        // Both AI recommendations and the assistant's RAG retrieval (a
        // pgvector query over media_embeddings) consume embeddings, and the
        // two flags are independent — either one being on makes a missing
        // provider relevant.
        relevantWhen: () => config.FEATURE_AI_RECOMMENDATIONS || config.FEATURE_AI_ASSISTANT,
    },
];

/**
 * Catalog → the subset that should actually nudge. Extracted from the
 * `optional-integration:` source in attention-service so the rules are
 * unit-testable without a database.
 *
 * An entry nudges when it is relevant to this install (music scope +
 * `relevantWhen`) AND its key is genuinely absent (neither in plugin_secrets
 * nor in env/config).
 */
export function selectMissingIntegrations(
    catalog: OptionalIntegration[],
    ctx: { presentSecretKeys: Set<string>; hasMusic: boolean },
): OptionalIntegration[] {
    return catalog.filter(
        (oi) =>
            (oi.scope !== 'music' || ctx.hasMusic) &&
            (oi.relevantWhen?.() ?? true) &&
            !oi.pluginIds.some((pid) => ctx.presentSecretKeys.has(`${pid}:${oi.secretKey}`)) &&
            !oi.envConfigured(),
    );
}

/**
 * Missing optional integrations → one calm `info` nudge each. `info` never
 * degrades the verdict (see reconcile), and a constant `'missing'` fingerprint
 * means an operator's ack sticks until the integration is actually configured
 * (at which point the alert resolves on its own, since the catalog filter no
 * longer emits it).
 */
/**
 * `capabilityBlurb`/`friendlyName` on {@link OPTIONAL_INTEGRATIONS} are plain
 * English fallback data (also used as-is by the `test` fixture in
 * adapters.test.ts) — the array is built once at module load, before any
 * request's locale is known, so it cannot call a paraglide message directly.
 * These lookups translate the four SHIPPED entries at render time instead
 * (inside {@link adaptOptionalIntegrations}, which runs per attention-derive
 * cycle and so sees the current request's locale via `m.xxx()`); an unknown
 * key (e.g. the test fixture) falls back to the catalog's own plain string.
 */
const CAPABILITY_BLURB_MESSAGE: Record<string, () => string> = {
    lastfm: m.admin_attention_capability_lastfm,
    discogs: m.admin_attention_capability_discogs,
    mdblist: m.admin_attention_capability_mdblist,
    embeddings: m.admin_attention_capability_embeddings,
};
const FRIENDLY_NAME_MESSAGE: Record<string, () => string> = {
    // Last.fm/Discogs/MDBList are brand names — never translated.
    embeddings: m.admin_attention_embeddings_provider_name,
};

/**
 * Fix 4 (OSS): extra sentence for MDBList noting that background sync
 * (the "Fetch MDBList Ratings" task) reads `MDBLIST_API_KEY` from the
 * environment, not from plugin_secrets. A key stored only via the UI provider
 * settings will show the nudge as resolved but sync will still silently do
 * nothing until the env var is also set. The nudge detail surfaces this
 * distinction explicitly. Named via the task's OWN friendly name
 * (m.admin_task_name_mdblist_sync), never the raw `mdblist-sync` stage id —
 * `scripts/check-operator-copy.mjs` forbids that id in operator-facing copy.
 */
export function adaptOptionalIntegrations(missing: OptionalIntegration[]): DerivedAlert[] {
    return missing.map((oi) => {
        const capabilityBlurb = CAPABILITY_BLURB_MESSAGE[oi.key]?.() ?? oi.capabilityBlurb;
        const friendlyName = FRIENDLY_NAME_MESSAGE[oi.key]?.() ?? oi.friendlyName;
        const detail =
            oi.key === 'mdblist'
                ? m.admin_attention_optional_integration_detail_mdblist({
                      secretKey: oi.secretKey,
                      capabilityBlurb,
                      taskName: m.admin_task_name_mdblist_sync(),
                  })
                : oi.key === 'embeddings'
                  ? m.admin_attention_optional_integration_detail_embeddings({
                        secretKey: oi.secretKey,
                        capabilityBlurb,
                    })
                  : m.admin_attention_optional_integration_detail_default({
                        secretKey: oi.secretKey,
                        capabilityBlurb,
                    });
        // Deep-link the "Configure" action straight to the owning plugin's
        // settings. Plugin-settings refs read `?settings=<id>` and open that
        // entry's settings; task
        // refs (`/admin/tasks/<id>`, see TASK_SETTINGS_REF above) already
        // bake the task id into the path and don't support that query param,
        // so only append it for the provider case.
        const configureHref =
            oi.pluginIds.length > 0 && !oi.settingsRef.startsWith(TASK_SETTINGS_REF)
                ? `${oi.settingsRef}?settings=${encodeURIComponent(oi.pluginIds[0])}`
                : oi.settingsRef;
        return {
            id: `optional-integration:${oi.key}`,
            fingerprint: 'missing',
            type: 'optional-integration' as const,
            severity: 'info' as const,
            title: m.admin_attention_optional_integration_title({ name: friendlyName }),
            detail,
            sourceRef: oi.settingsRef,
            term: 'optional-integration',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_configure(),
                    href: configureHref,
                },
            ],
        };
    });
}

/** Where a scan's run history (including per-run error counts) is reviewed. */
const ADMIN_LIBRARY_SOURCES_PATH = '/admin/library/sources';

/** The wrapper task a scan-run item's "Run now" action re-triggers. */
const FILE_LIBRARY_SCAN_TASK_ID = 'file-library-scan';

/**
 * Above this many libraries with a scan-run result to report, per-library
 * items collapse into one summary item. An install with a dozen
 * independently scheduled libraries must not flood the attention strip with
 * a dozen near-identical "last scan finished" cards.
 */
export const SCAN_RUN_LIBRARY_CAP = 5;

function scanRunId(libraryPathId: string | null): string {
    return `scan-run:${libraryPathId ?? 'global'}`;
}

/**
 * A completed run whose `errors` carries `ABANDONED_RUN_ERRORS_SENTINEL`
 * never actually finished — `markAbandonedScannerRuns` closed it after a 2h
 * grace window because the scanner process crashed or was killed mid-run.
 * Its total/matched/unmatched counts are not real numbers from a real pass,
 * so reporting them (e.g. "-1 errors") would be actively misleading.
 *
 * This check is defense-in-depth for a row that reaches the COMPLETED-runs
 * source with the sentinel already stamped (e.g. `insertScannerRun`
 * permanently failing after `markAbandonedScannerRuns` ran, leaving the -1
 * row as the last completed row for that library indefinitely). The much
 * more common path — a run still open past the grace window, not yet swept
 * by the next scan's `markAbandonedScannerRuns` call — never has this
 * sentinel at all (its `errors` is still the zero default); that path is
 * detected upstream by `getStaleInFlightScannerRuns` instead, since a row
 * with `completed_at IS NULL` cannot be distinguished from a healthy
 * still-running scan by `errors` alone.
 */
function isAbandonedRun(run: ScannerRunSummary): boolean {
    return run.errors === ABANDONED_RUN_ERRORS_SENTINEL;
}

function abandonedScanRunAlert(run: ScannerRunSummary): DerivedAlert {
    return {
        id: scanRunId(run.library_path_id),
        fingerprint: run.id,
        type: 'degraded-component' as const,
        domain: 'library',
        severity: 'warning' as const,
        title: m.admin_attention_scanrun_abandoned_title(),
        detail: m.admin_attention_scanrun_abandoned_detail(),
        sourceRef: ADMIN_LIBRARY_SOURCES_PATH,
        actions: [
            {
                kind: 'investigate' as const,
                label: m.admin_attention_action_view_scan_history(),
                href: ADMIN_LIBRARY_SOURCES_PATH,
            },
            {
                kind: 'trigger-run' as const,
                label: m.admin_attention_action_run_now(),
                taskId: FILE_LIBRARY_SCAN_TASK_ID,
            },
        ],
    };
}

/**
 * A normal completed run → "what did that scan actually do", stated in terms
 * that match what the writer actually stores.
 *
 * The previous copy asserted the exact opposite of the truth: it said
 * "'Matched' counts files recognised against a provider — it is not a count
 * of new library items", when `file-scanner.ts` writes
 * `matched = result.added + result.updated`. It IS a count of library items
 * this run changed, and nothing about provider recognition. The card now
 * reports `added` and `updated` separately instead of a `matched` total whose
 * name misleads and a percentage of it that measures churn.
 *
 * `unmatched` is no longer printed: it has never been non-zero in any of the
 * 10,229 recorded production runs, so "0 unmatched" was a constant occupying
 * space in every card.
 *
 * Only called for a run with something to act on (`errors > 0` — see the
 * caller); a perfectly clean run produces no item at all, so this never needs
 * to render a "nothing happened" card.
 */
function completedScanRunAlert(run: ScannerRunSummary): DerivedAlert {
    // `completed_at` is guaranteed non-null by the caller's filter.
    const finishedAgo = formatRelativeTime(run.completed_at as Date);
    // `match_rate` is deliberately NOT read here. It is
    // `matched / total_files * 100` over a `matched` that means
    // `added + updated`, so it reports CHURN: a fully-matched library that
    // changed nothing scores 0%. Reporting a percentage of change as a
    // "match rate" is what made every healthy library look broken.
    //
    // Clamped: the subtraction is only meaningful for a run that really
    // completed, and the caller has already diverted abandoned rows.
    const added = Math.max(0, run.matched - run.updated);
    return {
        id: scanRunId(run.library_path_id),
        fingerprint: run.id,
        type: 'degraded-component' as const,
        domain: 'library',
        // Always info, regardless of `errors`: `errors` counts per-file
        // failures, and an operator cancelling their own scan writes
        // 'Scan aborted by user' into it — that must not turn the whole
        // board amber. `warning` is reserved for the abandoned case (a
        // genuine operational failure), never for a run that finished.
        severity: 'info' as const,
        title: m.admin_attention_scanrun_title({ time: finishedAgo }),
        // Raw numbers, not `.toLocaleString()` — that formats using the
        // server process's ICU locale, not the operator's Paraglide locale,
        // so a non-en-US container would silently render "1204" as something
        // other than what an en-US developer's test run saw.
        detail: m.admin_attention_scanrun_detail({
            total: run.total_files,
            added,
            updated: run.updated,
            errors: run.errors,
        }),
        sourceRef: ADMIN_LIBRARY_SOURCES_PATH,
        // Three actions because they land in three different places: files
        // that never became media items (unmatched) cannot show up in the
        // added-since media-browser link, and neither surfaces the run's own
        // error count — that lives on the run-history table itself.
        actions: [
            {
                kind: 'investigate' as const,
                label: m.admin_attention_action_view_recent_items(),
                href: buildScanAddedSinceLink(run.started_at.toISOString()),
            },
            {
                kind: 'investigate' as const,
                label: m.admin_attention_action_fix_matches(),
                href: '/admin/library/fix-matches',
            },
            {
                kind: 'investigate' as const,
                label: m.admin_attention_action_view_scan_history(),
                href: ADMIN_LIBRARY_SOURCES_PATH,
            },
        ],
    };
}

/** One candidate item plus the run id it should be fingerprinted with when collapsed into a summary. */
interface ScanRunCandidate {
    alert: DerivedAlert;
    runId: string;
    abandoned: boolean;
}

/**
 * "What did that scan actually do" (design task 2) — the latest run per
 * library path → one item answering it in the columns' own terms.
 *
 * Takes TWO sources, not one, because "the latest row per library" and
 * "a scan that never finished" are different questions the database cannot
 * answer with a single `DISTINCT ON`:
 *  - `completedRuns` — the latest COMPLETED run per library
 *    (`getLatestCompletedScannerRunPerLibrary`).
 *  - `staleInFlightRuns` — any run still open (`completed_at IS NULL`) past
 *    the same 2h grace window `markAbandonedScannerRuns` uses
 *    (`getStaleInFlightScannerRuns`).
 *
 * A single `DISTINCT ON (library_path_id)` over the whole table (the
 * previous shape of this query) cannot represent "abandoned" at all: a
 * crashed run is only stamped `completed_at`/`errors = -1` at the START of
 * that library's NEXT scan (`markAbandonedScannerRuns` runs immediately
 * before `insertScannerRun` — see `file-scanner.ts`'s `performScan`), so
 * between the crash and that next scan the stale row sits at
 * `completed_at IS NULL` and a naive "discard in-flight rows" filter drops
 * it silently — for the entire gap, which can be arbitrarily long if no one
 * re-triggers a scan for that library. Splitting the query in two lets a
 * stale row surface as "abandoned" as soon as it crosses the 2h line,
 * instead of never.
 *
 * Lifecycle rules:
 *  - A run still in-flight but younger than the grace window produces
 *    nothing — it's simply never selected by either query.
 *  - A stale in-flight run, or a completed run whose `errors` carries
 *    `ABANDONED_RUN_ERRORS_SENTINEL`, produces the distinct abandoned item —
 *    never a "-1 errors" one. When a library has both a stale in-flight row
 *    and an older completed row, the stale one wins (it's the current state
 *    of that library, and only one item can exist per library id).
 *  - A completed, non-abandoned run with nothing to act on
 *    (`errors <= 0`) produces NO item — a clean scan does
 *    not need an "everything is fine" card, and permanently emitting one for
 *    every library after every scan would bump the attention bell forever on
 *    a healthy install (see `summarize()` in `reconcile.ts`: unread count
 *    counts every unacked item regardless of severity).
 *  - More than `SCAN_RUN_LIBRARY_CAP` libraries with something to report
 *    collapse into one summary item, fingerprinted on the sorted set of
 *    collapsed run ids — NOT a member count. A library count never drains
 *    and (for a fixed-size install) never grows on its own, so a
 *    count-based watermark ack (the `dead-letter:`/`stuck-items:` pattern)
 *    would hold forever; a new or superseded run changes the id set and
 *    therefore the fingerprint, re-firing past an old ack.
 *  - Each per-library id's fingerprint is the run's own id, so a new scan on
 *    that library supersedes the previous item instead of stacking another
 *    one alongside it.
 */
export function adaptScanRun(
    completedRuns: ScannerRunSummary[],
    staleInFlightRuns: ScannerRunSummary[],
): DerivedAlert[] {
    const staleByLibrary = new Map<string | null, ScannerRunSummary>();
    for (const run of staleInFlightRuns) {
        staleByLibrary.set(run.library_path_id, run);
    }

    const candidates: ScanRunCandidate[] = [];

    for (const run of staleByLibrary.values()) {
        candidates.push({ alert: abandonedScanRunAlert(run), runId: run.id, abandoned: true });
    }

    for (const run of completedRuns) {
        // The stale in-flight card, if any, already represents this library's
        // current state — a since-superseded completed run must not also
        // emit a second, contradictory item under the same id.
        if (staleByLibrary.has(run.library_path_id)) continue;
        if (isAbandonedRun(run)) {
            candidates.push({ alert: abandonedScanRunAlert(run), runId: run.id, abandoned: true });
            continue;
        }
        // Errors alone. The guard used to read
        // `run.unmatched <= 0 && run.errors <= 0`, and the first clause could
        // never contribute: `unmatched` has not been non-zero in any of the
        // 10,229 recorded production runs, so `unmatched <= 0` was constantly
        // true and the AND was decided entirely by `errors`. Left in place it
        // reads as a live second trigger and invites tests that assert one.
        if (run.errors <= 0) continue;
        candidates.push({ alert: completedScanRunAlert(run), runId: run.id, abandoned: false });
    }

    if (candidates.length === 0) return [];

    if (candidates.length > SCAN_RUN_LIBRARY_CAP) {
        const anyAbandoned = candidates.some((c) => c.abandoned);
        return [
            {
                id: 'scan-run:summary',
                fingerprint: candidates
                    .map((c) => c.runId)
                    .sort()
                    .join('|'),
                type: 'degraded-component' as const,
                domain: 'library',
                severity: anyAbandoned ? ('warning' as const) : ('info' as const),
                title: m.admin_attention_scanrun_summary_title({ count: candidates.length }),
                detail: m.admin_attention_scanrun_summary_detail(),
                sourceRef: ADMIN_LIBRARY_SOURCES_PATH,
                actions: [
                    {
                        kind: 'investigate' as const,
                        label: m.admin_attention_action_view_scan_history(),
                        href: ADMIN_LIBRARY_SOURCES_PATH,
                    },
                ],
            },
        ];
    }

    return candidates.map((c) => c.alert);
}

// ---------------------------------------------------------------------------
// Music hygiene
// ---------------------------------------------------------------------------

/**
 * The title for one finding.
 *
 * An exhaustive `switch`, not a `Record<MusicHygieneFinding, …>` lookup, because
 * the switch is the shape that keeps working if any of this ever moves into a
 * `.svelte` file: a record literal there is exhaustiveness-checked by NOTHING in
 * this repo (tsgo skips `.svelte`, `svelte-check-native` does not flag it), and
 * a renamed key was measured passing `npm run check` with 0 errors over 2025
 * files. Here in `.ts` both forms are checked; the switch is checked everywhere.
 */
function musicHygieneTitle(finding: MusicHygieneFinding, count: number): string {
    const one = count === 1;
    switch (finding) {
        case MUSIC_HYGIENE_TRACK_NO_ARTIST:
            return one
                ? m.admin_attention_music_hygiene_track_no_artist_title_one({ count })
                : m.admin_attention_music_hygiene_track_no_artist_title_other({ count });
        case MUSIC_HYGIENE_ALBUM_NO_ARTIST:
            return one
                ? m.admin_attention_music_hygiene_album_no_artist_title_one({ count })
                : m.admin_attention_music_hygiene_album_no_artist_title_other({ count });
        case MUSIC_HYGIENE_TITLE_FROM_FILENAME:
            return one
                ? m.admin_attention_music_hygiene_title_from_filename_title_one({ count })
                : m.admin_attention_music_hygiene_title_from_filename_title_other({ count });
        case MUSIC_HYGIENE_ARTIST_UNSPLIT:
            return one
                ? m.admin_attention_music_hygiene_artist_unsplit_title_one({ count })
                : m.admin_attention_music_hygiene_artist_unsplit_title_other({ count });
    }
}

/** The detail line for one finding. Exhaustive for the same reason as above. */
function musicHygieneDetail(finding: MusicHygieneFinding): string {
    switch (finding) {
        case MUSIC_HYGIENE_TRACK_NO_ARTIST:
            return m.admin_attention_music_hygiene_track_no_artist_detail();
        case MUSIC_HYGIENE_ALBUM_NO_ARTIST:
            return m.admin_attention_music_hygiene_album_no_artist_detail();
        case MUSIC_HYGIENE_TITLE_FROM_FILENAME:
            return m.admin_attention_music_hygiene_title_from_filename_detail();
        case MUSIC_HYGIENE_ARTIST_UNSPLIT:
            return m.admin_attention_music_hygiene_artist_unsplit_detail();
    }
}

/**
 * Music-hygiene findings → one calm `info` item per NON-ZERO finding.
 *
 * ## Why `info`, never `warning`
 *
 * Nothing here is broken: every affected row plays. A track that no artist page
 * reaches is a browsing inconvenience, and a title taken from its file name is
 * a tagging job. `warning` would set `verdict = 'degraded'` board-wide for as
 * long as any of these went unacked (`summarize()` in `reconcile.ts`), which on
 * a real catalogue is forever — 1,234 of 27,838 tracks matched the filename
 * finding on the reference library when it was introduced, and that number
 * only moves when someone re-tags files. A permanently amber board for tagging tidiness teaches an
 * operator to ignore the strip, which costs them the next real critical.
 * `adaptUnmatched` set this precedent: "a doorway to the Fix-matches workbench,
 * never a verdict-degrading alarm".
 *
 * ## Why a zero count emits NOTHING
 *
 * `summarize()` counts every unacked item into `unreadCount` regardless of
 * severity, so an "all clear" card for a finding with zero rows would bump the
 * bell on a healthy install and never drain — the same reasoning that made
 * `adaptScanRun` emit nothing for a clean run. On the reference catalogue three
 * of these four are zero, so "absent" is the COMMON case here, not the edge one.
 *
 * ## Why one item per finding rather than one aggregate
 *
 * They are four different jobs landing on three different type-scoped lists, and
 * ack is per item. An operator who has decided the conjunction heuristic is not
 * worth their time must be able to ack THAT and still be told about parentless
 * tracks; a single aggregate item would mute all four together.
 *
 * ## Links
 *
 * Every href comes from `buildMusicHygieneLink`, never spelled here. An admin
 * media URL that omits `type` resolves to the domain default, so a hand-spelled
 * link silently opens a different list than the count was taken over — this repo
 * has shipped that defect twice. `MUSIC_HYGIENE_VIEW` is the single source of
 * the domain/type pair for both this link and the count's own scope.
 *
 * ## The heuristic
 *
 * `music-artist-unsplit` is a guess and its copy says so, in every locale. The
 * caveat is baked into the translated message rather than composed here, because
 * a caveat appended in code lands outside the sentence and reads wrong in German
 * word order — so `isHeuristicMusicHygieneFinding` cannot gate it and the test
 * asserts the correspondence (`/heuristi/i` iff heuristic) over both locale
 * files instead. What `isHeuristicMusicHygieneFinding` DOES gate is the action
 * label: a heuristic list is something to review, not a set of affected items.
 */
export function adaptMusicHygiene(counts: MusicHygieneCounts): DerivedAlert[] {
    return MUSIC_ATTENTION_FINDINGS.flatMap((finding): DerivedAlert[] => {
        const count = counts[finding] ?? 0;
        if (count <= 0) return [];

        const href = buildMusicHygieneLink(finding);
        return [
            {
                id: `music-hygiene:${finding}`,
                // Bucketed, and deliberately WITHOUT a `count` field.
                //
                // `count` is not a display value — `reconcile.ts` treats its
                // presence as "hold the ack against a count WATERMARK", which
                // bypasses the fingerprint entirely (`d.count <=
                // prior.acked_count`). That semantic was designed for DRAINABLE
                // populations: dead-letter rows and stuck items go away, so a
                // watermark ack that drops when the population grows past the
                // acked level is exactly right for them.
                //
                // A tagging backlog does not drain. An operator who acks "1,234
                // track titles match their file name" is saying "I have accepted
                // this backlog", and under a watermark that ack would be dropped
                // and the item re-surfaced the next time a scan imported ONE
                // untagged track — forever. Omitting `count` falls back to
                // fingerprint-equality ack, and at 1,234 the bucket is
                // '1001-10000', so the ack survives ordinary drift and re-fires
                // only on a material change of scale. That is the semantic the
                // operator meant.
                //
                // `reconcile.test.ts` pins this at the seam — both the omission
                // and the behaviour it buys — rather than leaving it as a
                // property of this comment.
                fingerprint: countBucket(count),
                // `type` is the deprecated wire enum and cannot grow a member
                // without a migration; `domain` is the field consumers read.
                // `integrity` is the nearest existing member and already maps to
                // the `library` domain, so the two agree either way.
                type: 'integrity' as const,
                domain: 'library',
                severity: 'info' as const,
                title: musicHygieneTitle(finding, count),
                detail: musicHygieneDetail(finding),
                sourceRef: href,
                actions: [
                    {
                        kind: 'investigate' as const,
                        label: isHeuristicMusicHygieneFinding(finding)
                            ? m.admin_attention_action_review_artists()
                            : m.admin_attention_action_view_affected_items(),
                        href,
                    },
                ],
            },
        ];
    });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Stage rows whose decline streak has aged past the alert window.
 *
 * ## A new producer, not a new alert type
 *
 * `type` reuses `'stuck-items'` deliberately. `AttentionTypeSchema` is a closed,
 * DEPRECATED enum kept populated only until the iOS client stops reading it —
 * adding a member would reopen a one-way door (OpenAPI regeneration, Swift
 * codegen) that 16.231.0 was written to close. `domain` carries the truth, and
 * the `decline-loop:` id prefix keeps these distinct from real stuck-items
 * alerts in `attention-section-map.ts` and in ack watermarks.
 *
 * ## Aggregate per stage, never per row
 *
 * `admin_attention_alerts` holds tens of rows by design (16.231.0 locking
 * analysis) and a partial block pushes thousands of rows past the threshold, so
 * this groups by stage and uses `totalByStage` — not the sample length — for
 * both `count` and the `countBucket` fingerprint. Using the sample size would
 * cap the ack watermark at the sample limit regardless of the real population.
 *
 * ## `info` while initializing
 *
 * A rate-capped initial import reaches the floor plus six hours easily, so
 * without the downgrade every large fresh install would raise a warning on a
 * system that is behaving correctly. Same treatment `adaptStuck` gives.
 *
 * Copy says "not progressing", never "looping": a multi-day quota block (this
 * project has burned an mdblist daily quota for a week) legitimately lands here,
 * and telling that operator their library is looping would be a lie.
 */
export function adaptDeclineLoop(
    rows: DeclineLoopRow[],
    totalByStage: Map<string, number>,
    isInitializing: boolean = false,
): DerivedAlert[] {
    return groupByStage(rows).map(([stageId, group]) => {
        const n = totalByStage.get(stageId) ?? group.length;
        const stage = stageLabel(stageId);
        return {
            id: `decline-loop:${stageId}`,
            fingerprint: countBucket(n),
            count: n,
            type: 'stuck-items' as const,
            domain: 'tasks',
            severity: isInitializing ? ('info' as const) : ('warning' as const),
            title: isInitializing
                ? n === 1
                    ? m.admin_attention_decline_loop_init_title_one({ count: n, stage })
                    : m.admin_attention_decline_loop_init_title_other({ count: n, stage })
                : n === 1
                  ? m.admin_attention_decline_loop_title_one({ count: n, stage })
                  : m.admin_attention_decline_loop_title_other({ count: n, stage }),
            detail: firstError(group) ?? m.admin_attention_decline_loop_detail(),
            sourceRef: '/admin/tasks/pipeline',
            term: 'decline-loop',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_pipeline(),
                    href: '/admin/tasks/pipeline',
                },
            ],
        };
    });
}

function groupByStage<T extends { stage_id: string }>(rows: T[]): [string, T[]][] {
    const map = new Map<string, T[]>();
    for (const r of rows) {
        const g = map.get(r.stage_id) ?? [];
        g.push(r);
        map.set(r.stage_id, g);
    }
    return [...map.entries()];
}

// Read last_error defensively — its concrete type may evolve; we only need an optional message string.
function firstError(rows: { last_error: unknown }[]): string | undefined {
    for (const r of rows) {
        const err = r.last_error;
        const msg =
            err && typeof err === 'object' ? (err as { message?: unknown }).message : undefined;
        if (typeof msg === 'string' && msg.length > 0) return msg.slice(0, 140);
    }
    return undefined;
}

/** One incident per source, sharing the viewer classifier but preserving each observation time. */
export function adaptLiveTvAvailability(
    sources: LiveTvSourceSafeRow[],
    availability: LiveTvAvailability,
): DerivedAlert[] {
    const stateLabel = (state: string): string => {
        switch (state) {
            case 'healthy':
                return m.livetv_availability_state_healthy();
            case 'failed':
                return m.livetv_availability_state_failed();
            case 'upstream':
                return m.livetv_availability_state_upstream();
            case 'service':
                return m.livetv_availability_state_service();
            case 'partial':
                return m.livetv_availability_state_partial();
            default:
                return m.livetv_availability_state_unknown();
        }
    };
    const incidents: DerivedAlert[] = availability.sources
        .filter(
            (s) =>
                s.channelFeed.state === 'failed' ||
                s.guideFeed.state === 'failed' ||
                ['upstream', 'partial', 'service'].includes(s.playback),
        )
        .map((s) => ({
            id: `livetv-import:${s.sourceId}`,
            fingerprint: `${s.channelFeed.state}:${s.guideFeed.state}:${s.playback}:${countBucket(s.failedChannelIds.length)}`,
            count: s.failedChannelIds.length,
            type: 'livetv-import' as const,
            severity:
                s.playback === 'upstream' || s.playback === 'service'
                    ? ('critical' as const)
                    : ('warning' as const),
            title: m.admin_attention_livetv_availability_title({
                name: sources.find((r) => r.id === s.sourceId)?.name ?? s.sourceId,
            }),
            detail: m.admin_attention_livetv_availability_detail({
                channelFeed: stateLabel(s.channelFeed.state),
                channelAt: s.channelFeed.observedAt ?? stateLabel('unknown'),
                guideFeed: stateLabel(s.guideFeed.state),
                guideAt: s.guideFeed.observedAt ?? stateLabel('unknown'),
                playback: stateLabel(s.playback),
                playbackAt: s.playbackObservedAt ?? stateLabel('unknown'),
            }),
            sourceRef: '/admin/settings/livetv',
            actions: [
                {
                    kind: 'investigate' as const,
                    label: m.admin_attention_action_view_livetv_sources(),
                    href: '/admin/settings/livetv',
                },
            ],
        }));
    const ids = new Set(incidents.map((i) => i.id));
    // Keep parse-warning information, folded into the same row when an outage exists.
    const warnings = adaptLiveTvImport(sources.filter((s) => s.last_refresh_status === 'success'));
    for (const warning of warnings) {
        const incident = incidents.find((i) => i.id === warning.id);
        if (incident && warning.detail) incident.detail = `${incident.detail} ${warning.detail}`;
    }
    return [...incidents, ...warnings.filter((w) => !ids.has(w.id))];
}

/** Master-key recovery and first-generation backup notices; never accepts key material. */
export function adaptMasterKey(
    undecryptableKeys: string[],
    backup: MasterKeyBackupState | null,
    filePath: string,
): DerivedAlert[] {
    const alerts: DerivedAlert[] = [];
    const docs = 'https://lumastra.org/guides/backup-recovery/';
    const actions = [
        {
            kind: 'investigate' as const,
            label: m.admin_attention_master_key_backup_docs(),
            href: docs,
        },
    ];
    if (undecryptableKeys.length > 0) {
        alerts.push({
            id: 'settings:master-key:undecryptable',
            fingerprint: JSON.stringify([...undecryptableKeys].sort()),
            type: 'degraded-component',
            domain: 'settings',
            severity: 'warning',
            title:
                undecryptableKeys.length === 1
                    ? m.admin_attention_master_key_undecryptable_title_one({
                          names: undecryptableKeys.join(', '),
                      })
                    : m.admin_attention_master_key_undecryptable_title_other({
                          count: undecryptableKeys.length,
                          names: undecryptableKeys.join(', '),
                      }),
            detail: m.admin_attention_master_key_undecryptable_detail({ path: filePath }),
            sourceRef: docs,
            actions,
        });
    }
    if (backup) {
        alerts.push({
            id: 'settings:master-key:generated',
            // Persist the normal attention acknowledgement for this generation.
            // A different key must raise a new backup reminder after a loss.
            fingerprint: backup.fingerprint,
            type: 'degraded-component',
            domain: 'settings',
            severity: backup.hasSealedSecrets ? 'warning' : 'info',
            title: m.admin_attention_master_key_generated_title(),
            detail: m.admin_attention_master_key_generated_detail({ path: filePath }),
            sourceRef: docs,
            actions,
        });
    }
    return alerts;
}

/** Invalid legacy values are actionable even when no OAuth provider is enabled. */
export function adaptPublicBaseUrl(
    rawValue: unknown,
    integrationConfigured: boolean,
): DerivedAlert[] {
    if (normalizePublicBaseUrl(rawValue)) return [];
    const invalid = typeof rawValue === 'string' && rawValue.trim().length > 0;
    if (!invalid && !integrationConfigured) return [];
    const href = '/admin/settings/access?section=network&highlight=PUBLIC_BASE_URL';
    return [
        {
            id: 'settings:public-base-url',
            fingerprint: invalid ? 'invalid' : 'missing',
            type: 'degraded-component',
            domain: 'settings',
            severity: 'warning',
            title: m.admin_public_base_url_attention_title(),
            detail: invalid
                ? m.admin_public_base_url_attention_invalid()
                : m.admin_public_base_url_attention_missing(),
            sourceRef: href,
            actions: [
                { kind: 'investigate', label: m.admin_public_base_url_attention_action(), href },
            ],
        },
    ];
}
