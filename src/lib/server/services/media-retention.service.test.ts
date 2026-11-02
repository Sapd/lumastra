// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type {
    AudiobookshelfSyncEvidence,
    LibraryPathScanEvidence,
} from '../database/queries/media-retention.queries.js';

const retentionConfig = vi.hoisted(() => ({ days: 30 }));
vi.mock('$lib/server/database/queries/media-retention.queries.js', () => ({
    get MEDIA_RETENTION_DAYS() {
        return retentionConfig.days;
    },
    RETENTION_SCAN_MAX_AGE_DAYS: 7,
    RETENTION_UNIT_MAX_ROWS: 5000,
    RETENTION_KINDS: ['track', 'album', 'movie', 'series', 'audiobook'],
    RETENTION_PATH_MEDIA_TYPES: {
        track: ['music'],
        album: ['music'],
        movie: ['movie', 'anime'],
        series: ['tv', 'anime'],
    },
    findRetentionRootGroups: vi.fn(),
    evaluateRetentionUnits: vi.fn(),
    getLibraryGroupScanEvidence: vi.fn(),
    getAudiobookshelfSyncEvidence: vi.fn(),
    deriveRetentionUnit: vi.fn(),
    initializeRetentionClock: vi.fn(),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeAccess: vi.fn(),
    safeStat: vi.fn(),
    safeReaddir: vi.fn(),
}));
vi.mock('./media-deletion.service.js', () => ({
    MediaDeletionService: { retentionDeleteUnit: vi.fn() },
}));
vi.mock('$lib/server/database/with-tx.js', () => ({ withTx: vi.fn() }));
import {
    deriveRetentionUnit,
    evaluateRetentionUnits,
    findRetentionRootGroups,
    getAudiobookshelfSyncEvidence,
    getLibraryGroupScanEvidence,
    initializeRetentionClock,
} from '../database/queries/media-retention.queries.js';
import { safeAccess, safeReaddir, safeStat } from '../utils/safe-fs.js';
import { withTx } from '../database/with-tx.js';
import { MediaDeletionService } from './media-deletion.service.js';
import {
    audiobookshelfEvidenceFailure,
    runMediaRetention,
    scanEvidenceFailure,
    validateRetentionGroups,
} from './media-retention.service.js';

const sql = Object.assign(vi.fn().mockResolvedValue([]), {}) as unknown as postgres.Sql;
const healthyPath = (patch: Partial<LibraryPathScanEvidence> = {}): LibraryPathScanEvidence => ({
    group_key: 'g-music',
    id: 'root',
    path: '/media/music',
    enabled: true,
    provider: 'musicbrainz',
    media_type: 'music',
    state: 'completed',
    configured_at: new Date(Date.now() - 20000),
    started_at: new Date(Date.now() - 10000),
    completed_at: new Date(),
    result: { added: 0, updated: 0, skipped: 100, unmatched: 0, scanErrors: 0 },
    ...patch,
});
const healthyAbs = (
    patch: Partial<AudiobookshelfSyncEvidence> = {},
): AudiobookshelfSyncEvidence => ({
    id: 'abs-path',
    enabled: true,
    provider: 'audiobookshelf',
    media_type: 'audiobook',
    state: 'completed',
    configured_at: new Date(Date.now() - 20000),
    started_at: new Date(Date.now() - 10000),
    completed_at: new Date(),
    result: { added: 0, updated: 0, dismissed: 0, unmatched: 0, skipped: 12, errors: [] },
    ...patch,
});
const unit = (
    id: string,
    kind: 'track' | 'movie' | 'series' | 'album' | 'audiobook',
    lost: Date | null,
    group = 'g-music',
): {
    id: string;
    kind: typeof kind;
    group_key: string;
    files_lost_at: Date | null;
} => ({ id, kind, group_key: group, files_lost_at: lost });

