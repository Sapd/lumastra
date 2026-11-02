// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * media-probe retryItem — unit tests.
 *
 * Covers the retryOneFile path:
 *   - Invalid UUID (no DB hit)
 *   - File not found
 *   - File presence 'transient'
 *   - File presence 'missing'
 *   - Already healthy (probed_at set, has_keyframes, no issues) → idempotent success
 *   - Phase B only: probe succeeds, clean keyframes → success
 *   - Phase B only: probe produces no_keyframes issue → failure
 *   - No probed_at → Phase A first, then Phase B
 *   - probeKeyframes.success = false → failure
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── ffprobe mock ─────────────────────────────────────────────────────────────
const { mockProbeMediaFile, mockProbeKeyframes, mockProbeStreamTails } = vi.hoisted(() => ({
    mockProbeMediaFile: vi.fn(),
    mockProbeKeyframes: vi.fn(),
    mockProbeStreamTails: vi.fn(),
}));

vi.mock('../../../../utils/ffprobe.js', () => ({
    probeMediaFile: mockProbeMediaFile,
    probeKeyframes: mockProbeKeyframes,
    probeStreamTails: mockProbeStreamTails,
}));

// ─── file-presence mock ───────────────────────────────────────────────────────
const { mockAssessFilePresence } = vi.hoisted(() => ({
    mockAssessFilePresence: vi.fn(),
}));

vi.mock('../../../../utils/file-presence.js', () => ({
    assessFilePresence: mockAssessFilePresence,
}));

import type { FilePresence } from '../../../../utils/file-presence.js';

// ─── media-files.queries mock ─────────────────────────────────────────────────
const { mockUpdateProbeData, mockUpdateKeyframes, mockUpdateHealthIssues } = vi.hoisted(() => ({
    mockUpdateProbeData: vi.fn(),
    mockUpdateKeyframes: vi.fn(),
    mockUpdateHealthIssues: vi.fn(),
}));

vi.mock('../../../../database/queries/media-files.queries.js', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
        ...actual,
        updateProbeData: mockUpdateProbeData,
        updateKeyframes: mockUpdateKeyframes,
        updateHealthIssues: mockUpdateHealthIssues,
    };
});

// ─── media-stream-mapper mock ─────────────────────────────────────────────────
const { mockMapFFprobeToDbRows } = vi.hoisted(() => ({
    mockMapFFprobeToDbRows: vi.fn().mockReturnValue([]),
}));

vi.mock('../../../../utils/media-stream-mapper.js', () => ({
    mapFFprobeToDbRows: mockMapFFprobeToDbRows,
}));

// ─── media-streams.queries mock ───────────────────────────────────────────────
const { mockReplaceStreamsForFile } = vi.hoisted(() => ({
    mockReplaceStreamsForFile: vi.fn(),
}));

vi.mock('../../../../database/queries/media-streams.queries.js', () => ({
    replaceStreamsForFile: mockReplaceStreamsForFile,
}));

// ─── Drain-backlog mock (task uses it at module load in execute()) ─────────────
import type * as DrainBacklogModule from '../../../../plugins/runtime/drain-backlog.js';
vi.mock('../../../../plugins/runtime/drain-backlog.js', async (importOriginal) => {
    const actual = await importOriginal<typeof DrainBacklogModule>();
    return { ...actual, drainBacklog: vi.fn() };
});

import { mediaProbeTask } from '../media-probe.js';
import type { TaskContext } from '@sapd/lumastra-plugin-sdk';

// ─── Helpers ──────────────────────────────────────────────────────────────────

type SqlMock = ReturnType<typeof vi.fn> & {
    begin: ReturnType<typeof vi.fn>;
    json: (v: unknown) => unknown;
};

/**
 * Build a tagged-template sql mock that resolves calls in order from `rows`.
 * `.begin(fn)` calls fn with the same mock (simulates a transaction).
 * `.json(v)` is a passthrough so sql.json() inside tagged templates doesn't throw.
 */
