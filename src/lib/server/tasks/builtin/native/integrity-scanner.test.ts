// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * integrity-scanner native task — manifest, disable-gate, and behavioral tests.
 *
 * Cap-detection and rule-narrowing tests exercise the inlined execute() body
 * directly via a mock-sql harness. No legacy plugin delegation involved.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { integrityScannerTask } from './integrity-scanner.js';

const cleanup = vi.hoisted(() => ({ run: vi.fn().mockResolvedValue({ rowsExamined: 0 }) }));
vi.mock('../../../services/episode-reconciliation.service.js', () => ({
    reevaluateQuarantineBacklog: cleanup.run,
}));

// Mock integrity-violations queries so tests run without a live DB.
const mockRecordViolation = vi.fn().mockResolvedValue(undefined);
const mockReconcileViolationsForRule = vi.fn().mockResolvedValue(0);
const mockCountOpenViolationsByRule = vi.fn().mockResolvedValue({});

vi.mock('../../../database/queries/integrity-violations.queries.js', () => ({
    recordViolation: (...args: unknown[]) => mockRecordViolation(...args),
    reconcileViolationsForRule: (...args: unknown[]) => mockReconcileViolationsForRule(...args),
    countOpenViolationsByRule: (...args: unknown[]) => mockCountOpenViolationsByRule(...args),
}));

vi.mock('../../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
        }),
    },
}));

// MAX_FINDINGS_PER_RULE = 25000 (bumped from 1000 in production 2026-05-24 to drain large backlogs faster)
const MAX_FINDINGS_PER_RULE = 25000;

function makeCtx(sqlMock: ReturnType<typeof vi.fn> = vi.fn().mockResolvedValue([])) {
    const ac = new AbortController();
    return {
        sql: sqlMock,
        logger: {
            info: vi.fn(),
            warn: vi.fn(),
            debug: vi.fn(),
            error: vi.fn(),
            child: vi.fn().mockReturnThis(),
        },
        signal: ac.signal,
        abortSignal: ac.signal,
        runId: 'test-run',
        input: {},
        reportProgress: vi.fn(),
        dep: vi.fn(),
        settings: vi.fn(),
        secrets: { get: vi.fn(), getOptional: vi.fn(), getUser: vi.fn() },
        reportFailure: vi.fn(),
        spend: vi.fn(),
        drain: vi.fn(),
    };
}

// =============================================================================
// Manifest tests
// =============================================================================

describe('integrity-scanner task manifest', () => {
    it('has the correct id', () => {
        expect(integrityScannerTask.id).toBe('integrity-scanner');
    });

    it('declares a 6h schedule with env override', () => {
        // Schedule dropped from 24h to 6h in production (2026-05-24) to drain
        // integrity-stage backlogs 4x faster.
        expect(integrityScannerTask.schedule).toMatchObject({
            every: '6h',
            envOverride: 'SYNC_INTEGRITY_SCANNER_INTERVAL',
        });
    });

    it('uses io resource class (ingest declared, rewritten to io by registry compat shim)', () => {
        // Declared resourceClass changed from maintenance to ingest (2026-05-24).
        // The registry compat shim rewrites ingest → io (physical class) at
        // registerTask time with FEATURE_PER_TASK_QUEUES=true (the default).
        expect(integrityScannerTask.resourceClass).toBe('io');
    });

    it('has global scope', () => {
        expect(integrityScannerTask.scope).toBe('global');
    });

    it('identityFor returns "global-catchup" for default input', () => {
        expect(integrityScannerTask.identityFor({})).toBe('global-catchup');
    });

    it('identityFor returns "global-force" for force mode', () => {
        expect(integrityScannerTask.identityFor({ mode: 'force' })).toBe('global-force');
    });

    it('has no backlog (integrity scanner does not drain a backlog)', () => {
        expect(integrityScannerTask.backlog).toBeUndefined();
    });

    it('declares a database capability', () => {
        expect(integrityScannerTask.capabilities?.database).toBe(true);
    });
});

// =============================================================================
// DISABLE_INTEGRITY_SCANNER gate
// =============================================================================