describe('media retention health gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.mocked(withTx).mockImplementation(async (db, callback) => callback(db));
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([healthyPath()]);
        vi.mocked(getAudiobookshelfSyncEvidence).mockResolvedValue([healthyAbs()]);
        vi.mocked(safeAccess).mockResolvedValue();
        vi.mocked(safeStat).mockResolvedValue({ isDirectory: () => true } as Awaited<
            ReturnType<typeof safeStat>
        >);
        vi.mocked(safeReaddir).mockResolvedValue([
            { name: 'Album', isFile: () => false, isDirectory: () => true },
        ] as Awaited<ReturnType<typeof safeReaddir>>);
        vi.mocked(findRetentionRootGroups).mockResolvedValue([]);
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({ candidates: [], summary: [] });
    });

    it.each([
        { enabled: false },
        { provider: 'audiobookshelf' },
        { path: 'abs://library' },
        { state: 'active' },
        { state: 'failed' },
        { completed_at: null },
        { started_at: new Date(NaN) },
        { configured_at: new Date(NaN) },
        { configured_at: new Date() },
        { completed_at: new Date(Date.now() - 8 * 86400000) },
        { result: { scanErrors: 5, added: 0, updated: 0, skipped: 95, unmatched: 0 } },
        { result: { scanErrors: 1, added: 1, updated: 0, skipped: 0, unmatched: 0 } },
        { result: { scanErrors: 0, added: 0, updated: 0, skipped: 0, unmatched: 0 } },
        { result: { scanErrors: 0, added: 1 } },
        { result: { added: 1, updated: 0, skipped: 0, unmatched: 0 } },
        { result: null },
    ])('fails closed for uncertain scan evidence %j', (patch) => {
        expect(scanEvidenceFailure(healthyPath(patch))).not.toBeNull();
    });

    it('rejects even a scan error rate under five percent', () => {
        expect(
            scanEvidenceFailure(
                healthyPath({
                    result: { scanErrors: 4, added: 0, updated: 0, skipped: 96, unmatched: 0 },
                }),
            ),
        ).toBe('scan-errors-or-unknown');
    });

    it.each([
        { enabled: false },
        { provider: 'tmdb' },
        { media_type: 'music' },
        { state: 'failed' },
        { completed_at: new Date(Date.now() - 8 * 86400000) },
        { configured_at: new Date() },
        { result: null },
        { result: { added: 0, updated: 0, dismissed: 0, unmatched: 0, skipped: 0, errors: [] } },
        { result: { added: 1, updated: 0, dismissed: 0, unmatched: 0, skipped: 0, errors: ['x'] } },
        { result: { added: 1, updated: 0, dismissed: 0, unmatched: 0, skipped: 0 } },
    ])('fails closed for uncertain Audiobookshelf evidence %j', (patch) => {
        expect(audiobookshelfEvidenceFailure(healthyAbs(patch))).not.toBeNull();
    });

    it('accepts a fresh clean Audiobookshelf sync', () => {
        expect(audiobookshelfEvidenceFailure(healthyAbs())).toBeNull();
    });

    describe('per-library Audiobookshelf slices', () => {
        const slice = (
            patch: Record<string, unknown> = {},
        ): Record<string, unknown> & { listed: boolean } => ({
            listed: true,
            added: 0,
            updated: 0,
            dismissed: 0,
            unmatched: 0,
            skipped: 12,
            errors: 0,
            ...patch,
        });
        const withLibraries = (
            libraries: unknown,
            runErrors: string[] = ['Library other: upstream listing failed'],
        ): AudiobookshelfSyncEvidence =>
            healthyAbs({
                result: {
                    added: 0,
                    updated: 0,
                    dismissed: 0,
                    unmatched: 0,
                    skipped: 12,
                    errors: runErrors,
                    libraries,
                },
            });

        it('judges a clean path on its own slice despite another library failing', () => {
            const row = withLibraries({
                'abs-path': slice(),
                'other-path': slice({ listed: false, skipped: 0, errors: 1 }),
            });
            expect(audiobookshelfEvidenceFailure(row)).toBeNull();
            expect(audiobookshelfEvidenceFailure({ ...row, id: 'other-path' })).toBe(
                'abs-library-not-listed',
            );
        });

        it('fails only the path whose dismissal cap tripped', () => {
            const row = withLibraries({
                'abs-path': slice(),
                'capped-path': slice({ skipped: 40, errors: 1 }),
            });
            expect(audiobookshelfEvidenceFailure(row)).toBeNull();
            expect(audiobookshelfEvidenceFailure({ ...row, id: 'capped-path' })).toBe(
                'sync-errors-or-unknown',
            );
        });

        it('fails closed for a path missing from a run that has libraries', () => {
            expect(audiobookshelfEvidenceFailure(withLibraries({}, []))).toBe(
                'abs-library-not-in-sync',
            );
            expect(audiobookshelfEvidenceFailure(withLibraries(null, []))).toBe(
                'abs-library-not-in-sync',
            );
        });

        it.each([
            [{ errors: 'none' }, 'sync-errors-or-unknown'],
            [{ errors: 2 }, 'sync-errors-or-unknown'],
            [{ skipped: 0 }, 'empty-or-unknown-sync'],
            [{ skipped: -1 }, 'empty-or-unknown-sync'],
            [{ listed: 'yes' }, 'abs-library-not-listed'],
        ])('rejects an uncertain slice %j', (patch, reason) => {
            expect(audiobookshelfEvidenceFailure(withLibraries({ 'abs-path': slice(patch) }))).toBe(
                reason,
            );
        });

        it('keeps the run-wide check for an envelope without libraries', () => {
            expect(
                audiobookshelfEvidenceFailure(
                    healthyAbs({
                        result: {
                            added: 0,
                            updated: 0,
                            dismissed: 0,
                            unmatched: 0,
                            skipped: 12,
                            errors: ['Library other: upstream listing failed'],
                        },
                    }),
                ),
            ).toBe('sync-errors-or-unknown');
        });

        it('isolates the failing ABS path in group validation', async () => {
            vi.mocked(getAudiobookshelfSyncEvidence).mockResolvedValue([
                withLibraries({
                    'abs-path': slice(),
                    'b-path': slice({ listed: false, skipped: 0, errors: 1 }),
                }),
                {
                    ...withLibraries({
                        'abs-path': slice(),
                        'b-path': slice({ listed: false, skipped: 0, errors: 1 }),
                    }),
                    id: 'b-path',
                },
            ]);
            const health = await validateRetentionGroups(sql, [
                { kind: 'audiobook', groupKey: 'abs-path' },
                { kind: 'audiobook', groupKey: 'b-path' },
            ]);
            expect(health.healthy).toEqual({ audiobook: ['abs-path'] });
            expect(health.unhealthy).toEqual([{ kind: 'audiobook', groupKey: 'b-path' }]);
            expect(health.reasons).toEqual(['audiobook group b-path: abs-library-not-listed']);
        });
    });

    it('isolates an unhealthy group and keeps healthy groups usable', async () => {
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([
            healthyPath(),
            healthyPath({
                group_key: 'g-movies',
                id: 'movies',
                media_type: 'movie',
                enabled: false,
            }),
        ]);
        const health = await validateRetentionGroups(sql, [
            { kind: 'track', groupKey: 'g-music' },
            { kind: 'movie', groupKey: 'g-movies' },
        ]);
        expect(health.healthy).toEqual({ track: ['g-music'] });
        expect(health.unhealthy).toEqual([{ kind: 'movie', groupKey: 'g-movies' }]);
        expect(health.reasons[0]).toContain('disabled-root');
    });

    it('requires every path in the group to match the unit kind', async () => {
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([
            healthyPath({ group_key: 'g-mixed', media_type: 'movie' }),
            healthyPath({ group_key: 'g-mixed', id: 'other', media_type: 'music' }),
        ]);
        const health = await validateRetentionGroups(sql, [{ kind: 'movie', groupKey: 'g-mixed' }]);
        expect(health.healthy).toEqual({});
        expect(health.reasons[0]).toContain('kind-mismatch');
    });

    it('rejects groups without paths, empty roots and unreadable roots', async () => {
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([]);
        expect(
            (await validateRetentionGroups(sql, [{ kind: 'album', groupKey: 'gone' }])).reasons,
        ).toEqual(['album group gone: no-library-paths']);
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([healthyPath()]);
        vi.mocked(safeReaddir).mockResolvedValue([]);
        expect(
            (await validateRetentionGroups(sql, [{ kind: 'track', groupKey: 'g-music' }]))
                .reasons[0],
        ).toContain('empty-or-unusable-root');
        vi.mocked(safeAccess).mockRejectedValue(new Error('offline mount'));
        expect(
            (await validateRetentionGroups(sql, [{ kind: 'track', groupKey: 'g-music' }]))
                .reasons[0],
        ).toContain('inaccessible-root');
    });

    it('validates audiobook groups through the named ABS path, not the filesystem', async () => {
        const health = await validateRetentionGroups(sql, [
            { kind: 'audiobook', groupKey: 'abs-path' },
            { kind: 'audiobook', groupKey: 'missing' },
        ]);
        expect(health.healthy).toEqual({ audiobook: ['abs-path'] });
        expect(health.reasons).toEqual(['audiobook group missing: missing-library-path']);
        expect(safeAccess).not.toHaveBeenCalled();
    });

    it('gives each group its own probe budget so one slow mount cannot starve the next', async () => {
        let now = 100000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([
            healthyPath({ group_key: 'slow', id: 'slow', path: '/media/slow' }),
            healthyPath({ group_key: 'fast', id: 'fast', path: '/media/fast' }),
        ]);
        vi.mocked(safeAccess).mockImplementation(async (path) => {
            if (path === '/media/slow') now += 6000;
        });
        const result = await validateRetentionGroups(sql, [
            { kind: 'track', groupKey: 'slow' },
            { kind: 'track', groupKey: 'fast' },
        ]);
        expect(result.reasons).toHaveLength(1);
        expect(result.reasons[0]).toContain('track group slow');
        expect(result.reasons[0]).toContain('validation-budget-exhausted');
        expect(result.healthy).toEqual({ track: ['fast'] });
        clock.mockRestore();
    });

    it('bounds all filesystem probes to a combined budget', async () => {
        let now = 100000;
        const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([
            healthyPath({ configured_at: new Date(0), started_at: new Date(0) }),
        ]);
        vi.mocked(safeAccess).mockImplementation(async () => {
            now += 6000;
        });
        vi.mocked(safeStat).mockImplementation(async () => {
            now += 6000;
            return { isDirectory: () => true } as Awaited<ReturnType<typeof safeStat>>;
        });
        const result = await validateRetentionGroups(sql, [{ kind: 'track', groupKey: 'g-music' }]);
        expect(result.reasons[0]).toContain('validation-budget-exhausted');
        expect(safeReaddir).not.toHaveBeenCalled();
        clock.mockRestore();
    });
});

