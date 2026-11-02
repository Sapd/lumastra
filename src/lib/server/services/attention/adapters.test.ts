// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    adaptCircuits,
    adaptDeadLetter,
    adaptOutboxDeadLetter,
    adaptStuck,
    adaptComponentHealth,
    adaptOnboarding,
    adaptFailedRunSpikes,
    adaptOverdueSchedules,
    adaptTaskLiveness,
    adaptLumastraPlayback,
    adaptOptionalIntegrations,
    adaptDependencyChecks,
    adaptUnmatched,
    adaptGaveUp,
    adaptFileHealth,
    adaptIntegrity,
    adaptMusicHygiene,
    adaptLiveTvImport,
    adaptRepeatedRecovery,
    adaptClusterKeyMismatch,
    adaptLiveTvProxyCompat,
    adaptScanRun,
    SCAN_RUN_LIBRARY_CAP,
    RECOVERY_AUDIT_ACTIONS,
    OPTIONAL_INTEGRATIONS,
    selectMissingIntegrations,
} from './adapters.js';
import type { HealthReason } from '$lib/schemas/task-system-health.schema.js';
import type { StuckItemRow } from '$lib/server/database/queries/ingest-map.queries.js';
import type { DependencyFinding } from '$lib/server/preflight/dependency-checks.js';
import type { OptionalIntegration } from './adapters.js';
import {
    ADMIN_FILE_HEALTH_PATH,
    ADMIN_MEDIA_FILE_ISSUES_PATH,
    buildMusicHygieneLink,
} from '$lib/shared/admin-media-links.js';
import {
    MUSIC_HYGIENE_ALBUM_NO_ARTIST,
    MUSIC_HYGIENE_ARTIST_UNSPLIT,
    MUSIC_HYGIENE_FINDINGS,
    MUSIC_ATTENTION_FINDINGS,
    MUSIC_HYGIENE_TITLE_FROM_FILENAME,
    MUSIC_HYGIENE_TRACK_NO_ARTIST,
    MUSIC_HYGIENE_VIEW,
    isHeuristicMusicHygieneFinding,
    type MusicHygieneFinding,
} from '$lib/shared/music-hygiene.js';
import type { MusicHygieneCounts } from '$lib/server/database/queries/music-hygiene.queries.js';
import type { DerivedAlert } from './types.js';
import { readFileSync } from 'node:fs';
import * as m from '$lib/paraglide/messages';
import {
    ABANDONED_RUN_ERRORS_SENTINEL,
    type ScannerRunSummary,
} from '$lib/server/database/queries/file-scanner-runs.queries.js';

// ---------------------------------------------------------------------------
// task-names mock — these tests exercise adapter LOGIC (severity, fingerprint,
// suppression, wording templates), not the registry → friendly-name lookup
// (that's covered by task-names.test.ts). Pass task ids through unchanged so
// existing assertions that check for a raw task id in a title/id stay valid
// regardless of whether the (empty, in-test) task registry knows that id.
// ---------------------------------------------------------------------------
vi.mock('./task-names.js', () => ({ taskName: (id: string) => id }));