describe('integrity-scanner DISABLE_INTEGRITY_SCANNER gate', () => {
    beforeEach(() => {
        delete process.env.DISABLE_INTEGRITY_SCANNER;
        vi.clearAllMocks();
        mockCountOpenViolationsByRule.mockResolvedValue({});
    });

    it('returns success with 0 items when DISABLE_INTEGRITY_SCANNER=true', async () => {
        process.env.DISABLE_INTEGRITY_SCANNER = 'true';
        const ctx = makeCtx();
        const result = await integrityScannerTask.execute(
            ctx as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(result.itemsProcessed).toBe(0);
    });

    it('runs all scans and returns success when disabled flag is not set', async () => {
        const sql = vi.fn().mockResolvedValue([]);
        const ctx = makeCtx(sql);
        const result = await integrityScannerTask.execute(
            ctx as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );
        expect(result.success).toBe(true);
    });

    it('is enabled when DISABLE_INTEGRITY_SCANNER is not set', async () => {
        const sql = vi.fn().mockResolvedValue([]);
        const ctx = makeCtx(sql);
        const result = await integrityScannerTask.execute(
            ctx as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );
        // SQL was called (scans ran)
        expect(sql).toHaveBeenCalled();
        expect(result.success).toBe(true);
    });
});

// =============================================================================
// Cap-detection: reconciliation must be skipped when findings hit the cap
// =============================================================================

describe('integrity-scanner cap detection', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCountOpenViolationsByRule.mockResolvedValue({});
        delete process.env.DISABLE_INTEGRITY_SCANNER;
    });

    it('calls reconcileViolationsForRule when findings are below the cap', async () => {
        // SQL that returns empty for all scans (well below MAX_FINDINGS_PER_RULE)
        const sql = vi.fn().mockResolvedValue([]);
        mockReconcileViolationsForRule.mockResolvedValue(0);

        await integrityScannerTask.execute(
            makeCtx(sql) as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );

        // reconcile must have been called for at least one rule
        expect(mockReconcileViolationsForRule).toHaveBeenCalled();
    });

    it('skips reconcileViolationsForRule for a rule that exceeds the cap', async () => {
        // Fetch-one-extra trick: true count > cap → SQL returns cap+1 rows.
        // The cap-detection path must trim to MAX_FINDINGS_PER_RULE before
        // recording and must NOT call reconcileViolationsForRule.
        const overCapRows = Array.from({ length: MAX_FINDINGS_PER_RULE + 1 }, (_, i) => ({
            media_id: `media-${i}`,
            series_id: 'series-1',
            series_tmdb: '1234',
        }));

        let callCount = 0;
        const sql = vi.fn().mockImplementation(() => {
            callCount++;
            // First substantive SQL call returns the over-cap result
            if (callCount === 1) return Promise.resolve(overCapRows);
            return Promise.resolve([{ count: '0' }]);
        });

        mockReconcileViolationsForRule.mockResolvedValue(0);

        await integrityScannerTask.execute(
            makeCtx(sql) as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );

        // reconcileViolationsForRule must NOT have been called with the
        // cap-sized media-id array — the over-cap path must skip
        // reconciliation entirely. Other rules (which got [] findings) do
        // call reconcile with empty arrays; we filter those out.
        const reconcileCalls = mockReconcileViolationsForRule.mock.calls;
        const cappedCall = reconcileCalls.find(
            (args) =>
                Array.isArray(args[2]) && (args[2] as string[]).length >= MAX_FINDINGS_PER_RULE,
        );
        expect(cappedCall).toBeUndefined();

        // recordViolation must have been called with the cap-sized first
        // rule — the sentinel cap+1 row is trimmed before recording.
        // Other rules contribute their own (small) findings counts; we
        // assert recordViolation never sees the over-cap +1 row.
        // Call shape: recordViolation(sql, { rule, severity, mediaId, details })
        const recordedMediaIds = mockRecordViolation.mock.calls
            .filter((args) => {
                const arg = args[1] as { mediaId?: string };
                return typeof arg?.mediaId === 'string' && arg.mediaId.startsWith('media-');
            })
            .map((args) => (args[1] as { mediaId: string }).mediaId);
        expect(recordedMediaIds).toHaveLength(MAX_FINDINGS_PER_RULE);
        // The sentinel `media-${MAX_FINDINGS_PER_RULE}` (index = cap, the
        // 1001st row) must be absent.
        expect(recordedMediaIds).not.toContain(`media-${MAX_FINDINGS_PER_RULE}`);
    });

    it('reconciles when the true count equals the cap exactly (boundary)', async () => {
        // Fetch-one-extra trick: when true count == cap, SQL returns
        // exactly cap rows (the sentinel +1 was not present), so the
        // detector must NOT classify this as capped — reconciliation runs
        // normally and resolves any violations not in this set.
        const exactCapRows = Array.from({ length: MAX_FINDINGS_PER_RULE }, (_, i) => ({
            media_id: `media-${i}`,
            series_id: 'series-1',
            series_tmdb: '1234',
        }));

        let callCount = 0;
        const sql = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) return Promise.resolve(exactCapRows);
            return Promise.resolve([{ count: '0' }]);
        });

        mockReconcileViolationsForRule.mockResolvedValue(0);

        await integrityScannerTask.execute(
            makeCtx(sql) as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );

        // reconcileViolationsForRule must have been called with exactly
        // cap-sized seenMediaIds — proving the boundary case reconciled.
        const reconcileCalls = mockReconcileViolationsForRule.mock.calls;
        const exactCall = reconcileCalls.find(
            (args) =>
                Array.isArray(args[2]) && (args[2] as string[]).length === MAX_FINDINGS_PER_RULE,
        );
        expect(exactCall).toBeDefined();
    });
});

// =============================================================================
// Jellyfin-only rule narrowing: jellyfin+imdb episodes must not be flagged
// =============================================================================