function makeSqlFn(rows: Array<Array<Record<string, unknown>>>): SqlMock {
    let i = 0;
    const fn = vi.fn((..._args: unknown[]) => Promise.resolve(rows[i++] ?? []));
    const beginFn = vi.fn((txFn: (sql: unknown) => Promise<unknown>) => txFn(fn));
    return Object.assign(fn, { begin: beginFn, json: (v: unknown) => v });
}

function makeCtx(
    rows: Array<Array<Record<string, unknown>>>,
): TaskContext<{ [x: string]: unknown }> {
    return {
        sql: makeSqlFn(rows) as never,
        logger: {
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        },
        signal: new AbortController().signal,
        input: { mode: 'manual' },
        runId: 'test-run-id',
        reportProgress: vi.fn(),
    } as unknown as TaskContext<{ [x: string]: unknown }>;
}

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

/** File that has been fully probed with keyframes (healthy). */
const HEALTHY_FILE = {
    id: VALID_UUID,
    file_path: '/media/movie.mkv',
    probed_at: new Date('2024-01-01'),
    duration_seconds: 7200,
    has_keyframes: true,
    has_video: true,
};

/** File probed but missing keyframes (Phase B needed). */
const NEEDS_PHASE_B = {
    id: VALID_UUID,
    file_path: '/media/movie.mkv',
    probed_at: new Date('2024-01-01'),
    duration_seconds: 7200,
    has_keyframes: false,
    has_video: true,
    // Represents the audit_run_job_id the ORIGINAL failing run wrote.
    // Per-item retries must preserve this across failure-marker rewrites so
    // the admin UI's "Run #X →" link keeps resolving to a real task_history
    // row rather than a synthetic retry jobId.
    prior_audit_job_id: 'original-run-42',
};

/** File never probed (Phase A + B needed). */
const NEEDS_PHASE_A = {
    id: VALID_UUID,
    file_path: '/media/movie.mkv',
    probed_at: null,
    duration_seconds: null,
    has_keyframes: false,
    has_video: false,
    prior_audit_job_id: null,
};

/** Healthy health_issues state row (no issues). */
const HEALTH_OK = [{ health_issues: null }];

/** Clean keyframes — spans ≥ 90% of NEEDS_PHASE_B.duration_seconds (7200s). */
const CLEAN_KEYFRAMES = [0, 1800, 3600, 5400, 7000];