describe('adaptCircuits', () => {
    it('emits a critical item per open circuit with a reset action', () => {
        const out = adaptCircuits({
            summary: { open: 1, halfOpen: 0, forceEnabled: 0, total: 3 },
            entries: [
                {
                    taskId: 'metadata-sync',
                    state: 'open',
                    consecutiveFailures: 5,
                    openedAt: null,
                    openedReason: 'TMDB 503',
                    nextProbeAt: null,
                    forceEnabled: false,
                    lastErrorMessage: null,
                },
                {
                    taskId: 'x',
                    state: 'closed',
                    consecutiveFailures: 0,
                    openedAt: null,
                    openedReason: null,
                    nextProbeAt: null,
                    forceEnabled: false,
                    lastErrorMessage: null,
                },
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('circuit:metadata-sync');
        expect(out[0].severity).toBe('critical');
        // Fingerprint is state-only (not consecutiveFailures) so an ack survives the
        // failure tally climbing on every probe of a still-open circuit.
        expect(out[0].fingerprint).toBe('open');
        expect(out[0].actions.map((a) => a.kind)).toContain('reset-circuit');
        expect(out[0].term).toBe('circuit-breaker');
    });
});

describe('adaptCircuits — Fix 2 half_open + Fix 3 forceEnabled', () => {
    const entry = (
        over: Partial<
            import('$lib/schemas/task-system-failure-detection.schema').CircuitFleetEntry
        > = {},
    ) => ({
        taskId: 'metadata-sync',
        state: 'open' as const,
        consecutiveFailures: 5,
        openedAt: null,
        openedReason: 'TMDB 503',
        nextProbeAt: null,
        forceEnabled: false,
        lastErrorMessage: null,
        ...over,
    });

    it('Fix 2 — half_open emits severity warning with a stable half-open fingerprint', () => {
        const out = adaptCircuits({
            summary: { open: 0, halfOpen: 1, forceEnabled: 0, total: 1 },
            entries: [entry({ state: 'half_open' })],
        });
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('warning');
        // Stable fingerprint: must not contain the consecutiveFailures count so the ack
        // survives across probes.
        expect(out[0].fingerprint).toBe('half-open');
        expect(out[0].fingerprint).not.toMatch(/\d/);
    });

    it('Fix 3 — forceEnabled circuit emits severity info (not critical)', () => {
        const out = adaptCircuits({
            summary: { open: 0, halfOpen: 0, forceEnabled: 1, total: 1 },
            entries: [entry({ forceEnabled: true, state: 'open' })],
        });
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('info');
        // The title should convey the bypass intent (kept running despite failures).
        expect(out[0].title).toContain('keep running despite recent failures');
    });
});

describe('adaptCircuits — self-healing quota/rate-limit wait downgrade', () => {
    const entry = (
        over: Partial<
            import('$lib/schemas/task-system-failure-detection.schema').CircuitFleetEntry
        > = {},
    ) => ({
        taskId: 'mdblist-sync',
        state: 'open' as const,
        consecutiveFailures: 5,
        openedAt: null,
        openedReason: 'rate_limit',
        nextProbeAt: null,
        forceEnabled: false,
        lastErrorMessage: null,
        ...over,
    });

    it('downgrades an open circuit to warning when the failure message matches the expected pattern', () => {
        const out = adaptCircuits({
            summary: { open: 1, halfOpen: 0, forceEnabled: 0, total: 1 },
            entries: [
                entry({
                    lastErrorMessage:
                        'mdblist-sync: rate limit reached (mdblist.com free-tier quota) — resumes automatically once the quota window resets',
                }),
            ],
        });
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('warning');
        // Distinct fingerprint from a genuine open outage so an ack held against one
        // classification does not silently carry over to the other.
        expect(out[0].fingerprint).toBe('open-expected');
        expect(out[0].title).toContain('mdblist-sync');
        expect(out[0].title).toContain('rate limit');
        expect(out[0].detail).toContain('resumes automatically');
        expect(out[0].detail).toContain('no action needed');
    });

    it('keeps a genuine (non-expected) open-circuit failure at critical', () => {
        const out = adaptCircuits({
            summary: { open: 1, halfOpen: 0, forceEnabled: 0, total: 1 },
            entries: [entry({ lastErrorMessage: 'connection refused' })],
        });
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('critical');
        expect(out[0].fingerprint).toBe('open');
    });
});

describe('adaptDeadLetter', () => {
    const dl = (
        over: Partial<
            import('$lib/server/database/queries/ingest-map.queries.js').DeadLetterRow
        > = {},
    ) => ({
        media_item_id: 'a',
        title: 'A',
        series_title: null,
        season_number: null,
        episode_number: null,
        media_type: 'movie',
        stage_id: 'media-probe',
        attempt: 6,
        last_error: null,
        retryable: null as boolean | null,
        dead_since: new Date(),
        dead_age_sec: 100,
        ...over,
    });

    it('aggregates transient dead-letter rows by stage into one critical item per stage', () => {
        const out = adaptDeadLetter([dl({ media_item_id: 'a' }), dl({ media_item_id: 'b' })]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('dead-letter:media-probe');
        expect(out[0].severity).toBe('critical');
        // Count is bucketed (2 → '2-5') so an ack survives the queue draining/refilling by one.
        expect(out[0].fingerprint).toBe('2-5');
        expect(out[0].count).toBe(2);
        expect(out[0].title).toContain('media analysis');
        expect(out[0].term).toBe('dead-letter');
    });

    it('excludes permanent (non-retryable) rows — those are owned by the gave-up: source', () => {
        const out = adaptDeadLetter([
            dl({ media_item_id: 'a', retryable: true }), // transient → critical
            dl({ media_item_id: 'b', retryable: false, needs_identity_repair: true }), // permanent → adaptGaveUp's job
            dl({ media_item_id: 'c', retryable: false, needs_identity_repair: true }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('dead-letter:media-probe');
        expect(out[0].severity).toBe('critical');
        expect(out[0].count).toBe(1);
    });

    it('emits nothing when every row is permanent', () => {
        const out = adaptDeadLetter([
            dl({ retryable: false, needs_identity_repair: true }),
            dl({ media_item_id: 'b', retryable: false, needs_identity_repair: true }),
        ]);
        expect(out).toEqual([]);
    });

    it('returns nothing for an empty list', () => {
        expect(adaptDeadLetter([])).toEqual([]);
    });
});

describe('adaptOutboxDeadLetter', () => {
    it('aggregates dead-lettered events into one warning with a summed count', () => {
        const out = adaptOutboxDeadLetter([
            { event_name: 'file.probed', cnt: 4, last_error: 'handler timeout' },
            { event_name: 'metadata.changed', cnt: 1, last_error: null },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('outbox-dead-letter:all');
        expect(out[0].type).toBe('dead-letter');
        expect(out[0].severity).toBe('warning');
        expect(out[0].count).toBe(5);
        expect(out[0].fingerprint).toBe('2-5');
        // Most-affected event leads the detail (rows arrive count-desc).
        expect(out[0].title).toContain('5 pipeline events undelivered');
        expect(out[0].detail).toContain('file.probed (4)');
        expect(out[0].detail).toContain('Last error: handler timeout');
        expect(out[0].sourceRef).toBe('/admin/system/health#activity');
    });

    it('uses the singular and the first available sample error', () => {
        const out = adaptOutboxDeadLetter([
            { event_name: 'identity.assigned', cnt: 1, last_error: null },
        ]);
        expect(out[0].title).toContain('1 pipeline event undelivered');
        // No error available on the top row → no "Last error" suffix.
        expect(out[0].detail).toBe('Most affected: identity.assigned (1).');
    });

    it('rides the dedicated outbox-dead-letter: prefix (distinct from ingest-map dead-letter:)', () => {
        const [alert] = adaptOutboxDeadLetter([
            { event_name: 'file.probed', cnt: 2, last_error: null },
        ]);
        expect(alert.id.startsWith('outbox-dead-letter:')).toBe(true);
        expect(alert.id.startsWith('dead-letter:')).toBe(false);
    });

    it('returns nothing when there are no dead-lettered events', () => {
        expect(adaptOutboxDeadLetter([])).toEqual([]);
        // Defensive: a zero-count row also yields nothing.
        expect(adaptOutboxDeadLetter([{ event_name: 'x', cnt: 0, last_error: null }])).toEqual([]);
    });
});

describe('adaptStuck', () => {
    const stuckRow = {
        media_item_id: 'a',
        title: 'A',
        series_title: null,
        season_number: null,
        episode_number: null,
        media_type: 'movie',
        stage_id: 'media-probe',
        status: 'pending',
        attempt: 3,
        reason: 'attempt_threshold',
        last_error: null,
        stuck_since: new Date(),
        stuck_age_sec: 7200,
    } satisfies StuckItemRow;

    it('aggregates stuck rows by stage into one warning item per stage', () => {
        const out = adaptStuck([stuckRow]);
        expect(out[0].id).toBe('stuck-items:media-probe');
        expect(out[0].severity).toBe('warning');
        expect(out[0].fingerprint).toBe('1');
        expect(out[0].title).toContain('media analysis');
        expect(out[0].term).toBe('stuck-wedged');
    });

    it('demotes to info with reassuring title when isInitializing=true', () => {
        const out = adaptStuck([stuckRow], true);
        expect(out[0].id).toBe('stuck-items:media-probe');
        expect(out[0].severity).toBe('info');
        expect(out[0].title).toMatch(/Initial library processing/);
        expect(out[0].title).toContain('1 item');
        // Actions are unchanged — operator can still inspect / release-stuck.
        expect(out[0].actions.map((a) => a.kind)).toContain('release-stuck');
    });

    it('keeps warning when isInitializing=false (default)', () => {
        const out = adaptStuck([stuckRow], false);
        expect(out[0].severity).toBe('warning');
    });
});

describe('adaptFailedRunSpikes', () => {
    it('emits a warning per task above threshold and bucketed fingerprint', () => {
        const out = adaptFailedRunSpikes(
            [
                { task_id: 'mdblist-sync', fail_count: 7 },
                { task_id: 'fribb-anime-sync', fail_count: 3 },
            ],
            new Set(),
        );
        expect(out).toHaveLength(2);
        const mal = out.find((i) => i.id === 'failed-run-spike:mdblist-sync');
        expect(mal?.severity).toBe('warning');
        expect(mal?.fingerprint).toBe('6-20'); // 7 → bucket
        expect(mal?.actions.map((a) => a.kind)).toEqual(['investigate', 'stop', 'pause']);
    });

    it('suppresses a spike for a task whose circuit is already open', () => {
        const out = adaptFailedRunSpikes(
            [{ task_id: 'mdblist-sync', fail_count: 9 }],
            new Set(['mdblist-sync']),
        );
        expect(out).toEqual([]);
    });

    it('demotes to info with reassuring title when isInitializing=true', () => {
        const out = adaptFailedRunSpikes(
            [{ task_id: 'metadata-sync', fail_count: 8 }],
            new Set(),
            true,
        );
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('info');
        expect(out[0].title).toMatch(/Initial processing/);
        expect(out[0].title).toContain('normal during first scan');
        // id and fingerprint are unchanged so ack/snooze mechanics still work.
        expect(out[0].id).toBe('failed-run-spike:metadata-sync');
        expect(out[0].fingerprint).toBe('6-20'); // 8 → bucket
        expect(out[0].actions.map((a) => a.kind)).toEqual(['investigate', 'stop', 'pause']);
    });

    it('keeps warning when isInitializing=false (default)', () => {
        const out = adaptFailedRunSpikes([{ task_id: 'metadata-sync', fail_count: 6 }], new Set());
        expect(out[0].severity).toBe('warning');
    });

    it('does not demote suppressed tasks even when initializing', () => {
        // A task whose circuit is open gets no alert regardless of initializing state.
        const out = adaptFailedRunSpikes(
            [{ task_id: 'metadata-sync', fail_count: 10 }],
            new Set(['metadata-sync']),
            true,
        );
        expect(out).toEqual([]);
    });
});

describe('adaptOverdueSchedules', () => {
    const view = (
        over: Partial<import('$lib/schemas/task-system-health.schema').ScheduleOverdueView> = {},
    ) => ({
        taskId: 'nightly-backup',
        resourceClass: null,
        nextFireAt: '2026-06-05T10:00:00.000Z',
        lastFiredAt: null,
        paused: false,
        overdueByMs: 2 * 60 * 60 * 1000,
        countdownMs: 0,
        overdue: true,
        ...over,
    });

    it('emits a warning per overdue schedule with a trigger-run action', () => {
        const out = adaptOverdueSchedules([view()]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('overdue-schedule:nightly-backup');
        expect(out[0].severity).toBe('warning');
        expect(out[0].fingerprint).toBe('1-24h'); // 2h band
        expect(out[0].actions.map((a) => a.kind)).toContain('trigger-run');
    });

    it('ignores non-overdue views', () => {
        expect(adaptOverdueSchedules([view({ overdue: false })])).toEqual([]);
    });

    it('suppresses an overdue alert for a task that has run recently (event/sweep-driven)', () => {
        // trickplay-style: time-schedule wedged/redundant, but the task is clearly
        // working via other triggers → not actionable, so no alert.
        const out = adaptOverdueSchedules(
            [view({ taskId: 'trickplay-generation' })],
            new Set(['trickplay-generation']),
        );
        expect(out).toEqual([]);
    });

    it('still alerts an overdue task that is NOT in the recently-active set', () => {
        const out = adaptOverdueSchedules(
            [view({ taskId: 'nightly-backup' })],
            new Set(['something-else']),
        );
        expect(out).toHaveLength(1);
    });

    it('Fix 11 — suppresses the overdue alert when the task id is in openCircuitTaskIds', () => {
        // A task with an open circuit already fires a louder critical alert; the overdue
        // schedule warning for the same task is redundant noise and must be suppressed.
        const out = adaptOverdueSchedules(
            [
                view({ taskId: 'metadata-sync' }), // circuit is open → suppress
                view({ taskId: 'nightly-backup' }), // no open circuit → still emits
            ],
            new Set(), // neither is recently-active
            new Set(['metadata-sync']), // metadata-sync circuit is open
        );
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('overdue-schedule:nightly-backup');
    });
});

describe('adaptComponentHealth', () => {
    it('emits a critical item for a not-ok database component', () => {
        const out = adaptComponentHealth({
            timestamp: 't',
            database: { ok: false, reason: 'timeout' },
            valkey: { ok: true },
        });
        const db = out.find((i) => i.id === 'degraded-component:database');
        expect(db?.severity).toBe('critical');
        expect(db?.detail).toContain('timeout');
        expect(db?.title).toBe('Database is degraded');
        expect(db?.term).toBe('degraded-component');
    });

    it('treats webhookOutbox not-ok as warning, ignores ok components', () => {
        const out = adaptComponentHealth({
            timestamp: 't',
            database: { status: 'pass' },
            webhookOutbox: { ok: false, pending: 1, dead: 3 },
        });
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('degraded-component:webhookOutbox');
        expect(out[0].severity).toBe('warning');
    });
});

describe('adaptComponentHealth — Fix 1 stable fingerprint', () => {
    it('Fix 1 — two derive cycles with different error strings for the same component produce the same fingerprint', () => {
        const cycle1 = adaptComponentHealth({
            timestamp: 't1',
            database: { ok: false, reason: 'connection timeout after 5000ms' },
        });
        const cycle2 = adaptComponentHealth({
            timestamp: 't2',
            database: { ok: false, error: 'ECONNREFUSED 127.0.0.1:5432' },
        });
        expect(cycle1).toHaveLength(1);
        expect(cycle2).toHaveLength(1);
        // Fingerprint must be 'down' (constant) regardless of the error message so an
        // operator ack survives across derive cycles with transient/variable error strings.
        expect(cycle1[0].fingerprint).toBe('down');
        expect(cycle2[0].fingerprint).toBe('down');
        expect(cycle1[0].fingerprint).toBe(cycle2[0].fingerprint);
    });
});

describe('adaptOnboarding', () => {
    it('emits one info item when onboarding incomplete and not all dismissed', () => {
        const out = adaptOnboarding({
            steps: [
                {
                    step_key: 'add_provider',
                    completed: false,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
            ],
            allDismissed: false,
            mediaCount: 0,
            hasTmdbIds: false,
        });
        expect(out).toHaveLength(1);
        expect(out[0].type).toBe('setup-incomplete');
        expect(out[0].severity).toBe('info');
    });

    it('emits nothing when all steps complete', () => {
        const out = adaptOnboarding({
            steps: [
                {
                    step_key: 'add_provider',
                    completed: true,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
            ],
            allDismissed: false,
            mediaCount: 10,
            hasTmdbIds: true,
        });
        expect(out).toEqual([]);
    });

    it('does not nudge when only the onboarding_dismissed bookkeeping step is pending', () => {
        // Reproduces preprod: all real setup done, but the onboarding_dismissed flag is
        // still false because the operator never explicitly dismissed the banner.
        const out = adaptOnboarding({
            steps: [
                {
                    step_key: 'library_paths',
                    completed: true,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
                {
                    step_key: 'tmdb_config',
                    completed: true,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
                {
                    step_key: 'library_scan',
                    completed: true,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
                {
                    step_key: 'ai_config',
                    completed: true,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
                {
                    step_key: 'onboarding_dismissed',
                    completed: false,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
            ],
            allDismissed: false,
            mediaCount: 100,
            hasTmdbIds: true,
        });
        expect(out).toEqual([]);
    });

    it('counts only actionable steps when a real step is pending (ignores onboarding_dismissed)', () => {
        const out = adaptOnboarding({
            steps: [
                {
                    step_key: 'library_paths',
                    completed: true,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
                {
                    step_key: 'tmdb_config',
                    completed: false,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
                {
                    step_key: 'onboarding_dismissed',
                    completed: false,
                    dismissed: false,
                    dismissed_by: null,
                    dismissed_at: null,
                    completed_at: null,
                },
            ],
            allDismissed: false,
            mediaCount: 0,
            hasTmdbIds: false,
        });
        expect(out).toHaveLength(1);
        // 1 of 2 actionable steps done; next is the real pending step, never onboarding_dismissed.
        // The raw step key is humanized for non-developer self-hosters.
        expect(out[0].title).toBe('Setup 1 of 2 — next: connect TMDB metadata');
        expect(out[0].term).toBe('setup-incomplete');
    });

    it('never counts or suggests optional AI config as a setup step', () => {
        const step = (step_key: string, completed: boolean) => ({
            step_key,
            completed,
            dismissed: false,
            dismissed_by: null,
            dismissed_at: null,
            completed_at: null,
        });
        // The Linux e2e case: everything required done, AI not configured.
        expect(
            adaptOnboarding({
                steps: [
                    step('library_paths', true),
                    step('tmdb_config', true),
                    step('library_scan', true),
                    step('ai_config', false),
                    step('onboarding_dismissed', false),
                ],
                allDismissed: false,
                mediaCount: 100,
                hasTmdbIds: true,
            }),
        ).toEqual([]);
        // A real pending step is counted WITHOUT the AI step in the total.
        const out = adaptOnboarding({
            steps: [
                step('library_paths', true),
                step('tmdb_config', false),
                step('library_scan', true),
                step('ai_config', false),
            ],
            allDismissed: false,
            mediaCount: 0,
            hasTmdbIds: false,
        });
        expect(out).toHaveLength(1);
        expect(out[0].title).toBe('Setup 2 of 3 — next: connect TMDB metadata');
    });

    it('never counts or suggests an optional integration (Discogs) as a setup step', () => {
        const step = (step_key: string, completed: boolean) => ({
            step_key,
            completed,
            dismissed: false,
            dismissed_by: null,
            dismissed_at: null,
            completed_at: null,
        });
        const out = adaptOnboarding({
            steps: [
                step('library_paths', true),
                step('tmdb_config', true),
                step('library_scan', true),
                step('ai_config', true),
                step('discogs_config', false),
                step('onboarding_dismissed', false),
            ],
            allDismissed: false,
            mediaCount: 100,
            hasTmdbIds: true,
        });
        expect(out).toEqual([]);
    });
});

describe('adaptTaskLiveness', () => {
    const reason = (over: Partial<HealthReason>): HealthReason => ({
        code: 'subsystem-dead',
        severity: 'error',
        subsystem: 'reconciler',
        summary: 'reconciler heartbeat is dead',
        ...over,
    });

    it('maps a dead worker to a critical item with a stable id + the subsystem glossary term', () => {
        const out = adaptTaskLiveness([reason({})]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('tasks:reconciler');
        expect(out[0].severity).toBe('critical');
        // id is stable per subsystem; severity gradation lives in the fingerprint
        // so an amber→red worsening re-surfaces an acked item.
        expect(out[0].fingerprint).toBe('subsystem-dead');
        expect(out[0].term).toBe('reconciler');
        expect(out[0].type).toBe('degraded-component');
    });

    it('maps a missing class leader to the leader-election glossary term', () => {
        const out = adaptTaskLiveness([
            reason({
                code: 'class-no-leader',
                subsystem: 'leader:embedding',
                summary: 'embedding has no leader',
            }),
        ]);
        expect(out[0].term).toBe('leader-election');
        expect(out[0].severity).toBe('critical');
    });

    it('maps an amber invariant to a warning with the health-invariant glossary term', () => {
        const out = adaptTaskLiveness([
            reason({
                code: 'invariant-amber',
                severity: 'warn',
                subsystem: 'orphan-runs',
                summary: 'orphan runs detected',
            }),
        ]);
        expect(out[0].severity).toBe('warning');
        // OSS fix 8: invariant findings now carry a glossary key so the bell
        // surfaces a "what is this?" link instead of a bare amber item.
        expect(out[0].term).toBe('health-invariant');
    });

    it('drops schedule-overdue and inputs-unreadable reasons (already covered elsewhere — no double-count)', () => {
        const out = adaptTaskLiveness([
            reason({
                code: 'schedule-overdue',
                severity: 'warn',
                subsystem: 'schedule:backup',
                summary: 'backup overdue',
            }),
            reason({
                code: 'inputs-unreadable',
                severity: 'error',
                subsystem: 'inputs',
                summary: 'valkey unreadable',
            }),
        ]);
        expect(out).toHaveLength(0);
    });
});

describe('adaptOptionalIntegrations', () => {
    const lastfm = OPTIONAL_INTEGRATIONS.find((o) => o.key === 'lastfm')!;
    const discogs = OPTIONAL_INTEGRATIONS.find((o) => o.key === 'discogs')!;

    it('emits one info DerivedAlert per missing integration with a constant fingerprint', () => {
        const out = adaptOptionalIntegrations([lastfm]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('optional-integration:lastfm');
        expect(out[0].type).toBe('optional-integration');
        expect(out[0].severity).toBe('info');
        // Constant scalar fingerprint → the ack sticks until the key is configured.
        expect(out[0].fingerprint).toBe('missing');
        expect(out[0].title).toBe('Last.fm is not configured (optional)');
        expect(out[0].detail).toContain('LASTFM_API_KEY');
        expect(out[0].detail).toContain('Lumastra works fully without it');
        expect(out[0].term).toBe('optional-integration');
        expect(out[0].sourceRef).toBe('/admin/tasks/music-popularity');
        expect(out[0].actions.map((a) => a.kind)).toEqual(['investigate']);
        // "Configure" deep-links to the owning task's detail page (task
        // settings, unlike provider settings, have no `?settings=` deep-link
        // into a specific tab yet — see TASK_SETTINGS_REF in adapters.ts).
        expect(out[0].actions[0].href).toBe('/admin/tasks/music-popularity');
        // info alerts are scalar — no count watermark.
        expect(out[0].count).toBeUndefined();
    });

    it('maps each missing integration to its own stable id', () => {
        const out = adaptOptionalIntegrations([lastfm, discogs]);
        expect(out.map((o) => o.id)).toEqual([
            'optional-integration:lastfm',
            'optional-integration:discogs',
        ]);
    });

    it('returns nothing when none are missing', () => {
        expect(adaptOptionalIntegrations([])).toEqual([]);
    });

    it('catalog dedupes the Discogs-shared plugins into one entry covering both', () => {
        expect(discogs.pluginIds).toEqual(['artist-enrichment', 'album-enrichment']);
        // Exactly one Discogs entry despite two plugins sharing DISCOGS_TOKEN.
        expect(OPTIONAL_INTEGRATIONS.filter((o) => o.secretKey === 'DISCOGS_TOKEN')).toHaveLength(
            1,
        );
    });

    it('marks Last.fm and Discogs as music-scoped, and MDBList as unscoped', () => {
        // Music-only providers must be gated on install music content by the
        // caller (attention-service's `optional-integration:` source) — see
        // finding: "MUSIC-PROVIDER NOTIFICATION NOISE". MDBList enriches
        // movies/TV and must stay ungated regardless of music content.
        expect(lastfm.scope).toBe('music');
        expect(discogs.scope).toBe('music');
        const mdblist = OPTIONAL_INTEGRATIONS.find((o) => o.key === 'mdblist')!;
        expect(mdblist.scope).toBeUndefined();
    });

    it('emits an embeddings nudge pointing at the AI settings page', () => {
        const embeddings = OPTIONAL_INTEGRATIONS.find((o) => o.key === 'embeddings')!;
        const out = adaptOptionalIntegrations([embeddings]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('optional-integration:embeddings');
        expect(out[0].severity).toBe('info');
        // Constant fingerprint → an operator ack sticks until a key is added.
        expect(out[0].fingerprint).toBe('missing');
        expect(out[0].title).toBe('AI embeddings provider is not configured (optional)');
        expect(out[0].detail).toContain('VOYAGE_API_KEY');
        expect(out[0].detail).toContain('AI recommendations, RAG chat, and similarity search');
        // All four embedding keys live in schema section 'foryou', rendered by
        // /admin/settings/ai — NOT /admin/settings/providers (section
        // 'services' only), which has no embedding key field.
        expect(out[0].sourceRef).toBe('/admin/settings/ai');
        // No pluginIds → no `?settings=` suffix; the bare AI settings page.
        expect(out[0].actions[0].href).toBe('/admin/settings/ai');
    });

    it('embeddings detail names the OPENAI_API_KEY / EMBEDDING_BASE_URL alternatives', () => {
        const embeddings = OPTIONAL_INTEGRATIONS.find((o) => o.key === 'embeddings')!;
        const out = adaptOptionalIntegrations([embeddings]);
        expect(out[0].detail).toContain('OPENAI_API_KEY');
        expect(out[0].detail).toContain('EMBEDDING_BASE_URL');
        expect(out[0].detail).toContain('EMBEDDING_API_KEY');
    });
});

describe('selectMissingIntegrations', () => {
    const NONE_PRESENT = { presentSecretKeys: new Set<string>(), hasMusic: true };

    function catalogEntry(over: Partial<OptionalIntegration> = {}): OptionalIntegration {
        return {
            key: 'test',
            friendlyName: 'Test',
            secretKey: 'TEST_KEY',
            pluginIds: [],
            envConfigured: () => false,
            capabilityBlurb: 'testing',
            settingsRef: '/admin/settings/providers',
            ...over,
        };
    }

    it('keeps an entry whose key is absent everywhere', () => {
        const e = catalogEntry();
        expect(selectMissingIntegrations([e], NONE_PRESENT)).toEqual([e]);
    });

    it('drops an entry configured via env/config', () => {
        const e = catalogEntry({ envConfigured: () => true });
        expect(selectMissingIntegrations([e], NONE_PRESENT)).toEqual([]);
    });

    it('drops an entry whose key is present in plugin_secrets', () => {
        const e = catalogEntry({ pluginIds: ['some-plugin'] });
        expect(
            selectMissingIntegrations([e], {
                presentSecretKeys: new Set(['some-plugin:TEST_KEY']),
                hasMusic: true,
            }),
        ).toEqual([]);
    });

    it('drops a music-scoped entry on an install with no music', () => {
        const e = catalogEntry({ scope: 'music' });
        expect(
            selectMissingIntegrations([e], { presentSecretKeys: new Set(), hasMusic: false }),
        ).toEqual([]);
    });

    it('drops an entry whose relevantWhen is false even though the key is missing', () => {
        const e = catalogEntry({ relevantWhen: () => false });
        expect(selectMissingIntegrations([e], NONE_PRESENT)).toEqual([]);
    });

    it('keeps an entry whose relevantWhen is true', () => {
        const e = catalogEntry({ relevantWhen: () => true });
        expect(selectMissingIntegrations([e], NONE_PRESENT)).toEqual([e]);
    });

    it('treats an absent relevantWhen as relevant — regression guard for the three pre-existing entries', () => {
        for (const key of ['lastfm', 'discogs', 'mdblist']) {
            const entry = OPTIONAL_INTEGRATIONS.find((o) => o.key === key)!;
            expect(entry.relevantWhen).toBeUndefined();
        }
    });
});

describe('OPTIONAL_INTEGRATIONS embeddings entry — relevantWhen (Fix 3)', () => {
    // The embeddings entry's relevantWhen reads config.FEATURE_AI_RECOMMENDATIONS
    // and config.FEATURE_AI_ASSISTANT directly, so exercising both flag
    // combinations means mocking the config module and re-importing adapters.js
    // fresh — vitest doesn't re-evaluate a module's top-level `config.X` reads
    // otherwise.
    afterEach(() => {
        vi.doUnmock('$lib/server/config.js');
        vi.resetModules();
    });

    it('is suppressed when both AI recommendations and the assistant are off', async () => {
        vi.doMock('$lib/server/config.js', () => ({
            config: { FEATURE_AI_RECOMMENDATIONS: false, FEATURE_AI_ASSISTANT: false },
            hasEmbeddingProvider: () => false,
        }));
        vi.resetModules();
        const mod = await import('./adapters.js');
        const embeddings = mod.OPTIONAL_INTEGRATIONS.find((o) => o.key === 'embeddings')!;
        expect(embeddings.relevantWhen?.()).toBe(false);
    });

    it('is still emitted when the assistant is on even though recommendations are off', async () => {
        vi.doMock('$lib/server/config.js', () => ({
            config: { FEATURE_AI_RECOMMENDATIONS: false, FEATURE_AI_ASSISTANT: true },
            hasEmbeddingProvider: () => false,
        }));
        vi.resetModules();
        const mod = await import('./adapters.js');
        const embeddings = mod.OPTIONAL_INTEGRATIONS.find((o) => o.key === 'embeddings')!;
        expect(embeddings.relevantWhen?.()).toBe(true);
    });
});

describe('OPTIONAL_INTEGRATIONS embeddings entry — configured check', () => {
    // The nudge must agree with the embedding stages' own gate: a custom base
    // URL without its own key cannot embed even when OPENAI_API_KEY is set, so
    // the stages park while a looser check would hide the nudge.
    afterEach(() => {
        vi.doUnmock('$lib/server/config.js');
        vi.resetModules();
    });

    async function embeddingsConfigured(keys: Record<string, string>): Promise<boolean> {
        vi.doMock('$lib/server/config.js', () => ({
            config: {
                OPENAI_API_KEY: '',
                VOYAGE_API_KEY: '',
                EMBEDDING_BASE_URL: '',
                EMBEDDING_API_KEY: '',
                ...keys,
            },
        }));
        vi.resetModules();
        const mod = await import('./adapters.js');
        const dep = await import('$lib/server/tasks/builtin/native/embedding-dep.js');
        const embeddings = mod.OPTIONAL_INTEGRATIONS.find((o) => o.key === 'embeddings')!;
        const configured = embeddings.envConfigured();
        expect(configured).toBe(dep.hasUsableEmbeddingProvider());
        return configured;
    }

    it('nudges when a custom base URL has no key of its own, even with OPENAI_API_KEY set', async () => {
        expect(
            await embeddingsConfigured({
                OPENAI_API_KEY: 'sk-x',
                EMBEDDING_BASE_URL: 'http://embed.local/v1',
            }),
        ).toBe(false);
    });

    it('counts a custom base URL with its own key, and a plain OpenAI or Voyage key', async () => {
        expect(
            await embeddingsConfigured({
                EMBEDDING_BASE_URL: 'http://embed.local/v1',
                EMBEDDING_API_KEY: 'k',
            }),
        ).toBe(true);
        expect(await embeddingsConfigured({ OPENAI_API_KEY: 'sk-x' })).toBe(true);
        expect(await embeddingsConfigured({ VOYAGE_API_KEY: 'pa-x' })).toBe(true);
    });
});

describe('adaptLumastraPlayback', () => {
    it('emits one warning when ffmpeg is unavailable with a stable id + detail', () => {
        const out = adaptLumastraPlayback({
            ffmpegOk: false,
            ffprobeOk: true,
            ffmpegDetail: 'Not found or not executable',
        });
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('lumastra-playback:ffmpeg');
        expect(out[0].severity).toBe('warning');
        // Stable fingerprint so an operator ack survives across derive cycles —
        // an unavailable binary is binary (present/absent), not a drifting count.
        expect(out[0].fingerprint).toBe('down');
        expect(out[0].type).toBe('degraded-component');
        expect(out[0].title).toBe('FFmpeg is not available');
        expect(out[0].detail).toBe('Not found or not executable');
        // NOT bare '/admin': NightlyDigest renders ON /admin and links this, so a
        // self-link made "Look at it →" navigate nowhere. See
        // adapters.playback-links.test.ts.
        expect(out[0].sourceRef).toBe('/admin/system/health');
        expect(out[0].term).toBeUndefined();
        expect(out[0].actions.map((a) => a.kind)).toEqual(['investigate']);
    });

    it('warns on a genuinely-missing binary but only INFO-nudges an unconfigured (bare-path) one', () => {
        const out = adaptLumastraPlayback({
            ffmpegOk: false,
            ffprobeOk: false,
            ffmpegDetail: 'Not found or not executable',
            ffprobeDetail: 'Not verified (no absolute path set)',
        });
        expect(out.map((i) => i.id)).toEqual([
            'lumastra-playback:ffmpeg',
            'lumastra-playback:ffprobe',
        ]);
        // genuine breakage → warning
        expect(out[0].severity).toBe('warning');
        expect(out[0].title).toBe('FFmpeg is not available');
        // bare-name default not path-configured (e.g. bare-metal / npm run dev) →
        // a soft INFO nudge, not a "playback is broken" warning.
        expect(out[1].severity).toBe('info');
        expect(out[1].title).toBe('FFprobe path not configured (optional)');
        expect(out[1].detail).toBe('Not verified (no absolute path set)');
    });

    it('emits nothing when both binaries are available', () => {
        expect(adaptLumastraPlayback({ ffmpegOk: true, ffprobeOk: true })).toEqual([]);
    });
});

describe('adaptDependencyChecks', () => {
    it('emits one warning alert per warn finding, linking to system health', () => {
        const findings: DependencyFinding[] = [
            {
                id: 'sonic-embedder',
                name: 'Music embedder',
                status: 'warn',
                url: 'http://sonic-embedder:8000',
            },
        ];
        const out = adaptDependencyChecks(findings);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('optional-dependency:sonic-embedder');
        expect(out[0].severity).toBe('warning');
        expect(out[0].type).toBe('degraded-component');
        expect(out[0].fingerprint).toBe('down');
        expect(out[0].fingerprint).not.toMatch(/\d/); // constant, never encodes a varying value
        expect(out[0].title).toBe('Music embedder is unreachable');
        expect(out[0].detail).toBe('http://sonic-embedder:8000');
        expect(out[0].sourceRef).toBe('/admin/system/health#dependencies');
        expect(out[0].actions.map((a) => a.kind)).toContain('investigate');
        expect(out[0].actions[0].href).toBe('/admin/system/health#dependencies');
    });

    it('ignores pass findings (including the media-paths-ok aggregate)', () => {
        const findings: DependencyFinding[] = [
            { id: 'media-paths-ok', name: 'Media libraries', status: 'pass', count: 6 },
            { id: 'sonarr', name: 'Sonarr', status: 'pass', url: 'http://sonarr:8989' },
        ];
        expect(adaptDependencyChecks(findings)).toEqual([]);
    });

    it('uses purpose-built titles for config-dir and media-path findings, one alert each', () => {
        const findings: DependencyFinding[] = [
            { id: 'config-dir', name: 'Config directory', status: 'warn', url: '/config' },
            {
                id: 'media-path:/data/movies',
                name: '/data/movies',
                status: 'warn',
                url: '/data/movies',
            },
        ];
        const out = adaptDependencyChecks(findings);
        expect(out).toHaveLength(2);
        const byId = Object.fromEntries(out.map((a) => [a.id, a]));
        expect(byId['optional-dependency:config-dir'].title).toBe(
            "Config directory isn't persisting settings",
        );
        expect(byId['optional-dependency:media-path:/data/movies'].title).toBe(
            'Media library path is unreadable',
        );
        expect(byId['optional-dependency:media-path:/data/movies'].detail).toBe('/data/movies');
    });
});

describe('adaptUnmatched', () => {
    it('emits one info nudge with a bucketed fingerprint and fix-matches link', () => {
        const out = adaptUnmatched(7);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('unmatched:all');
        expect(out[0].type).toBe('unmatched-files');
        expect(out[0].severity).toBe('info'); // personal media must never degrade the verdict
        expect(out[0].fingerprint).toBe('6-20');
        expect(out[0].count).toBe(7);
        expect(out[0].sourceRef).toBe('/admin/library/fix-matches');
    });

    it('emits nothing for zero', () => {
        expect(adaptUnmatched(0)).toEqual([]);
    });
});

describe('adaptGaveUp', () => {
    it('emits one aggregate warning linking to the broken-match view', () => {
        const out = adaptGaveUp(3);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('gave-up:all');
        expect(out[0].type).toBe('needs-reidentification');
        expect(out[0].severity).toBe('warning');
        expect(out[0].count).toBe(3);
        expect(out[0].sourceRef).toBe('/admin/library/fix-matches?view=broken');
    });

    it('emits nothing for zero', () => {
        expect(adaptGaveUp(0)).toEqual([]);
    });
});

describe('adaptFileHealth', () => {
    it('emits one aggregate warning linking the file-health surface', () => {
        const out = adaptFileHealth(2);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('file-health:all');
        expect(out[0].type).toBe('file-health');
        expect(out[0].severity).toBe('warning');
        expect(out[0].sourceRef).toBe(ADMIN_FILE_HEALTH_PATH);
    });

    /*
     * This adapter counts FILES; the media browser lists ITEMS. Pointing it at
     * the browser made the badge unreconcilable with the list it opened, and
     * widening the browser's type set does not fix it — three populations
     * diverge, only one of which is about media types:
     *
     *  - an `extra` (trailer/featurette) is excluded from ALL_BROWSABLE_TYPES,
     *    so no `?type=` can list it. Observed on preprod: badge 2, list 0.
     *  - a file linked to no media item at all cannot appear in a list over
     *    `media_items` under ANY filter.
     *  - a multi-episode file is one file and N items, so the browser can
     *    over-count the badge as easily as under-count it.
     *
     * The file-health surface reads the same `media_files` rows the count is
     * taken from, so it agrees by construction.
     */
    it('does not send the operator to a list of media items, on either link', () => {
        const out = adaptFileHealth(2);
        for (const link of [out[0].sourceRef, out[0].actions?.[0]?.href]) {
            expect(link).toBe(ADMIN_FILE_HEALTH_PATH);
            expect(String(link)).not.toContain('/admin/library/media');
            expect(String(link)).not.toContain('filter=file-issues');
        }
    });

    it('emits nothing for zero', () => {
        expect(adaptFileHealth(0)).toEqual([]);
    });
});

describe('adaptIntegrity', () => {
    it('sums per-rule counts and names the most-affected rule', () => {
        const out = adaptIntegrity({ 'episode-orphans': 5, 'missing-file-link': 2 });
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('integrity:all');
        expect(out[0].count).toBe(7);
        expect(out[0].severity).toBe('warning');
        expect(out[0].detail).toContain('Other library checks');
        expect(out[0].detail).toContain('5 findings');
        expect(out[0].detail).not.toContain('episode-orphans');
    });

    it('labels a single aggregate quarantine finding without implying one affected item', () => {
        const [alert] = adaptIntegrity({ 'quarantine-backlog-large': 1 });
        expect(alert.detail).toContain('Unresolved episode sync decisions');
        expect(alert.detail).toContain('1 finding');
        expect(alert.detail).not.toContain('(1)');
        expect(alert.detail).not.toContain('quarantine-backlog-large');
    });

    it('keeps a young quarantine backlog informational and escalates aged findings', () => {
        const counts = { 'quarantine-backlog-large': 1 };
        expect(adaptIntegrity(counts, { 'quarantine-backlog-large': 'low' })[0].severity).toBe(
            'info',
        );
        expect(adaptIntegrity(counts, { 'quarantine-backlog-large': 'medium' })[0].severity).toBe(
            'warning',
        );
        expect(
            adaptIntegrity(
                { ...counts, 'unprobed-files-stale': 1 },
                {
                    'quarantine-backlog-large': 'low',
                    'unprobed-files-stale': 'medium',
                },
            )[0].severity,
        ).toBe('warning');
    });

    it('falls back to the generic explanation for an unknown rule id', () => {
        const out = adaptIntegrity({ 'episode-orphans': 5 });
        expect(out[0].detail).toContain('inconsistencies in the library data itself');
    });

    it('shows the specific plain-language explanation for a known rule id', () => {
        const out = adaptIntegrity({ 'quarantine-backlog-large': 1200 });
        expect(out[0].detail).toContain('Unresolved episode sync decisions');
        expect(out[0].detail).toContain('1200 findings');
        expect(out[0].detail).not.toContain('quarantine-backlog-large');
        expect(out[0].detail).toContain('multiple series');
        expect(out[0].detail).toContain('without a proposal do not count');
        // Must not fall back to the generic (and here inaccurate) sentence.
        expect(out[0].detail).not.toContain('orphaned rows, missing links');
    });

    it('names the most-affected known rule when several rules have findings', () => {
        const out = adaptIntegrity({
            'unprobed-files-stale': 3,
            'quarantine-backlog-large': 1500,
        });
        expect(out[0].detail).toContain('Unresolved episode sync decisions');
        expect(out[0].detail).toContain('1500 findings');
        expect(out[0].detail).toContain('multiple series');
    });

    it('emits nothing when all rules are zero or absent', () => {
        expect(adaptIntegrity({})).toEqual([]);
        expect(adaptIntegrity({ x: 0 })).toEqual([]);
    });

    /*
     * Integrity findings KEEP the media browser, unlike adaptFileHealth.
     * `integrity_violations.media_id` scopes each one to a `media_items` row, so
     * a list of items is the right surface and the count is reconcilable with
     * it. Only the file-level count had to move (see ADMIN_FILE_HEALTH_PATH).
     */
    it('keeps the row-scoped media-browser link', () => {
        const out = adaptIntegrity({ 'episode-orphans': 5 });
        expect(out[0].sourceRef).toBe(ADMIN_MEDIA_FILE_ISSUES_PATH);
        expect(out[0].actions?.[0]?.href).toBe(ADMIN_MEDIA_FILE_ISSUES_PATH);
    });

    // The link must still name its own type scope or it silently drops every
    // affected episode, track and audiobook.
    it('scopes the media-file link to every media type', () => {
        const out = adaptIntegrity({ 'episode-orphans': 5 });
        for (const link of [out[0].sourceRef, out[0].actions?.[0]?.href]) {
            const params = new URLSearchParams(String(link).split('?')[1]);
            expect(params.get('type')).toBe('all');
            expect(params.get('domain')).toBe('everything');
        }
    });

    it('still routes the quarantine backlog to its own triage page', () => {
        const out = adaptIntegrity({ 'quarantine-backlog-large': 1200 });
        expect(out[0].sourceRef).toBe('/admin/library/quarantine');
        expect(out[0].detail).toContain('multiple series');
        expect(out[0].detail).toContain('without a proposal do not count');
        expect(out[0].detail).toContain('older than 14 days span more than 10 series');
        expect(out[0].sourceRef).toBe('/admin/library/quarantine');
    });
});

describe('adaptLiveTvImport', () => {
    const src = (over: Record<string, unknown> = {}) =>
        ({
            id: 'src-1',
            name: 'IPTV',
            source_type: 'm3u',
            max_streams: 1,
            refresh_cron: null,
            last_refresh_at: new Date(),
            last_refresh_status: 'success',
            last_refresh_summary: null,
            created_at: new Date(),
            updated_at: new Date(),
            ...over,
        }) as import('$lib/server/database/queries/livetv-sources.queries.js').LiveTvSourceSafeRow;

    it('emits a warning for a failed refresh with the summary error as detail', () => {
        const out = adaptLiveTvImport([
            src({ last_refresh_status: 'failed', last_refresh_summary: { error: 'HTTP 403' } }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('livetv-import:src-1');
        expect(out[0].severity).toBe('warning');
        expect(out[0].fingerprint).toBe('failed');
        expect(out[0].detail).toBe('HTTP 403');
        expect(out[0].sourceRef).toBe('/admin/settings/livetv');
    });

    it('emits an info item for a successful import with parse warnings', () => {
        const out = adaptLiveTvImport([
            src({ last_refresh_summary: { warnings: ['Line 3: bad tvg-id', 'Line 9: dup'] } }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('info');
        expect(out[0].count).toBe(2);
        expect(out[0].detail).toBe('Line 3: bad tvg-id');
    });

    it('emits nothing for clean sources or sources never refreshed', () => {
        expect(adaptLiveTvImport([src(), src({ id: 's2', last_refresh_status: null })])).toEqual(
            [],
        );
    });

    it('emits nothing when a successful import only has notes (routine guide noise)', () => {
        // Duplicate channel ids, deliberate description truncation and skipped
        // bad-range programmes are informational: they never raise an item.
        const out = adaptLiveTvImport([
            src({
                last_refresh_summary: {
                    warnings: [],
                    notes: [
                        "EPG: 3521 guide channels reuse another channel's ID",
                        'EPG: Truncated 12 long programme descriptions',
                        'EPG: Skipped 7 programmes with a zero-length time range',
                        'EPG: Skipped 3 programmes whose end is before their start',
                    ],
                    skippedZeroDuration: 7,
                    skippedInvertedRange: 3,
                    truncatedDescriptions: 12,
                },
            }),
        ]);
        expect(out).toEqual([]);
    });

    it('counts only warnings when notes sit alongside real warnings', () => {
        const out = adaptLiveTvImport([
            src({
                last_refresh_summary: {
                    warnings: ['EPG: dropped 2 programme(s) sharing a channel and start time'],
                    notes: ["EPG: 3521 guide channels reuse another channel's ID"],
                },
            }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].count).toBe(1);
        expect(out[0].detail).toBe('EPG: dropped 2 programme(s) sharing a channel and start time');
    });
});

describe('adaptRepeatedRecovery', () => {
    it('promotes a repeating recovery action to a warning with the repeat count', () => {
        const out = adaptRepeatedRecovery([
            {
                category: 'reconciler',
                action: 'orphans-reclaimed',
                cnt: 50,
                last_summary: 'Reclaimed 3 stale runs',
            },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('repeated-recovery:reconciler:orphans-reclaimed');
        expect(out[0].type).toBe('repeated-recovery');
        expect(out[0].severity).toBe('warning');
        expect(out[0].count).toBe(50);
        expect(out[0].title).toContain('50 times in 24 h');
        // 🔴 The title must describe what HAPPENED, in words an operator who
        // has never read the task-system source would use. It previously read
        // "the same automatic recovery ('orphaned runs reclaimed') ran ×50 in
        // 24 h — something keeps re-wedging", which names an internal
        // mechanism and gives no idea what to do about it.
        expect(out[0].title).not.toMatch(/wedg|reclaim|orphan/i);
        expect(out[0].title).toContain('Background jobs were interrupted');
        // The raw subsystem summary is kept, but after the explanation.
        expect(out[0].detail).toContain('Reclaimed 3 stale runs');
        expect(out[0].detail).toMatch(/memory|restart/i);
    });

    it('still says something useful for a recovery action it has no copy for', () => {
        const out = adaptRepeatedRecovery([
            { category: 'x', action: 'some-future-recovery', cnt: 7, last_summary: 'did a thing' },
        ]);
        expect(out[0].title).toContain('7 times in 24 h');
        expect(out[0].detail).toBe('did a thing');
    });

    it('buckets the fingerprint so an ack survives minor count drift', () => {
        const a = adaptRepeatedRecovery([
            { category: 'reconciler', action: 'orphans-reclaimed', cnt: 30, last_summary: null },
        ])[0];
        const b = adaptRepeatedRecovery([
            { category: 'reconciler', action: 'orphans-reclaimed', cnt: 40, last_summary: null },
        ])[0];
        expect(a.fingerprint).toBe(b.fingerprint);
    });

    it('emits nothing for an empty result', () => {
        expect(adaptRepeatedRecovery([])).toEqual([]);
    });

    // Bug C regression: 'stage-sweep-capped' must stay in the allowlist (a
    // genuine hitGlobalEnqueueCap tick is a real re-wedging signal), but the
    // routine "one enqueue failed, cap not hit" case — split into its own
    // 'stage-sweep-enqueue-failed' action in stage-sweep.ts — must NOT be
    // watched here, or MDBList-style rate-limited backlogs (which fail one
    // enqueue almost every tick while their own drain is already active)
    // false-promote to "something keeps re-wedging" ~1440×/day.
    it('watches stage-sweep-capped but not the routine enqueue-failed variant', () => {
        expect(RECOVERY_AUDIT_ACTIONS).toContain('stage-sweep-capped');
        expect(RECOVERY_AUDIT_ACTIONS).not.toContain('stage-sweep-enqueue-failed');
    });
});

describe('adaptClusterKeyMismatch', () => {
    const node = (instanceId: string, keyFingerprint: string) => ({ instanceId, keyFingerprint });

    it('stays quiet when every node agrees', () => {
        expect(
            adaptClusterKeyMismatch([node('web-1', 'aaaa1111'), node('web-2', 'aaaa1111')]),
        ).toEqual([]);
    });

    it('stays quiet for a single node', () => {
        expect(adaptClusterKeyMismatch([node('web-1', 'aaaa1111')])).toEqual([]);
    });

    it('stays quiet for an empty cluster', () => {
        expect(adaptClusterKeyMismatch([])).toEqual([]);
    });

    it('raises a critical alert when nodes disagree', () => {
        const [alert] = adaptClusterKeyMismatch([
            node('web-1', 'aaaa1111'),
            node('web-2', 'bbbb2222'),
        ]);

        expect(alert.severity).toBe('critical');
        expect(alert.type).toBe('cluster-key-mismatch');
        expect(alert.detail).toContain('LUMASTRA_MASTER_KEY');
    });

    // A rolling deploy briefly mixes builds; nodes on the older image publish
    // no fingerprint at all. Treating that as disagreement would fire this
    // alert on every single deploy and train operators to ignore it.
    it('ignores nodes that publish no fingerprint', () => {
        expect(adaptClusterKeyMismatch([node('web-1', 'aaaa1111'), node('web-2', '')])).toEqual([]);
    });

    it('does not confuse two unknown nodes for two distinct keys', () => {
        expect(adaptClusterKeyMismatch([node('web-1', ''), node('web-2', '')])).toEqual([]);
    });

    // The ack must survive heartbeat churn (same keys, nodes coming and going)
    // but must NOT survive a genuinely new divergent key appearing.
    it('keeps a stable fingerprint while the set of keys is unchanged', () => {
        const a = adaptClusterKeyMismatch([node('web-1', 'aaaa'), node('web-2', 'bbbb')])[0];
        const b = adaptClusterKeyMismatch([node('web-2', 'bbbb'), node('web-1', 'aaaa')])[0];
        expect(a.fingerprint).toBe(b.fingerprint);
    });

    it('changes fingerprint when a third distinct key joins', () => {
        const a = adaptClusterKeyMismatch([node('web-1', 'aaaa'), node('web-2', 'bbbb')])[0];
        const b = adaptClusterKeyMismatch([
            node('web-1', 'aaaa'),
            node('web-2', 'bbbb'),
            node('web-3', 'cccc'),
        ])[0];
        expect(a.fingerprint).not.toBe(b.fingerprint);
    });

    it('reports how many nodes hold each key', () => {
        const [alert] = adaptClusterKeyMismatch([
            node('web-1', 'aaaa'),
            node('web-2', 'aaaa'),
            node('web-3', 'bbbb'),
        ]);
        expect(alert.detail).toContain('aaaa (2)');
        expect(alert.detail).toContain('bbbb (1)');
    });
});

describe('adaptScanRun', () => {
    // Mirrors the brief's own example numbers (1,204 files / 93% matched /
    // 14 unmatched / 2 errors) so the detail-text assertions double as a
    // check that the formatted copy matches what was actually specified.
    // Numbers are passed RAW into the message (see M9 fix) — no
    // `.toLocaleString()` — so there is no thousands separator to assert.
    const completedRun = (over: Partial<ScannerRunSummary> = {}): ScannerRunSummary => ({
        id: 'run-1',
        library_path_id: 'lib-1',
        started_at: new Date('2026-08-27T10:00:00.000Z'),
        completed_at: new Date('2026-08-27T12:00:00.000Z'),
        total_files: 1204,
        matched: 1120,
        updated: 40,
        unmatched: 14,
        errors: 2,
        match_rate: '93.02',
        error_samples: [],
        created_at: new Date('2026-08-27T10:00:00.000Z'),
        ...over,
    });

    // A row as `getStaleInFlightScannerRuns` returns it: never completed,
    // `errors` still at its zero default (the -1 sentinel is only stamped by
    // `markAbandonedScannerRuns`, which by construction never runs on a row
    // this query would still select — see the adapter's own doc comment).
    const staleRun = (over: Partial<ScannerRunSummary> = {}): ScannerRunSummary => ({
        id: 'run-stale-1',
        library_path_id: 'lib-1',
        started_at: new Date('2026-08-27T05:00:00.000Z'),
        completed_at: null,
        total_files: 0,
        matched: 0,
        updated: 0,
        unmatched: 0,
        errors: 0,
        match_rate: '0.00',
        error_samples: [],
        created_at: new Date('2026-08-27T05:00:00.000Z'),
        ...over,
    });

    it('produces nothing for zero runs from either source', () => {
        expect(adaptScanRun([], [])).toEqual([]);
    });

    // C1 fix. This is the case the previous round's fixture (a pre-stamped
    // `errors: -1` COMPLETED row) never actually exercised: the real
    // lifecycle never presents a `-1` row as the DISTINCT ON winner, because
    // `markAbandonedScannerRuns` and the next `insertScannerRun` run back to
    // back — the crashed row is `completed_at IS NULL` for the entire gap in
    // between. `getStaleInFlightScannerRuns` is what detects it during that
    // gap; this row is exactly its shape.
    //
    // Branch removed: if `staleInFlightRuns` were ignored entirely (e.g. the
    // parameter dropped or the loop deleted), this comes back `[]` instead of
    // one abandoned item.
    it('reports a stale in-flight run (open past the grace window) as abandoned — the real lifecycle path, not a pre-stamped -1 row', () => {
        const out = adaptScanRun([], [staleRun()]);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('scan-run:lib-1');
        expect(out[0].fingerprint).toBe('run-stale-1');
        expect(out[0].severity).toBe('warning');
        expect(out[0].title).not.toContain('-1');
        expect(out[0].detail).not.toContain('-1');
    });

    // Defense-in-depth path: a `-1`-sentinel row that DOES reach the
    // completed-runs source (e.g. `insertScannerRun` permanently failing
    // after the mark, leaving the -1 row as the last completed row for that
    // library indefinitely). Branch removed: deleting the `isAbandonedRun`
    // check inside the completed-runs loop renders this as a normal item and
    // literally prints "-1" in the detail text.
    it('also treats a -1-sentinel row reached via the completed-runs source as abandoned, never as "-1 errors"', () => {
        const out = adaptScanRun(
            [completedRun({ errors: ABANDONED_RUN_ERRORS_SENTINEL, unmatched: 0 })],
            [],
        );
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('warning');
        expect(out[0].title).not.toContain('-1');
        expect(out[0].detail).not.toContain('-1');
    });

    // Branch removed: if the abandoned item's action list only carried the
    // pre-existing `investigate` link, this fails on the second assertion —
    // the copy says "run a new scan" but nothing let the operator do that.
    it('gives the abandoned item a way to actually run a new scan (M8)', () => {
        const out = adaptScanRun([], [staleRun()]);
        expect(out[0].actions).toHaveLength(2);
        expect(out[0].actions[0]).toMatchObject({
            kind: 'investigate',
            href: '/admin/library/sources',
        });
        expect(out[0].actions[1]).toMatchObject({
            kind: 'trigger-run',
            taskId: 'file-library-scan',
        });
    });

    // Branch removed: dropping the `staleByLibrary.has(...)` skip inside the
    // completed-runs loop lets BOTH rows through, producing 2 items that
    // collide on the same id (`scan-run:lib-1`) instead of 1 — and the
    // completed one (not the abandoned one) would be what a naive `.find`
    // over the resulting duplicate-id array saw first.
    it("lets a stale in-flight run take priority over that same library's older completed run", () => {
        const out = adaptScanRun(
            [completedRun({ id: 'old-completed', library_path_id: 'lib-1' })],
            [staleRun({ id: 'run-stale-1', library_path_id: 'lib-1' })],
        );
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('scan-run:lib-1');
        expect(out[0].fingerprint).toBe('run-stale-1');
        expect(out[0].severity).toBe('warning');
    });

    // MY RULING: a clean run must not create a permanent "everything is
    // fine" card — `summarize()` counts every unacked item into the badge
    // regardless of severity, so an `info` card on every library after every
    // scan would bump the bell forever on a healthy install.
    //
    // Branch removed: deleting the `unmatched <= 0 && errors <= 0` guard
    // turns this into a 1-item result instead of `[]`.
    it('produces nothing for a clean completed run (nothing to act on)', () => {
        const out = adaptScanRun([completedRun({ unmatched: 0, errors: 0 })], []);
        expect(out).toEqual([]);
    });

    // Proves the guard is an OR, not an AND — errors alone must still be
    // enough. Branch removed (guard tightened to `unmatched <= 0` only):
    // this would incorrectly also produce nothing.
    it('produces an item when errors alone are nonzero, even with zero unmatched', () => {
        const out = adaptScanRun([completedRun({ unmatched: 0, errors: 1 })], []);
        expect(out).toHaveLength(1);
    });

    // The clause this used to assert was DEAD, not merely redundant:
    // `unmatched` has never been non-zero in any of the 10,229 recorded
    // production runs, so `unmatched > 0` could not fire and the guard was
    // decided entirely by `errors`. The old test passed only because its
    // fixture invented a value the writer does not produce, which made a
    // condition that never ran look load-bearing.
    //
    // Inverted deliberately: restoring `unmatched <= 0 && run.errors <= 0`
    // makes this fixture emit one item again and this assertion fails.
    it('produces nothing for unmatched alone — the second trigger was never real', () => {
        const out = adaptScanRun([completedRun({ unmatched: 1, errors: 0 })], []);
        expect(out).toEqual([]);
    });

    describe('a normal completed run with something to report', () => {
        const out = adaptScanRun([completedRun()], []);

        it('emits exactly one item, fingerprinted on the run id', () => {
            expect(out).toHaveLength(1);
            expect(out[0].id).toBe('scan-run:lib-1');
            expect(out[0].fingerprint).toBe('run-1');
        });

        // I5 fix. Branch removed (severity keyed on `errors > 0` again):
        // this fixture's `errors: 2` would make it `warning` instead of
        // `info`, and a cancelled-scan's `errors` bump (`file-scanner.ts`
        // pushes 'Scan aborted by user' into it) would turn the whole board
        // amber for the operator's own cancel action.
        it('is always info, regardless of a nonzero errors count', () => {
            expect(out[0].severity).toBe('info');
        });

        // I6 fix: exact equality, not `toContain`, so a vacuous substring
        // (e.g. "2" trivially matching inside "1204") cannot hide a real
        // formatting regression.
        // `added` is `matched - updated` = 1120 - 40 = 1080, which is the
        // number the writer actually meant by `matched`. Exact equality, not
        // `toContain`, so a vacuous substring (e.g. "2" trivially matching
        // inside "1204") cannot hide a real formatting regression.
        it('states what the run changed, in the terms the writer actually stores', () => {
            expect(out[0].detail).toBe(
                '1204 files scanned · 1080 added, 40 updated · 2 errors. ' +
                    '"Added" and "updated" count library items this run changed — ' +
                    'a scan that changes nothing is normal.',
            );
        });

        // The percentage is gone on purpose. `match_rate` is
        // `matched / total_files * 100` over a `matched` that means
        // `added + updated`, so it reports churn: this fixture's real 93.02
        // says nothing about matching. Inverted check — reinstating
        // `matchPercent` in the copy puts a "%" back and fails here.
        it('never reports a match percentage, which measured churn', () => {
            expect(out[0].detail).not.toContain('%');
            expect(out[0].detail).not.toContain('93');
        });

        // This assertion used to be the exact opposite: it required the copy
        // to never say "added", enforcing the claim that `matched` counts
        // provider recognitions rather than library items. `file-scanner.ts`
        // writes `matched: result.added + result.updated` — so the old copy,
        // and the test guarding it, both asserted the reverse of the truth.
        // What must never appear now is the provider claim.
        it('does not claim the counts are provider recognitions', () => {
            const copy = `${out[0].title} ${out[0].detail}`.toLowerCase();
            expect(copy).not.toContain('provider');
            expect(copy).not.toContain('recognised');
            expect(copy).toContain('added');
        });

        // Branch removed: deleting any one of the three action entries still
        // satisfies "returns something", so each destination is asserted
        // individually rather than just checking the array length.
        it('carries three actions landing on three different surfaces', () => {
            expect(out[0].actions).toHaveLength(3);

            const addedSince = out[0].actions[0];
            const params = new URLSearchParams(String(addedSince.href).split('?')[1]);
            expect(String(addedSince.href).split('?')[0]).toBe('/admin/library/media');
            expect(params.get('added_since')).toBe(completedRun().started_at.toISOString());
            expect(params.get('sort')).toBe('created_at');
            expect(params.get('order')).toBe('desc');
            expect(params.get('domain')).toBe('everything');
            expect(params.get('type')).toBe('all');

            expect(out[0].actions[1].href).toBe('/admin/library/fix-matches');
            expect(out[0].actions[2].href).toBe('/admin/library/sources');
        });
    });

    // Branch removed: if per-library grouping degenerated to "always emit
    // one item" or de-duped by something other than library_path_id, this
    // count would come back wrong.
    it('emits one item per library under the cap', () => {
        const out = adaptScanRun(
            [
                completedRun({ id: 'run-a', library_path_id: 'lib-a' }),
                completedRun({ id: 'run-b', library_path_id: 'lib-b' }),
                completedRun({ id: 'run-c', library_path_id: 'lib-c' }),
            ],
            [],
        );
        expect(out).toHaveLength(3);
        expect(out.map((a) => a.id).sort()).toEqual([
            'scan-run:lib-a',
            'scan-run:lib-b',
            'scan-run:lib-c',
        ]);
    });

    // Branch removed: deleting `?? 'global'` in `scanRunId` renders
    // `scan-run:null` instead.
    it('groups a null library_path_id (a global scan) under its own "global" id', () => {
        const out = adaptScanRun([completedRun({ id: 'run-global', library_path_id: null })], []);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('scan-run:global');
    });

    // Branch removed: if the cap/collapse logic were deleted entirely, this
    // would come back as SCAN_RUN_LIBRARY_CAP + 1 separate items instead of
    // one summary.
    it('collapses to one summary item once the reportable-library count exceeds the cap', () => {
        const runs = Array.from({ length: SCAN_RUN_LIBRARY_CAP + 1 }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        const out = adaptScanRun(runs, []);
        expect(out).toHaveLength(1);
        expect(out[0].id).toBe('scan-run:summary');
        expect(out[0].severity).toBe('info');
        expect(out[0].actions).toHaveLength(1);
        expect(out[0].actions[0].href).toBe('/admin/library/sources');
    });

    // I4 fix: no `count` field on the summary at all (a library count never
    // drains and can't be the ack watermark). Branch removed (a `count`
    // field reintroduced): this assertion catches it directly.
    it('does not carry a member-count watermark on the summary item', () => {
        const runs = Array.from({ length: SCAN_RUN_LIBRARY_CAP + 1 }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        expect(adaptScanRun(runs, [])[0].count).toBeUndefined();
    });

    // I4 fix, the actual defect: a count-based fingerprint stays IDENTICAL
    // when one run is superseded by another (same length), so an ack would
    // hold forever. Fingerprinting on the sorted run-id set changes the
    // instant the set changes, even though the COUNT does not.
    //
    // Branch removed (fingerprint reverted to something count-derived, e.g.
    // `countBucket(candidates.length)` or a literal `'summary'`): both
    // fingerprints below would be equal, and this test would fail on the
    // `.not.toBe`.
    it('fingerprints the summary on the collapsed run-id set, not on the count, so a superseded run re-fires past an old ack', () => {
        const before = Array.from({ length: SCAN_RUN_LIBRARY_CAP + 1 }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        // Same NUMBER of libraries, but lib-0's run id changed (a new scan
        // superseded it) — the set of run ids differs even though the count
        // does not.
        const after = [
            completedRun({ id: 'run-0-superseded', library_path_id: 'lib-0' }),
            ...before.slice(1),
        ];
        const fpBefore = adaptScanRun(before, [])[0].fingerprint;
        const fpAfter = adaptScanRun(after, [])[0].fingerprint;
        expect(fpBefore).not.toBe(fpAfter);
    });

    // Mirrors adaptClusterKeyMismatch's own stability test: the ack must
    // survive re-derivation of the SAME set (order is not meaningful), so
    // the fingerprint sorts before joining.
    it('keeps a stable summary fingerprint regardless of the input array order', () => {
        const runs = Array.from({ length: SCAN_RUN_LIBRARY_CAP + 1 }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        const fpForward = adaptScanRun(runs, [])[0].fingerprint;
        const fpReversed = adaptScanRun([...runs].reverse(), [])[0].fingerprint;
        expect(fpForward).toBe(fpReversed);
    });

    // I6's third named branch: `anyAbandoned` on the summary. Branch
    // removed (hardcoded to `'info'`): this fails since one of the collapsed
    // candidates is a stale/abandoned run.
    it('escalates the summary to warning when any collapsed item is abandoned', () => {
        const dirtyRuns = Array.from({ length: SCAN_RUN_LIBRARY_CAP }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        const out = adaptScanRun(dirtyRuns, [staleRun({ library_path_id: 'lib-stale' })]);
        expect(out).toHaveLength(1);
        expect(out[0].severity).toBe('warning');
    });

    it('keeps the summary at info when nothing collapsed into it is abandoned', () => {
        const dirtyRuns = Array.from({ length: SCAN_RUN_LIBRARY_CAP + 1 }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        expect(adaptScanRun(dirtyRuns, [])[0].severity).toBe('info');
    });

    // Boundary: below (at) the cap, per-library items must still be emitted
    // individually — guards against an off-by-one on the cap comparison.
    it('does not collapse when the reportable-library count is exactly at the cap', () => {
        const runs = Array.from({ length: SCAN_RUN_LIBRARY_CAP }, (_, i) =>
            completedRun({ id: `run-${i}`, library_path_id: `lib-${i}` }),
        );
        expect(adaptScanRun(runs, [])).toHaveLength(SCAN_RUN_LIBRARY_CAP);
    });
});

/**
 * Music hygiene.
 *
 * Two properties carry most of the weight here and neither is obvious from the
 * adapter's shape:
 *
 *  - On the reference catalogue THREE of the four counts are zero (no parentless
 *    tracks or albums table-wide, and of four `&`-containing artists three are
 *    `no_split`-flagged and the fourth has no files). "Nothing to report" is the
 *    common case, so every assertion about a present finding is paired with the
 *    absence of the other three in the same call — an adapter that emitted a
 *    zero badge would pass a bare "emits an item" test.
 *  - `summarize()` (`reconcile.ts`) counts EVERY unacked item into `unreadCount`
 *    regardless of severity, and any unacked `warning` sets `verdict =
 *    'degraded'` board-wide. Both of those make "info" and "absent when zero"
 *    correctness properties rather than cosmetics.
 */
describe('adaptMusicHygiene', () => {
    function counts(overrides: Partial<MusicHygieneCounts> = {}): MusicHygieneCounts {
        const zero = {} as MusicHygieneCounts;
        for (const finding of MUSIC_ATTENTION_FINDINGS) zero[finding] = 0;
        return { ...zero, ...overrides };
    }

    function all(n: number): MusicHygieneCounts {
        return counts(Object.fromEntries(MUSIC_HYGIENE_FINDINGS.map((f) => [f, n])));
    }

    function itemFor(out: DerivedAlert[], finding: MusicHygieneFinding): DerivedAlert {
        const item = out.find((i) => i.id === `music-hygiene:${finding}`);
        if (!item) throw new Error(`no item emitted for ${finding}`);
        return item;
    }

    /**
     * The message keys the adapter renders each finding's title AND detail from.
     *
     * Spelled out rather than derived so a renamed key is a test change someone
     * has to make deliberately. `emits the exact title and detail its message
     * keys carry` below pins this map to what the adapter ACTUALLY calls, which
     * is what lets the locale-file assertions stand in for the German rendering
     * (paraglide compiles to the base locale in tests, so the emitted strings
     * are only ever `en`).
     *
     * The `detail` half is not decoration. With details asserted only as
     * non-empty, cross-wiring `musicHygieneDetail`'s album case to the track
     * message left the entire suite green — an operator would have read track
     * advice under an album finding with nothing failing.
     */
    const COPY_KEYS: Record<MusicHygieneFinding, { one: string; other: string; detail: string }> = {
        [MUSIC_HYGIENE_TRACK_NO_ARTIST]: {
            one: 'admin_attention_music_hygiene_track_no_artist_title_one',
            other: 'admin_attention_music_hygiene_track_no_artist_title_other',
            detail: 'admin_attention_music_hygiene_track_no_artist_detail',
        },
        [MUSIC_HYGIENE_ALBUM_NO_ARTIST]: {
            one: 'admin_attention_music_hygiene_album_no_artist_title_one',
            other: 'admin_attention_music_hygiene_album_no_artist_title_other',
            detail: 'admin_attention_music_hygiene_album_no_artist_detail',
        },
        [MUSIC_HYGIENE_TITLE_FROM_FILENAME]: {
            one: 'admin_attention_music_hygiene_title_from_filename_title_one',
            other: 'admin_attention_music_hygiene_title_from_filename_title_other',
            detail: 'admin_attention_music_hygiene_title_from_filename_detail',
        },
        [MUSIC_HYGIENE_ARTIST_UNSPLIT]: {
            one: 'admin_attention_music_hygiene_artist_unsplit_title_one',
            other: 'admin_attention_music_hygiene_artist_unsplit_title_other',
            detail: 'admin_attention_music_hygiene_artist_unsplit_detail',
        },
    };

    function readLocale(locale: string): Record<string, string> {
        const url = new URL(`../../../../../messages/${locale}.json`, import.meta.url);
        return JSON.parse(readFileSync(url, 'utf8')) as Record<string, string>;
    }

    /**
     * Revert-check: drop the `if (count <= 0) return []` guard and this fails
     * for every finding (four items instead of one). Paired with "emits one item
     * per non-zero finding" below, which fails for an adapter that returns `[]`
     * unconditionally — neither test alone is discriminating.
     */
    it.each(MUSIC_ATTENTION_FINDINGS)(
        'emits one info item for %s and nothing for the three that are zero',
        (finding) => {
            const out = adaptMusicHygiene(counts({ [finding]: 7 }));

            expect(out).toHaveLength(1);
            expect(out[0].id).toBe(`music-hygiene:${finding}`);
            // No `count`: its presence would switch reconcile to a count
            // watermark ack, which drops an operator's ack the moment a scan
            // adds one row to a backlog that never drains. Pinned end to end in
            // `reconcile.test.ts`.
            expect(out[0].count).toBeUndefined();
            expect(out[0].fingerprint).toBe('6-20');
            expect(out[0].severity).toBe('info');
            expect(out[0].domain).toBe('library');
            expect(out[0].title).not.toBe('');
            expect(out[0].detail).not.toBe('');
        },
    );

    it('never asks for attention for provenance or conjunction-only names', () => {
        expect(
            adaptMusicHygiene(
                counts({
                    [MUSIC_HYGIENE_TITLE_FROM_FILENAME]: 4000,
                    [MUSIC_HYGIENE_ARTIST_UNSPLIT]: 300,
                }),
            ),
        ).toEqual([]);
    });

    /** Zero counts render NOTHING — not a zero badge, not an empty list item. */
    it('emits nothing at all when every count is zero', () => {
        expect(adaptMusicHygiene(counts())).toEqual([]);
    });

    /**
     * What makes the assertion above discriminating: an adapter hard-wired to
     * return `[]` satisfies "emits nothing for zero" perfectly.
     *
     * Revert-check: make `adaptMusicHygiene` return `[]` and this fails while
     * the zero test still passes.
     */
    it('emits one item per finding, in vocabulary order, when all four are non-zero', () => {
        const out = adaptMusicHygiene(all(3));
        expect(out.map((i) => i.id)).toEqual(
            MUSIC_ATTENTION_FINDINGS.map((f) => `music-hygiene:${f}`),
        );
    });

    /**
     * Severity is load-bearing: `warning` would set the board verdict to
     * `degraded` for as long as any of these went unacked, which on a real
     * catalogue is permanently.
     *
     * Revert-check: change any `severity` to `'warning'` and this fails.
     */
    it('never emits a severity that degrades the board verdict', () => {
        const out = adaptMusicHygiene(all(500));
        expect(out).toHaveLength(MUSIC_ATTENTION_FINDINGS.length);
        for (const item of out) {
            expect(item.severity, `${item.id} severity`).toBe('info');
        }
    });

    /**
     * Every deep link must carry an explicit `type`, because the media browser
     * resolves an absent one to the domain default — so an unscoped link opens a
     * DIFFERENT list than the count was taken over, with nothing failing.
     *
     * Revert-check: hand-spell any href as `/admin/library/media?filter=<f>`
     * (dropping domain/type) instead of calling `buildMusicHygieneLink`, and
     * this fails on both the sourceRef and the action.
     */
    it('scopes both links per finding to the same domain/type the count used', () => {
        const out = adaptMusicHygiene(all(2));
        for (const finding of MUSIC_ATTENTION_FINDINGS) {
            const item = itemFor(out, finding);
            const links = [item.sourceRef, item.actions[0]?.href];
            for (const link of links) {
                expect(link, `${finding} link`).toBe(buildMusicHygieneLink(finding));
                const query = String(link).split('?')[1] ?? '';
                const params = new URLSearchParams(query);
                expect(params.get('filter'), `${finding} filter`).toBe(finding);
                expect(params.get('domain'), `${finding} domain`).toBe(
                    MUSIC_HYGIENE_VIEW[finding].domain,
                );
                expect(params.get('type'), `${finding} type`).toBe(
                    MUSIC_HYGIENE_VIEW[finding].type,
                );
            }
        }
    });

    /**
     * Pins `COPY_KEYS` to the keys the adapter actually renders, for BOTH the
     * title and the detail. Without this the locale assertions below could be
     * checking messages nothing displays.
     *
     * Revert-check (cross-wire, not delete): point any case in
     * `musicHygieneTitle` OR `musicHygieneDetail` at another finding's message
     * and this fails; swap the `one`/`other` arms and the singular case fails.
     */
    it('emits the exact title and detail its message keys carry, in both plural arms', () => {
        const en = readLocale('en');
        for (const [count, arm] of [
            [1, 'one'],
            [4, 'other'],
        ] as const) {
            const out = adaptMusicHygiene(all(count));
            for (const finding of MUSIC_ATTENTION_FINDINGS) {
                const item = itemFor(out, finding);

                const titleKey = COPY_KEYS[finding][arm];
                const title = en[titleKey];
                expect(title, `en is missing ${titleKey}`).toBeTypeOf('string');
                expect(item.title, `${finding} ${arm} title`).toBe(
                    title.replace('{count}', String(count)),
                );

                const detailKey = COPY_KEYS[finding].detail;
                const detail = en[detailKey];
                expect(detail, `en is missing ${detailKey}`).toBeTypeOf('string');
                expect(item.detail, `${finding} detail`).toBe(detail);
            }
        }
    });

    /**
     * Cross-wiring is only detectable if the four details are distinguishable in
     * the first place. Two findings sharing one detail string would make the
     * assertion above pass under a swap.
     */
    it('gives every finding its own distinct detail copy', () => {
        const details = adaptMusicHygiene(all(2)).map((i) => i.detail);
        expect(new Set(details).size).toBe(MUSIC_ATTENTION_FINDINGS.length);
    });

    /**
     * The heuristic caveat is baked into the translated copy — it cannot be
     * composed at render time, because a caveat appended in code lands outside
     * the sentence and reads wrong in German word order. So
     * `isHeuristicMusicHygieneFinding` cannot GATE it; assert the correspondence
     * instead, over both locale files rather than only the compiled base locale.
     * A German title that lost "Heuristik" while English kept "heuristic" is the
     * realistic regression and is invisible to every other check in the repo.
     *
     * Revert-check: delete "(Heuristik)" from
     * `admin_attention_music_hygiene_artist_unsplit_title_other` in
     * `messages/de.json` and the `de` case fails while `en` still passes; add
     * "(heuristic)" to a factual finding's title and that locale fails too.
     */
    it.each(['en', 'de'])('caveats exactly the heuristic finding in %s', (locale) => {
        const messages = readLocale(locale);
        for (const finding of MUSIC_ATTENTION_FINDINGS) {
            for (const arm of ['one', 'other'] as const) {
                const key = COPY_KEYS[finding][arm];
                const copy = messages[key];
                expect(copy, `${locale} is missing ${key}`).toBeTypeOf('string');
                expect(/heuristi/i.test(copy), `${locale} ${key}: caveat`).toBe(
                    isHeuristicMusicHygieneFinding(finding),
                );
            }
        }
    });

    /**
     * The operator-facing detail must name every marker the PREDICATE actually
     * uses, derived from the predicate rather than restated.
     *
     * The copy named three — `'&'`, `'feat.'`, `'vs'` — while the SQL matched
     * eight: `+`, `ft.`, `featuring`, ` x ` and ` und ` too. An operator seeing
     * "AC/DC x Bon Scott" flagged had nothing in the copy to map the flag back
     * to, on the one finding in the set that is explicitly a judgement call and
     * therefore leans hardest on its explanation.
     *
     * Reads the markers out of `music-hygiene.queries.ts` so adding a NINTH
     * without updating the copy fails here, in both locales.
     *
     * Revert-check (INVERT, not delete): drop `'+'` from either locale string
     * and that locale fails naming `+`; add a marker to the SQL alternation
     * without touching the copy and BOTH locales fail.
     */
    it.each(['en', 'de'])('names every marker the predicate matches, in %s', (locale) => {
        const source = readFileSync(
            new URL('../../database/queries/music-hygiene.queries.ts', import.meta.url),
            'utf8',
        );

        const words = /~\* '\[\[:space:\]\]\+\(([^)]+)\)\[\[:space:\]\]\+'/.exec(source);
        const chars = /~ '\[\[:space:\]\]\+\[([^\]]+)\]\[\[:space:\]\]\+'/.exec(source);
        expect(words?.[1], 'word-marker alternation not found in the predicate').toBeTypeOf(
            'string',
        );
        expect(chars?.[1], 'character-marker class not found in the predicate').toBeTypeOf(
            'string',
        );

        const markers = [
            // `feat[.]?` → `feat.`; the POSIX bracket is how a literal dot is
            // written inside a tagged template (a bare `\.` is stripped by JS
            // before Postgres ever sees it).
            ...words![1]
                .split('|')
                .map((alt) => alt.replaceAll('[.]?', '.').replaceAll('[.]', '.')),
            ...[...chars![1]],
        ];
        // Guards the extraction itself: a regex that silently matched nothing
        // would make every assertion below vacuous.
        expect(markers).toEqual(['feat.', 'ft.', 'featuring', 'vs.', 'x', 'und', 'and', '&', '+']);

        const copy = readLocale(locale)[COPY_KEYS[MUSIC_HYGIENE_ARTIST_UNSPLIT].detail];
        expect(copy, `${locale} is missing the artist-unsplit detail`).toBeTypeOf('string');
        for (const marker of markers) {
            expect(copy.includes(`'${marker}'`), `${locale} detail never names ${marker}`).toBe(
                true,
            );
        }
    });

    /**
     * The action label is the one place `isHeuristicMusicHygieneFinding` CAN
     * gate: a heuristic list is something to review, not a set of affected
     * items.
     *
     * Asserts the VALUES, not that the heuristic's label merely differs from the
     * rest. A distinctness-only assertion is satisfied with the semantics
     * exactly inverted — swapping the ternary arms so the heuristic reads "View
     * affected items" and the three facts read "Review these artists" left the
     * whole suite green under a test whose name claimed this property.
     *
     * Revert-check (INVERT, do not delete): swap the ternary arms in
     * `adaptMusicHygiene` and this fails on all four findings. Deleting the
     * conditional outright fails it too, but that is the weaker of the two.
     */
    it('labels the heuristic finding as a review and the factual ones as affected items', () => {
        const out = adaptMusicHygiene(all(2));
        for (const finding of MUSIC_ATTENTION_FINDINGS) {
            const expected = isHeuristicMusicHygieneFinding(finding)
                ? m.admin_attention_action_review_artists()
                : m.admin_attention_action_view_affected_items();
            expect(itemFor(out, finding).actions[0]?.label, `${finding} label`).toBe(expected);
        }
        // Belt and braces: the two labels must actually differ, or the
        // assertion above is vacuous.
        expect(m.admin_attention_action_review_artists()).not.toBe(
            m.admin_attention_action_view_affected_items(),
        );
    });
});

describe('adaptLiveTvProxyCompat', () => {
    const app = { protocol: 2, minProtocol: 2, build: 'aaaaaaaaaaaaaaaa' };
    const proxy = (version: string, proxyProtocol?: number, proxyBuild?: string) => ({
        role: 'proxy',
        version,
        proxyProtocol,
        proxyBuild,
    });

    it('stays quiet for a current proxy, a merely changed one, and non-proxy nodes', () => {
        expect(
            adaptLiveTvProxyCompat(
                [
                    { role: 'web', version: 'v2' },
                    proxy('v2', 2, 'aaaaaaaaaaaaaaaa'),
                    proxy('v1', 2, 'bbbbbbbbbbbbbbbb'),
                ],
                app,
                'v2',
            ),
        ).toEqual([]);
    });

    it('raises one critical item for an incompatible proxy, naming the image to use', () => {
        const [alert, ...rest] = adaptLiveTvProxyCompat([proxy('v1', 1)], app, 'v2');
        expect(rest).toEqual([]);
        expect(alert).toMatchObject({
            id: 'livetv-proxy-compat',
            severity: 'critical',
            domain: 'livetv',
            sourceRef: '/admin/system/health?tab=cluster',
        });
        expect(alert.detail).toContain('Update the Live TV proxy image to v2.');
        expect(alert.detail).toContain('v1');
    });

    it('does not alert for a proxy newer than the app (rollback): a cluster-tab notice only', () => {
        expect(adaptLiveTvProxyCompat([proxy('v3', 3)], app, 'v2')).toEqual([]);
    });

    it('re-raises after an ack when the proxy version changes', () => {
        const [first] = adaptLiveTvProxyCompat([proxy('v1', 1)], app, 'v2');
        const [second] = adaptLiveTvProxyCompat([proxy('v1b', 1)], app, 'v2');
        expect(first.fingerprint).not.toBe(second.fingerprint);
    });
});

it('keeps operational stage alerts visible when the detail sample contains no row for the stage', () => {
    const alerts = adaptDeadLetter(
        [],
        new Map([
            ['transient:custom-plugin-codec', 25],
            ['permanent:custom-plugin-identity', 8],
        ]),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].count).toBe(25);
    expect(alerts[0].id).toBe('dead-letter:custom-plugin-codec');
});