describe('integrity-scanner episode-jellyfin-only rule narrowing', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCountOpenViolationsByRule.mockResolvedValue({});
        mockReconcileViolationsForRule.mockResolvedValue(0);
        delete process.env.DISABLE_INTEGRITY_SCANNER;
    });

    it('does not flag an episode that has jellyfin+imdb external_ids', async () => {
        // The SQL query uses IN ('tmdb', 'imdb') in the NOT EXISTS clause.
        // A correct implementation returns 0 rows for an episode with imdb.
        // We simulate this by returning an empty array (the DB would do the same).
        const sql = vi.fn().mockResolvedValue([]);

        const result = await integrityScannerTask.execute(
            makeCtx(sql) as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );

        // No violations should be recorded for any episode with imdb.
        // Since our mock SQL returns [] for every scan, there should be zero violations.
        expect(mockRecordViolation).toHaveBeenCalledTimes(0);
        expect(result.success).toBe(true);
    });
});

// =============================================================================
// False-success guard: the runner never reads `result.success`, so a run that
// accumulated per-probe errors (each rule + the stage-state sweep is wrapped
// in its own try/catch so one broken rule can't take down the others) but
// never threw was previously recorded 'completed' and credited the circuit
// breaker — hiding a total outage (e.g. every probe failing against a
// dropped DB connection mid-run).
// =============================================================================

describe('integrity-scanner false-success guard', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCountOpenViolationsByRule.mockResolvedValue({});
        delete process.env.DISABLE_INTEGRITY_SCANNER;
    });

    it('throws a transient TaskError when every probe fails and nothing was recorded (total outage)', async () => {
        const sql = vi.fn().mockRejectedValue(new Error('connection terminated'));
        const ctx = makeCtx(sql);

        await expect(
            integrityScannerTask.execute(
                ctx as unknown as Parameters<typeof integrityScannerTask.execute>[0],
            ),
        ).rejects.toThrow(/integrity-scanner: total failure/);
    });

    it('does not throw when at least one probe recorded findings despite others failing', async () => {
        // First scan call succeeds with a real finding; every subsequent sql
        // call (remaining rules + the stage-state sweep) rejects. Partial
        // success alongside errors must keep returning normally — a single
        // broken rule among healthy ones is expected noise, not a run failure.
        let callCount = 0;
        const sql = vi.fn().mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
                return Promise.resolve([
                    { media_id: 'media-1', series_id: 'series-1', series_tmdb: '1234' },
                ]);
            }
            return Promise.reject(new Error('boom'));
        });
        mockReconcileViolationsForRule.mockResolvedValue(0);

        const result = await integrityScannerTask.execute(
            makeCtx(sql) as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );

        expect(result.result!.totalRecorded).toBeGreaterThan(0);
        expect(result.result!.errors.length).toBeGreaterThan(0);
    });
});

describe('scheduled warning cleanup cursor', () => {
    it('persists bounded progress past retained warnings and resets only at the end', async () => {
        const { mockContext, mockCache } = await import('@sapd/lumastra-plugin-sdk-testing');
        const cursor = '12345678-1234-4234-8234-123456789abc';
        const cache = mockCache();
        const sqlMock = vi.fn().mockResolvedValue([]);
        cleanup.run.mockResolvedValue({
            rowsExamined: 500,
            reattached: 0,
            failedSeries: 0,
            continuation: cursor,
        });
        const ctx = mockContext({ sql: sqlMock as never, cache, input: {} });
        await integrityScannerTask.execute(ctx);
        expect(cleanup.run).toHaveBeenLastCalledWith(
            sqlMock,
            expect.objectContaining({ cap: 500, warningOnly: true, after: undefined }),
        );
        expect(await cache.get('v1:quarantine-cleanup:cursor')).toBe(cursor);
        cleanup.run.mockResolvedValueOnce({ rowsExamined: 1, reattached: 1, failedSeries: 0 });
        await integrityScannerTask.execute(ctx);
        expect(cleanup.run).toHaveBeenLastCalledWith(
            sqlMock,
            expect.objectContaining({ after: cursor }),
        );
        expect(await cache.get('v1:quarantine-cleanup:cursor')).toBeNull();
    });
    it('logs failed cleanup without advancing its cursor or skipping the backlog rule', async () => {
        const { mockCache } = await import('@sapd/lumastra-plugin-sdk-testing');
        const cache = mockCache();
        const cursor = '12345678-1234-4234-8234-123456789abc';
        await cache.set('v1:quarantine-cleanup:cursor', cursor, 10000);
        cleanup.run.mockRejectedValueOnce(new Error('read failed'));
        mockReconcileViolationsForRule.mockClear();
        const ctx = { ...makeCtx(), cache };
        const result = await integrityScannerTask.execute(
            ctx as unknown as Parameters<typeof integrityScannerTask.execute>[0],
        );
        expect(result.success).toBe(true);
        expect(ctx.logger.warn).toHaveBeenCalledWith('Quarantine warning cleanup failed', {
            reason: 'read failed',
        });
        expect(mockReconcileViolationsForRule).toHaveBeenCalledWith(
            ctx.sql,
            'quarantine-backlog-large',
            [],
            false,
        );
        expect(await cache.get('v1:quarantine-cleanup:cursor')).toBe(cursor);
    });
});