/** Successful probeMediaFile result. */
const PROBE_MEDIA_SUCCESS = {
    success: true,
    video: { bitrate: 5000000 },
    audios: [],
    subtitles: [],
    duration: 7200,
    container: 'matroska,webm',
    fileSize: 8589934592,
    formatBitrate: 10000000,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('media-probe retryItem', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockUpdateProbeData.mockResolvedValue(undefined);
        mockUpdateKeyframes.mockResolvedValue(undefined);
        mockUpdateHealthIssues.mockResolvedValue(undefined);
        mockReplaceStreamsForFile.mockResolvedValue(undefined);
    });

    // 0. retry is defined after module attachment
    it('is defined on the task', () => {
        expect(typeof mediaProbeTask.failures?.retry).toBe('function');
    });

    // 1. Invalid UUID → rejected pre-DB
    it('rejects invalid UUID without hitting the DB', async () => {
        const ctx = makeCtx([]);
        await expect(mediaProbeTask.failures!.retry!(ctx, 'not-a-uuid')).rejects.toThrow(
            /invalid file id/i,
        );
        expect(ctx.sql as unknown as SqlMock).not.toHaveBeenCalled();
    });

    // 2. File not found → sql returns []
    it('returns not-found when the file row is missing', async () => {
        const ctx = makeCtx([[]]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /not found/i,
        );
    });

    // 3. File presence 'transient' → early exit, no probe calls
    it('returns failure with transient reason when parent dir is missing', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('transient');

        const ctx = makeCtx([[HEALTHY_FILE]]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /transiently missing/i,
        );
        expect(mockProbeKeyframes).not.toHaveBeenCalled();
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
    });

    // 4. File presence 'missing' → early exit
    it('returns failure when file is not found on disk', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('missing');

        const ctx = makeCtx([[HEALTHY_FILE]]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /not found on disk/i,
        );
        expect(mockProbeKeyframes).not.toHaveBeenCalled();
    });

    // 5. Already healthy (probed_at set, has_keyframes, no issues) → idempotent success
    it('returns success with no work when file is already healthy', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('present' satisfies FilePresence);

        // sql calls: [file lookup], [health_issues post-check]
        const ctx = makeCtx([[HEALTHY_FILE], HEALTH_OK, HEALTH_OK]);

        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).resolves.toBeUndefined();

        expect(mockProbeMediaFile).not.toHaveBeenCalled();
        expect(mockProbeKeyframes).not.toHaveBeenCalled();
        expect(mockUpdateKeyframes).not.toHaveBeenCalled();
    });

    // 6. Phase B only: probe succeeds with clean keyframes → success
    it('runs Phase B only and returns success when keyframes are clean', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('present' satisfies FilePresence);
        mockProbeKeyframes.mockResolvedValueOnce({
            success: true,
            keyframes: CLEAN_KEYFRAMES,
        });

        // sql calls: [file lookup] — updateKeyframes + updateHealthIssues are mocked
        const ctx = makeCtx([[NEEDS_PHASE_B]]);

        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).resolves.toBeUndefined();

        expect(mockProbeMediaFile).not.toHaveBeenCalled();
        expect(mockProbeKeyframes).toHaveBeenCalledWith(
            NEEDS_PHASE_B.file_path,
            expect.objectContaining({ signal: expect.anything() }),
        );
        expect(mockUpdateKeyframes).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            CLEAN_KEYFRAMES,
        );
        expect(mockUpdateHealthIssues).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            null,
            null,
        );
    });

    // 7. Phase B only: probe returns keyframes that trigger no_keyframes issue → failure
    it('returns failure with no_keyframes reason when keyframe probe detects issue', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('present' satisfies FilePresence);
        mockProbeKeyframes.mockResolvedValueOnce({
            success: true,
            keyframes: [], // empty → no_keyframes
        });

        // sql calls: [file lookup] — updateKeyframes + updateHealthIssues are mocked
        const ctx = makeCtx([[NEEDS_PHASE_B]]);

        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /no_keyframes/,
        );
        // The retry preserves the prior `audit_run_job_id`
        // ('original-run-42' from the fixture) so the "Run #X →" link
        // keeps pointing at the real task_history row.
        expect(mockUpdateHealthIssues).toHaveBeenCalledWith(
            expect.anything(),
            VALID_UUID,
            expect.arrayContaining([expect.objectContaining({ type: 'no_keyframes' })]),
            'original-run-42',
        );
    });

    // 8. No probed_at → Phase A runs first; assert updateProbeData called
    it('runs Phase A then Phase B when file has never been probed', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('present' satisfies FilePresence);
        mockProbeMediaFile.mockResolvedValueOnce(PROBE_MEDIA_SUCCESS);
        mockProbeKeyframes.mockResolvedValueOnce({
            success: true,
            keyframes: CLEAN_KEYFRAMES,
        });

        // sql calls (fn counts only inline sql`` calls; mocked fns don't use fn):
        //   0: file lookup (returns NEEDS_PHASE_A)
        //   1 (inside begin): runtime UPDATE (probe.duration > 0)
        //   2 (inside begin): L3 linkedA SELECT (media_file_items) — empty so no
        //      per-item upsertCompletedRow/file.probed calls follow
        //   3: refreshed row SELECT after Phase A
        //   4 (inside Phase B begin): L3 linkedB SELECT — empty
        //   (updateProbeData, updateKeyframes, updateHealthIssues are mocked)
        const ctx = makeCtx([
            [NEEDS_PHASE_A], // 0: initial file lookup
            [], // 1: runtime UPDATE (inside tx)
            [], // 2: L3 linkedA SELECT (inside tx) — no linked items in this unit test
            [{ duration_seconds: 7200, has_video: true }], // 3: refreshed SELECT
            [], // 4: L3 linkedB SELECT (inside Phase B tx)
        ]);

        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).resolves.toBeUndefined();

        expect(mockProbeMediaFile).toHaveBeenCalledWith(
            NEEDS_PHASE_A.file_path,
            undefined,
            expect.objectContaining({ signal: expect.anything() }),
        );
        expect(mockUpdateProbeData).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ fileId: VALID_UUID }),
        );
        expect(mockProbeKeyframes).toHaveBeenCalled();
    });

    // 9. probeKeyframes.success = false → failure
    it('returns failure when probeKeyframes reports failure', async () => {
        mockAssessFilePresence.mockResolvedValueOnce('present' satisfies FilePresence);
        mockProbeKeyframes.mockResolvedValueOnce({
            success: false,
            keyframes: [],
            error: 'ffprobe exited with code 1',
        });

        const ctx = makeCtx([[NEEDS_PHASE_B]]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /ffprobe exited/i,
        );
        expect(mockUpdateKeyframes).not.toHaveBeenCalled();
    });
});