describe('media retention run', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        retentionConfig.days = 30;
        vi.mocked(withTx).mockImplementation(async (db, callback) => callback(db));
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([healthyPath()]);
        vi.mocked(getAudiobookshelfSyncEvidence).mockResolvedValue([]);
        vi.mocked(safeAccess).mockResolvedValue();
        vi.mocked(safeStat).mockResolvedValue({ isDirectory: () => true } as Awaited<
            ReturnType<typeof safeStat>
        >);
        vi.mocked(safeReaddir).mockResolvedValue([
            { name: 'Album', isFile: () => false, isDirectory: () => true },
        ] as Awaited<ReturnType<typeof safeReaddir>>);
        vi.mocked(findRetentionRootGroups).mockResolvedValue([
            { kind: 'track', group_key: 'g-music', roots: 3 },
        ]);
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({ candidates: [], summary: [] });
    });

    it.each([false, true])(
        'does no database or filesystem work when disabled (preview: %s)',
        async (dryRun) => {
            retentionConfig.days = 0;
            const result = await runMediaRetention(
                sql,
                { dryRun, batchLimit: 100 },
                new AbortController().signal,
            );
            expect(result).toMatchObject({
                retentionDays: 0,
                deleted: 0,
                deletedRows: 0,
                initialized: 0,
                candidates: 0,
                hasMore: false,
            });
            expect(result.reasons).toEqual([
                'Retention disabled (UNAVAILABLE_MEDIA_RETENTION_DAYS=0)',
            ]);
            expect(withTx).not.toHaveBeenCalled();
            expect(findRetentionRootGroups).not.toHaveBeenCalled();
            expect(safeAccess).not.toHaveBeenCalled();
        },
    );

    it('evaluates no units without healthy groups and explains why', async () => {
        vi.mocked(findRetentionRootGroups).mockResolvedValue([
            { kind: 'track', group_key: null, roots: 7 },
            { kind: 'movie', group_key: 'g-movies', roots: 2 },
        ]);
        vi.mocked(getLibraryGroupScanEvidence).mockResolvedValue([]);
        const result = await runMediaRetention(
            sql,
            { dryRun: false, batchLimit: 100 },
            new AbortController().signal,
        );
        expect(result.reasons).toEqual([
            'track: 7 root(s) without library provenance',
            'movie group g-movies: no-library-paths',
        ]);
        expect(result.byKind.track).toMatchObject({ roots: 7, missingProvenance: 7 });
        expect(result.byKind.movie).toMatchObject({ roots: 2, unhealthyGroup: 2 });
        expect(evaluateRetentionUnits).toHaveBeenCalledWith(sql, {}, 101, expect.anything());
        expect(initializeRetentionClock).not.toHaveBeenCalled();
        expect(MediaDeletionService.retentionDeleteUnit).not.toHaveBeenCalled();
    });

    it('preview returns the same bounded candidate classes and per-kind counts without writes', async () => {
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({
            candidates: [unit('old', 'track', new Date(0)), unit('unknown', 'track', null)],
            summary: [{ kind: 'track', ready: 2, shape_blocked: 0, protected: 1, oversized: 0 }],
        });
        const result = await runMediaRetention(
            sql,
            { dryRun: true, batchLimit: 2 },
            new AbortController().signal,
        );
        expect(result).toMatchObject({
            candidates: 2,
            eligible: 1,
            unknownAge: 1,
            deleted: 0,
            initialized: 0,
            reasons: [],
        });
        expect(result.byKind.track).toMatchObject({
            roots: 3,
            candidates: 2,
            eligible: 1,
            unknownAge: 1,
            protected: 1,
        });
        expect(evaluateRetentionUnits).toHaveBeenCalledWith(
            sql,
            { track: ['g-music'] },
            3,
            expect.anything(),
        );
        expect(deriveRetentionUnit).not.toHaveBeenCalled();
        expect(initializeRetentionClock).not.toHaveBeenCalled();
        expect(MediaDeletionService.retentionDeleteUnit).not.toHaveBeenCalled();
        expect(withTx).toHaveBeenCalledTimes(1);
        // A preview never issues SET/LOCK/UPDATE statements beyond its read transaction.
        const statements = (sql as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
            (call) => (call[0] as TemplateStringsArray).join('?'),
        );
        expect(statements.every((s) => s.trimStart().startsWith('SET LOCAL'))).toBe(true);
    });

    it('reports truncation while handling only the requested batch', async () => {
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({
            candidates: [unit('a', 'track', new Date(0)), unit('b', 'track', null)],
            summary: [],
        });
        const result = await runMediaRetention(
            sql,
            { dryRun: true, batchLimit: 1 },
            new AbortController().signal,
        );
        expect(result).toMatchObject({
            candidates: 1,
            eligible: 1,
            unknownAge: 0,
            hasMore: true,
            truncated: true,
        });
    });

    it('deletes expired units and counts rows; lock contention skips only that unit', async () => {
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({
            candidates: [
                unit('s1', 'series', new Date(0), 'g-tv'),
                unit('s2', 'series', new Date(0), 'g-tv'),
                unit('m1', 'movie', new Date(0), 'g-tv'),
            ],
            summary: [],
        });
        vi.mocked(MediaDeletionService.retentionDeleteUnit)
            .mockResolvedValueOnce({ deleted: true, deletedCount: 12, deletedIds: [] })
            .mockRejectedValueOnce(Object.assign(new Error('lock'), { code: '55P03' }))
            .mockResolvedValueOnce({
                deleted: false,
                deletedCount: 0,
                deletedIds: [],
                skipReason: 'eligibility-changed',
            });
        const result = await runMediaRetention(
            sql,
            { dryRun: false, batchLimit: 10 },
            new AbortController().signal,
        );
        expect(result).toMatchObject({
            deleted: 1,
            deletedRows: 12,
            skipped: 2,
            deletedIds: ['s1'],
        });
        expect(result.byKind.series).toMatchObject({ deleted: 1, deletedRows: 12, skipped: 1 });
        expect(result.byKind.movie).toMatchObject({ skipped: 1 });
        expect(result.reasons).toEqual([
            'concurrent-reference-or-library-write',
            'eligibility-changed',
        ]);
    });

    it('stops taking new units after the soft deadline and reports more work', async () => {
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({
            candidates: [unit('a', 'track', new Date(0)), unit('b', 'track', new Date(0))],
            summary: [],
        });
        vi.mocked(MediaDeletionService.retentionDeleteUnit).mockResolvedValue({
            deleted: true,
            deletedCount: 1,
            deletedIds: [],
        });
        let now = 0;
        const result = await runMediaRetention(
            sql,
            { dryRun: false, batchLimit: 10 },
            new AbortController().signal,
            {
                softDeadlineMs: 1000,
                now: () => {
                    const current = now;
                    now += 600;
                    return current;
                },
            },
        );
        expect(result).toMatchObject({ deleted: 1, hasMore: true });
        expect(result.reasons).toContain('time-budget-exhausted');
        expect(MediaDeletionService.retentionDeleteUnit).toHaveBeenCalledTimes(1);
    });

    it('rethrows unexpected errors instead of hiding them', async () => {
        vi.mocked(evaluateRetentionUnits).mockResolvedValue({
            candidates: [unit('x', 'track', new Date(0))],
            summary: [],
        });
        vi.mocked(MediaDeletionService.retentionDeleteUnit).mockRejectedValue(new Error('boom'));
        await expect(
            runMediaRetention(sql, { dryRun: false, batchLimit: 1 }, new AbortController().signal),
        ).rejects.toThrow('boom');
    });

    it('honors cancellation before any I/O', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            runMediaRetention(sql, { dryRun: false, batchLimit: 1 }, controller.signal),
        ).rejects.toThrow();
        expect(findRetentionRootGroups).not.toHaveBeenCalled();
    });

    it('honors cancellation after an empty candidate discovery', async () => {
        const controller = new AbortController();
        vi.mocked(evaluateRetentionUnits).mockImplementation(async () => {
            controller.abort();
            return { candidates: [], summary: [] };
        });
        await expect(
            runMediaRetention(sql, { dryRun: true, batchLimit: 1 }, controller.signal),
        ).rejects.toThrow();
    });
});