describe('existing-keyframed file health retry', () => {
    const early = { type: 'video_ends_early', detected_at: 'original' };
    const truncated = { type: 'truncated_video', detected_at: 'original' };
    const gap = { type: 'video_decode_gaps', detected_at: 'concurrent' };
    const clean = {
        success: true,
        videoEnd: 1355,
        audioEnd: 1360,
        hasAudio: true,
        endedPrematurely: false,
    };

    function setup(
        issues: Array<Record<string, unknown>>,
        signal?: AbortSignal,
        metadata: { keyframes?: number[]; duration_seconds?: number | null } = {},
    ): {
        ctx: ReturnType<typeof makeCtx>;
        sql: SqlMock;
        state: { issues: Array<Record<string, unknown>>; audit: string | null };
    } {
        const state = { issues, audit: 'original-run-42' as string | null };
        const row = {
            ...HEALTHY_FILE,
            keyframes: [0, 500, 1000],
            duration_seconds: 13_600,
            ...metadata,
        };
        const sql = Object.assign(
            vi.fn((strings: TemplateStringsArray | string, ...values: unknown[]) => {
                if (typeof strings === 'string') return strings;
                const query = strings.join('?');
                if (query.includes('mf.probed_at')) return [row];
                if (query.includes('SELECT id, keyframes'))
                    return [{ ...row, health_issues: [...state.issues] }];
                if (query.includes('SELECT health_issues'))
                    return [{ health_issues: [...state.issues] }];
                if (query.includes('RETURNING health_issues')) {
                    const reviewed = values[0] as Array<Record<string, unknown>>;
                    state.issues = state.issues.filter(
                        (issue) =>
                            !reviewed.some((r) => JSON.stringify(r) === JSON.stringify(issue)),
                    );
                    return [{ health_issues: state.issues.length ? [...state.issues] : null }];
                }
                if (query.includes('SET audit_run_job_id = NULL')) state.audit = null;
                return [];
            }),
            { json: (value: unknown) => value, begin: vi.fn() },
        ) as SqlMock;
        sql.begin.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(sql));
        const ctx = { ...makeCtx([]), sql: sql as never, ...(signal ? { signal } : {}) };
        return { ctx, sql, state };
    }

    beforeEach(() => {
        vi.clearAllMocks();
        mockAssessFilePresence.mockResolvedValue('present');
        mockProbeStreamTails.mockResolvedValue(clean);
    });

    it('revalidates only the selected file and clears disproved tail issues', async () => {
        const { ctx, sql, state } = setup([early, truncated]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).resolves.toBeUndefined();
        expect(mockProbeStreamTails).toHaveBeenCalledExactlyOnceWith(
            '/media/movie.mkv',
            expect.objectContaining({ signal: ctx.signal, timeoutMs: 30_000 }),
        );
        expect(state.issues).toEqual([]);
        expect(state.audit).toBeNull();
        expect(
            sql.mock.calls.some(
                ([strings]) =>
                    Array.isArray(strings) &&
                    strings.join('').includes('UPDATE plugin_failure_events'),
            ),
        ).toBe(true);
        expect(mockUpdateKeyframes).not.toHaveBeenCalled();
        expect(mockProbeMediaFile).not.toHaveBeenCalled();
        expect(
            sql.mock.calls.every(
                ([strings]) => !Array.isArray(strings) || !strings.join('').includes('ORDER BY id'),
            ),
        ).toBe(true);
    });

    it.each([
        ['premature EOF', { ...clean, endedPrematurely: true }],
        ['longer audio', { ...clean, audioEnd: 13_590 }],
        ['missing video tail', { ...clean, videoEnd: null }],
        ['missing audio tail', { ...clean, audioEnd: null }],
        ['failed subprocess with partial packets', { ...clean, success: false }],
    ])('preserves evidence and provenance for %s', async (_label, tails) => {
        mockProbeStreamTails.mockResolvedValue(tails);
        const { ctx, state } = setup([early]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /video_ends_early/,
        );
        expect(mockProbeStreamTails).toHaveBeenCalledOnce();
        expect(state.issues).toEqual([early]);
        expect(state.audit).toBe('original-run-42');
    });

    it.each([gap, { type: 'container_unreadable', detected_at: 'original' }])(
        'preserves the unrelated $type in a mixed issue list',
        async (unrelated) => {
            const { ctx, state } = setup([early, unrelated]);
            await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
                new RegExp(unrelated.type),
            );
            expect(state.issues).toEqual([unrelated]);
            expect(state.audit).toBe('original-run-42');
        },
    );

    it('preserves concurrent new evidence including a replacement of the reviewed type', async () => {
        const { ctx, state, sql } = setup([early]);
        const newer = { ...early, detected_at: 'new' };
        mockProbeStreamTails.mockImplementation(async () => {
            state.issues = [early, gap, newer];
            return clean;
        });
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /video_decode_gaps/,
        );
        expect(state.issues).toEqual([gap, newer]);
        expect(state.audit).toBe('original-run-42');
        expect(
            sql.mock.calls.some(
                ([strings]) =>
                    Array.isArray(strings) &&
                    strings.join('').includes('UPDATE plugin_failure_events'),
            ),
        ).toBe(false);
    });

    it('preserves all issues when cancelled during probing', async () => {
        const controller = new AbortController();
        const { ctx, state } = setup([early], controller.signal);
        mockProbeStreamTails.mockImplementation(async () => {
            controller.abort();
            return clean;
        });
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(/abort/i);
        expect(mockProbeStreamTails).toHaveBeenCalledOnce();
        expect(state.issues).toEqual([early]);
        expect(state.audit).toBe('original-run-42');
    });

    it('keeps packet-confirmed damage despite misleading stored keyframes', async () => {
        const { ctx, state } = setup([truncated], undefined, {
            keyframes: [0, 5000, 10000, 13590],
        });
        mockProbeStreamTails.mockResolvedValue({ ...clean, endedPrematurely: true });
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /truncated_video/,
        );
        expect(mockProbeStreamTails).toHaveBeenCalledOnce();
        expect(state.issues).toEqual([truncated]);
    });

    it.each([null, 0, -1, Number.NaN])(
        'preserves tail issues with unusable duration %s',
        async (duration_seconds) => {
            const { ctx, state } = setup([early], undefined, { duration_seconds });
            await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
                /inconclusive/,
            );
            expect(state.issues).toEqual([early]);
            expect(mockProbeStreamTails).not.toHaveBeenCalled();
        },
    );

    it.each([
        [13_590, true],
        [1000, false],
    ])('judges silent video using its own tail at %s', async (videoEnd, healthy) => {
        const { ctx, state } = setup([early]);
        mockProbeStreamTails.mockResolvedValue({
            success: true,
            videoEnd,
            audioEnd: null,
            hasAudio: false,
            endedPrematurely: false,
        });
        const retry = mediaProbeTask.failures!.retry!(ctx, VALID_UUID);
        if (healthy) await expect(retry).resolves.toBeUndefined();
        else await expect(retry).rejects.toThrow(/video_ends_early/);
        expect(state.issues).toEqual(healthy ? [] : [early]);
    });

    it('reports a file removed before the final health read', async () => {
        const ctx = makeCtx([[HEALTHY_FILE], [{ health_issues: null }], []]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).rejects.toThrow(
            /file not found/i,
        );
    });

    it('does no subprocess work for a healthy file', async () => {
        const { ctx } = setup([]);
        await expect(mediaProbeTask.failures!.retry!(ctx, VALID_UUID)).resolves.toBeUndefined();
        expect(mockProbeStreamTails).not.toHaveBeenCalled();
    });
});
