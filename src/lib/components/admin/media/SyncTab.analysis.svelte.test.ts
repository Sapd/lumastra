// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Run } from '@sapd/lumastra-plugin-sdk';

const mocks = vi.hoisted(() => ({
    generate: vi.fn(),
    getSegments: vi.fn(),
    getRun: vi.fn(),
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    settled: undefined as ((run: Run) => void) | undefined,
}));
vi.mock('$lib/api/admin', () => ({
    generateMediaSegments: mocks.generate,
    getMediaSegments: mocks.getSegments,
    syncMediaMetadata: vi.fn(),
    syncMediaMetadataEnqueue: vi.fn(),
    getMediaExternalIds: vi.fn(),
    upsertMediaExternalId: vi.fn(),
    deleteMediaExternalId: vi.fn(),
    clearMediaSegments: vi.fn(),
    setMediaSegment: vi.fn(),
    generateTrickplay: vi.fn(),
    regenerateEpisodeThumbnails: vi.fn(),
    syncChapters: vi.fn(),
    cancelRun: vi.fn(),
}));
vi.mock('$lib/api/client.js', () => ({ apiGet: mocks.getRun }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));
vi.mock('$lib/stores/run-sse-bus.js', () => ({
    runSSEBus: { onAnyChange: () => () => {}, upsertRun: vi.fn() },
}));
vi.mock('$lib/stores/subject-runs.js', () => ({
    createSubjectRunsTracker: () => ({
        runsFor: () => [],
        isActive: () => false,
        progressFor: () => undefined,
        onSettled: (cb: (run: Run) => void) => {
            mocks.settled = cb;
            return () => {};
        },
        destroy: () => {},
    }),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: {
        success: mocks.success,
        error: mocks.error,
        info: mocks.info,
        warning: vi.fn(),
    },
}));
import SyncTab from './SyncTab.svelte';

function run(result: unknown, overrides: Partial<Run> = {}): Run {
    return {
        id: 'run-1',
        taskId: 'lumastra-intro-analyzer',
        label: 'Intro analysis',
        state: 'completed',
        input: { mediaId: 'episode-1' },
        scope: { subjectType: 'mediaItem', subjectId: 'episode-1' },
        trigger: { kind: 'manual', by: 'admin' },
        actor: { type: 'system' },
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        stages: [],
        result,
        ...overrides,
    } as Run;
}
async function generate(): Promise<void> {
    await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Generate' }).hasAttribute('disabled')).toBe(
            false,
        ),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Generate' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalled());
}
beforeEach(() => {
    mocks.settled = undefined;
    mocks.getSegments.mockResolvedValue({
        data: {
            analysisInputs: [
                {
                    mediaId: 'episode-1',
                    state: 'ready',
                    inputIdentity: 'source-a',
                    fileId: 'file-a',
                    filePath: '/fictional/source-a.mkv',
                    alternate: false,
                    proof: {
                        runId: 'run-1',
                        inputIdentity: 'source-a',
                        stageId: 'lumastra-intro-analyzer:visual',
                        segmentTypes: ['Intro', 'Outro'],
                        segmentsCount: 0,
                        completedAt: '2026-10-24T10:00:00Z',
                    },
                },
            ],
            totalSegments: 0,
            providers: {},
        },
    });
    mocks.generate.mockResolvedValue({ data: { runId: 'run-1', message: 'Analysis queued' } });
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
});

describe('selected intro analysis', () => {
    it.each([
        ['episode', 'single', 'Generate'],
        ['movie', 'single', 'Generate'],
        ['season', 'children', 'Generate Season'],
        ['series', 'children', 'Generate All Episodes'],
    ])(
        'offers the existing %s action with only its correct scope',
        async (mediaType, scope, label) => {
            render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType });
            const button = await screen.findByRole('button', { name: label });
            await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
            await fireEvent.click(button);
            expect(mocks.generate).toHaveBeenCalledWith('episode-1', scope);
        },
    );
    it('replaces accepted messaging when completed has native success:false', async () => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.success.mockClear();
        mocks.getRun.mockResolvedValue({
            data: run({
                success: false,
                itemsProcessed: 0,
                result: { seasonsProcessed: 0, segmentsProduced: 0 },
            }),
        });
        mocks.settled?.(run(undefined));
        await screen.findByText(
            'Analysis did not complete successfully. Some updates may already be saved. Review the segments and run, then retry if needed.',
        );
        expect(screen.queryByText('Analysis queued')).toBeNull();
        expect(mocks.success).not.toHaveBeenCalled();
        expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain(
            'run-1',
        );
    });
    it.each([
        undefined,
        {},
        { success: true },
        { success: 'true', itemsProcessed: 0, result: { segmentsProduced: 0 } },
    ])('never claims success without complete native proof (%s)', async (result) => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.success.mockClear();
        mocks.getRun.mockResolvedValue({ data: run(result) });
        mocks.settled?.(run(undefined));
        await screen.findByText(
            'Analysis outcome could not be verified. Some updates may already be saved. Review the segments and run before retrying.',
        );
        expect(mocks.success).not.toHaveBeenCalled();
    });
    it('accepts a genuine zero-detection result', async () => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.success.mockClear();
        mocks.getRun.mockResolvedValue({
            data: run({
                success: true,
                itemsProcessed: 0,
                result: { seasonsProcessed: 0, segmentsProduced: 0 },
            }),
        });
        mocks.settled?.(run(undefined));
        await screen.findByText('Analysis completed. No segments detected.');
        expect(mocks.success).toHaveBeenCalledTimes(1);
    });
    it('reports rejected enqueue calls durably', async () => {
        mocks.generate.mockRejectedValue(new Error('offline'));
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        await screen.findByText('Request failed');
        expect(mocks.success).not.toHaveBeenCalled();
    });
});

describe('terminal identity and lifecycle fences', () => {
    const failed =
        'Analysis did not complete successfully. Some updates may already be saved. Review the segments and run, then retry if needed.';
    const unverified =
        'Analysis outcome could not be verified. Some updates may already be saved. Review the segments and run before retrying.';
    const success = {
        success: true,
        itemsProcessed: 0,
        result: { seasonsProcessed: 0, segmentsProduced: 0 },
    };
    it.each([
        { id: 'wrong-run' },
        { taskId: 'wrong-task' },
        { scope: { subjectType: 'mediaItem', subjectId: 'other' } },
    ])('refuses mismatched canonical proof %s', async (overrides) => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.getRun.mockResolvedValue({ data: run(success, overrides as Partial<Run>) });
        mocks.settled?.(run(undefined));
        await screen.findByText(unverified);
        expect(mocks.success).not.toHaveBeenCalled();
    });
    it.each(['failed', 'cancelled'] as const)(
        'keeps the %s terminal outcome visible',
        async (state) => {
            render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
            await generate();
            mocks.getRun.mockResolvedValue({ data: run(success, { state }) });
            mocks.settled?.(run(undefined, { state }));
            await screen.findByText(
                state === 'failed'
                    ? failed
                    : 'Analysis was cancelled. Some updates may already be saved. Review the segments and run, then retry if needed.',
            );
            expect(mocks.success).not.toHaveBeenCalled();
        },
    );
    it('a missing or unreachable canonical run is inconclusive', async () => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.getRun.mockRejectedValue(new Error('offline'));
        mocks.settled?.(run(undefined));
        await screen.findByText(unverified);
        expect(mocks.success).not.toHaveBeenCalled();
    });
    it('ignores a detail response after navigation', async () => {
        let finish!: (value: unknown) => void;
        const view = render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.getRun.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        mocks.settled?.(run(undefined));
        await waitFor(() => expect(mocks.getRun).toHaveBeenCalled());
        await view.rerender({ mediaId: 'episode-2', externalIds: {}, mediaType: 'movie' });
        finish({ data: run(success) });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(screen.queryByText('Analysis completed. No segments detected.')).toBeNull();
        expect(mocks.success).not.toHaveBeenCalled();
    });
    it('ignores old detail proof after a newer attempt', async () => {
        let finish!: (value: unknown) => void;
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.getRun.mockReturnValueOnce(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        mocks.settled?.(run(undefined));
        mocks.generate.mockResolvedValue({ data: { runId: 'run-2', message: 'queued again' } });
        await generate();
        finish({ data: run(success) });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(mocks.success).not.toHaveBeenCalled();
        mocks.getRun.mockResolvedValue({
            data: run({ ...success, success: false }, { id: 'run-2' }),
        });
        mocks.settled?.(run(undefined, { id: 'run-2' }));
        await screen.findByText(failed);
    });
    it('does not let enqueue acceptance overwrite an earlier terminal event', async () => {
        let accept!: (value: unknown) => void;
        mocks.generate.mockReturnValue(
            new Promise((resolve) => {
                accept = resolve;
            }),
        );
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        mocks.getRun.mockResolvedValue({ data: run({ ...success, success: false }) });
        mocks.settled?.(run(undefined));
        accept({ data: { runId: 'run-1', message: 'queued' } });
        await screen.findByText(failed);
        expect(mocks.success).not.toHaveBeenCalled();
    });
    it('does not certify unrelated tasks without a successful result', async () => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await waitFor(() => expect(mocks.settled).toBeDefined());
        mocks.settled?.(run(undefined, { taskId: 'chapter-sync', label: 'Chapters' }));
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.info).toHaveBeenCalled();
        expect(mocks.getRun).not.toHaveBeenCalled();
    });
});

it('ignores terminal proof after the whole page unmounts', async () => {
    let finish!: (value: unknown) => void;
    const view = render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
    await generate();
    mocks.getRun.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    mocks.settled?.(run(undefined));
    await waitFor(() => expect(mocks.getRun).toHaveBeenCalled());
    view.unmount();
    finish({
        data: run({
            success: true,
            itemsProcessed: 0,
            result: { seasonsProcessed: 0, segmentsProduced: 0 },
        }),
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.success).not.toHaveBeenCalled();
});

it('a failed newer enqueue is not replaced by an old run success', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
    await generate();
    mocks.generate.mockRejectedValue(new Error('offline'));
    await generate();
    await screen.findByText('Request failed');
    mocks.getRun.mockResolvedValue({
        data: run({
            success: true,
            itemsProcessed: 0,
            result: { seasonsProcessed: 0, segmentsProduced: 0 },
        }),
    });
    mocks.settled?.(run(undefined));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
    expect(screen.getByText('Request failed')).toBeTruthy();
});

const completeProof = {
    success: true,
    itemsProcessed: 1,
    result: { seasonsProcessed: 0, segmentsProduced: 0, analysisOutcome: 'completed' },
};
const failedCopy =
    'Analysis did not complete successfully. Some updates may already be saved. Review the segments and run, then retry if needed.';
const verifiedZero = 'Analysis completed. No segments detected.';

it.each(['partial', 'deferred', 'skipped'])(
    'never turns native %s into no detection',
    async (analysisOutcome) => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'series' });
        mocks.getRun.mockResolvedValue({
            data: run({ ...completeProof, result: { ...completeProof.result, analysisOutcome } }),
        });
        mocks.settled?.(run(undefined));
        await waitFor(() => expect(screen.getByRole('link', { name: 'View run' })).toBeTruthy());
        expect(screen.queryByText(verifiedZero)).toBeNull();
        expect(mocks.success).not.toHaveBeenCalled();
    },
);
it('reconciles a completed accepted run missed by both SSE and active listing', async () => {
    mocks.getRun.mockResolvedValue({ data: run(completeProof) });
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'episode' });
    await generate();
    await waitFor(() => expect(screen.getByText(verifiedZero)).toBeTruthy(), { timeout: 3000 });
});
it('allows later external terminal runs after a local attempt settles', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'episode' });
    await generate();
    mocks.getRun.mockResolvedValue({ data: run(completeProof) });
    mocks.settled?.(run(undefined));
    await screen.findByText(verifiedZero);
    mocks.success.mockClear();
    mocks.getRun.mockResolvedValue({ data: run({ success: false }, { id: 'external-new' }) });
    mocks.settled?.(run(undefined, { id: 'external-new' }));
    await screen.findByText(failedCopy);
    expect(mocks.success).not.toHaveBeenCalled();
});
it('allows a later external run after a rejected enqueue without reviving an older accepted run', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'episode' });
    await generate();
    mocks.generate.mockRejectedValue(new Error('offline'));
    await generate();
    await screen.findByText('Request failed');
    mocks.getRun.mockResolvedValue({ data: run({ success: false }, { id: 'external-new' }) });
    mocks.settled?.(run(undefined, { id: 'external-new' }));
    await screen.findByText(failedCopy);
});
it.each(['transient', 'nonterminal'])('can check again after a %s canonical read', async (kind) => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'episode' });
    await generate();
    if (kind === 'transient') mocks.getRun.mockRejectedValueOnce(new Error('offline'));
    else mocks.getRun.mockResolvedValueOnce({ data: run(undefined, { state: 'active' }) });
    mocks.settled?.(run(undefined));
    const check = await screen.findByRole('button', { name: 'Check result again' });
    mocks.getRun.mockResolvedValue({ data: run(completeProof) });
    await waitFor(() => expect(check.hasAttribute('disabled')).toBe(false));
    await fireEvent.click(check);
    await screen.findByText(verifiedZero);
});
it('ignores an old external success response that arrives after a newer failure', async () => {
    let finish!: (value: unknown) => void;
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'episode' });
    await waitFor(() => expect(mocks.settled).toBeDefined());
    mocks.getRun.mockReturnValueOnce(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    const old = run(undefined, { id: 'external-old', startedAt: '2026-10-24T00:00:01.000Z' });
    const newer = run(undefined, { id: 'external-new', startedAt: '2026-10-24T00:00:02.000Z' });
    mocks.settled?.(old);
    mocks.getRun.mockResolvedValue({ data: { ...newer, result: { success: false } } });
    mocks.settled?.(newer);
    await screen.findByText(failedCopy);
    finish({ data: { ...old, result: completeProof } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(screen.getByText(failedCopy)).toBeTruthy();
    expect(mocks.success).not.toHaveBeenCalled();
    const reads = mocks.getRun.mock.calls.length;
    mocks.settled?.(old);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(mocks.getRun).toHaveBeenCalledTimes(reads);
});
it.each([
    ['Fingerprint', 'series', 'deep', undefined],
    ['Regenerate outros', 'episode', 'single', { outroOnly: true }],
])(
    'replays an early terminal for actual %s and retains its queued run link',
    async (label, mediaType, scope, options) => {
        let accept!: (value: unknown) => void;
        mocks.generate.mockReturnValue(
            new Promise((resolve) => {
                accept = resolve;
            }),
        );
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: String(mediaType) });
        const button = await screen.findByRole('button', { name: String(label) });
        await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
        await fireEvent.click(button);
        expect(mocks.generate).toHaveBeenCalledWith(
            ...(options ? ['episode-1', scope, options] : ['episode-1', scope]),
        );
        mocks.getRun.mockResolvedValue({ data: run({ success: false }) });
        mocks.settled?.(run(undefined));
        accept({ data: { runId: 'run-1', message: 'queued' } });
        await waitFor(() => expect(mocks.getRun).toHaveBeenCalled(), { timeout: 300 });
        await screen.findByText(failedCopy);
        expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain(
            'run-1',
        );
        expect(mocks.success).not.toHaveBeenCalled();
    },
);
it('Fingerprint acceptance is informational and links to its actual queued run', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'series' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Fingerprint' }));
    await screen.findByText('Analysis queued. Follow the run for its outcome.');
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain('run-1');
    expect(mocks.success).not.toHaveBeenCalled();
    expect(mocks.info).toHaveBeenCalled();
});

it('continues bounded background reconciliation without replaying a mutation', async () => {
    mocks.getRun.mockResolvedValue({ data: run(undefined, { state: 'active' }) });
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'episode' });
    await generate();
    vi.useFakeTimers();
    try {
        mocks.settled?.(run(undefined));
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.getRun.mock.calls.length).toBeLessThanOrEqual(6);
        expect(screen.getByRole('button', { name: 'Check result again' })).toBeTruthy();
        const reads = mocks.getRun.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mocks.getRun.mock.calls.length).toBeGreaterThan(reads);
        expect(mocks.getRun.mock.calls.length - reads).toBeLessThanOrEqual(2);
        expect(mocks.generate).toHaveBeenCalledOnce();
    } finally {
        vi.useRealTimers();
    }
});

it('keeps a long parent compact and reveals grouped alternate paths on demand', async () => {
    mocks.getSegments.mockResolvedValue({
        data: {
            totalSegments: 0,
            providers: {},
            analysisInputs: Array.from({ length: 1001 }, (_, index) => ({
                mediaId: `episode-${index}`,
                state: 'ready',
                inputIdentity: `input-${index}`,
                fileId: `file-${index}`,
                filePath: `/fictional/alternate-${index % 30}.mkv`,
                alternate: true,
                proof: null,
            })),
        },
    });
    render(SyncTab, { mediaId: 'series-1', mediaType: 'series', externalIds: {} });
    await waitFor(() =>
        expect(
            screen.getByRole('button', { name: 'Generate All Episodes' }).hasAttribute('disabled'),
        ).toBe(false),
    );
    expect(document.body.textContent).toContain('1001');
    expect(document.body.textContent).not.toContain('/fictional/alternate-');
    const details = [...document.querySelectorAll('details')].find((element) =>
        element.querySelector('summary')?.textContent?.includes('Selected alternate versions'),
    );
    expect(details).not.toBeNull();
    details!.open = true;
    await fireEvent(details!, new Event('toggle'));
    await waitFor(() => expect(document.body.textContent).toContain('/fictional/alternate-'));
    expect(
        document.body.textContent!.match(/\/fictional\/alternate-/g)!.length,
    ).toBeLessThanOrEqual(20);
});

it('rejects a late completed run proof after source replacement under the same UUID', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
    await generate();
    mocks.getRun.mockResolvedValue({
        data: run({
            success: true,
            itemsProcessed: 1,
            result: { segmentsProduced: 0, seasonsProcessed: 0, analysisOutcome: 'no-detection' },
        }),
    });
    mocks.getSegments.mockResolvedValue({
        data: {
            totalSegments: 0,
            providers: {},
            analysisInputs: [
                {
                    mediaId: 'episode-1',
                    state: 'ready',
                    inputIdentity: 'replacement-source',
                    fileId: 'file-a',
                    filePath: '/fictional/source-a.mkv',
                    alternate: false,
                    proof: {
                        runId: 'run-1',
                        inputIdentity: 'source-a',
                        stageId: 'lumastra-intro-analyzer:visual',
                        segmentTypes: ['Intro', 'Outro'],
                        segmentsCount: 0,
                        processingVersion: 5,
                        coverageComplete: true,
                        completedAt: '2026-10-24T10:00:00Z',
                    },
                },
            ],
        },
    });
    mocks.settled?.(run(undefined));
    await screen.findByText(
        'Analysis outcome could not be verified. Some updates may already be saved. Review the segments and run before retrying.',
    );
    expect(screen.queryByText('Analysis completed. No segments detected.')).toBeNull();
    expect(screen.getByRole('link', { name: 'View run' })).toBeTruthy();
});

function sourceResponse(identity: string, proofIdentity: string | null = identity) {
    return {
        data: {
            totalSegments: 0,
            providers: {},
            analysisInputs: [
                {
                    mediaId: 'episode-1',
                    state: 'ready',
                    inputIdentity: identity,
                    fileId: 'file-a',
                    filePath: '/fictional/source-a.mkv',
                    alternate: false,
                    proof: proofIdentity
                        ? {
                              runId: 'run-1',
                              inputIdentity: proofIdentity,
                              stageId: 'lumastra-intro-analyzer:visual',
                              segmentTypes: ['Intro', 'Outro'],
                              segmentsCount: 0,
                              processingVersion: 5,
                              coverageComplete: true,
                              completedAt: '2026-10-24T10:00:00Z',
                          }
                        : null,
                },
            ],
        },
    };
}

it('keeps a fast deep-run generation proof current through followup and older refresh, then rejects actual replacement', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'series' });
    const fingerprint = await screen.findByRole('button', { name: 'Fingerprint' });
    await waitFor(() => expect(fingerprint.hasAttribute('disabled')).toBe(false));
    await fireEvent.click(fingerprint);
    await screen.findByText('Analysis queued. Follow the run for its outcome.');
    let finishOld!: (value: unknown) => void;
    mocks.getSegments
        .mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = resolve;
                }),
        )
        .mockResolvedValue(sourceResponse('deep-generation'));
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(finishOld).toBeTypeOf('function'));
    mocks.getRun.mockResolvedValue({
        data: run({
            success: true,
            itemsProcessed: 1,
            result: { segmentsProduced: 0, seasonsProcessed: 1, analysisOutcome: 'no-detection' },
        }),
    });
    mocks.settled?.(run(undefined));
    await screen.findByText('Analysis completed. No segments detected.');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('Analysis completed. No segments detected.')).toBeTruthy();
    finishOld(sourceResponse('source-a'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByText('Analysis completed. No segments detected.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain('run-1');
    mocks.getSegments.mockResolvedValue(sourceResponse('actual-replacement', 'deep-generation'));
    await fireEvent(window, new Event('focus'));
    await waitFor(() =>
        expect(screen.queryByText('Analysis completed. No segments detected.')).toBeNull(),
    );
    expect(screen.getByRole('link', { name: 'View run' })).toBeTruthy();
});

it.each(
    [
        ['Generate', 'movie'],
        ['Regenerate outros', 'movie'],
        ['Fingerprint', 'series'],
    ].flatMap(([label, mediaType]) =>
        ['resolve', 'reject'].map((outcome) => [label, mediaType, outcome]),
    ),
)(
    'releases %s ownership across replacement before enqueue %s/%s',
    async (label, mediaType, outcome) => {
        let finish!: (value: unknown) => void, fail!: (error: Error) => void;
        mocks.generate.mockReturnValue(
            new Promise((resolve, reject) => {
                finish = resolve;
                fail = reject;
            }),
        );
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType });
        const action = await screen.findByRole('button', { name: label });
        await waitFor(() => expect(action.hasAttribute('disabled')).toBe(false));
        await fireEvent.click(action);
        await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
        mocks.getSegments.mockResolvedValue(sourceResponse('replacement-during-enqueue', null));
        await fireEvent(window, new Event('focus'));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(
                false,
            ),
        );
        if (outcome === 'resolve') finish({ data: { runId: 'obsolete-run', message: 'queued' } });
        else fail(new Error('obsolete request failed'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(action.hasAttribute('disabled')).toBe(false);
        expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(
            false,
        );
        expect(screen.queryByRole('link', { name: 'View run' })).toBeNull();
        if (outcome === 'resolve') mocks.settled?.(run(undefined, { id: 'obsolete-run' }));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(screen.queryByRole('link', { name: 'View run' })).toBeNull();
        expect(mocks.success).not.toHaveBeenCalled();
    },
);

it('retains an owned deep run through a reset after more than ten seconds, then requires current proof', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'series' });
    const action = await screen.findByRole('button', { name: 'Fingerprint' });
    await waitFor(() => expect(action.hasAttribute('disabled')).toBe(false));
    mocks.getRun.mockResolvedValue({ data: run(undefined, { state: 'active' }) });
    await fireEvent.click(action);
    vi.useFakeTimers();
    try {
        await vi.advanceTimersByTimeAsync(11_000);
    } finally {
        vi.useRealTimers();
    }
    mocks.getSegments.mockResolvedValue(sourceResponse('deep-reset', null));
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(mocks.getSegments).toHaveBeenCalledTimes(2));
    mocks.getSegments.mockResolvedValue(sourceResponse('deep-reset'));
    mocks.getRun.mockResolvedValue({ data: run(completeProof) });
    mocks.settled?.(run(undefined));
    await screen.findByText(verifiedZero);
    expect(mocks.success).toHaveBeenCalledTimes(1);
    mocks.getSegments.mockResolvedValue(sourceResponse('real-replacement', 'deep-reset'));
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(screen.queryByText(verifiedZero)).toBeNull());
});

it.each([true, false])(
    'reconciles a focus read overlapping canonical completion, current proof=%s',
    async (matching) => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'series' });
        await fireEvent.click(await screen.findByRole('button', { name: 'Fingerprint' }));
        await screen.findByText('Analysis queued. Follow the run for its outcome.');
        let finish!: (value: unknown) => void;
        mocks.getRun.mockResolvedValue({ data: run(completeProof) });
        mocks.getSegments
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockResolvedValue(
                sourceResponse('concurrent-input', matching ? 'concurrent-input' : 'source-a'),
            );
        mocks.settled?.(run(undefined));
        await waitFor(() => expect(finish).toBeTypeOf('function'));
        await fireEvent(window, new Event('focus'));
        await waitFor(() => expect(mocks.getSegments).toHaveBeenCalledTimes(3));
        finish(sourceResponse('concurrent-input'));
        if (matching) {
            await screen.findByText(verifiedZero, {}, { timeout: 3000 });
            expect(mocks.success).toHaveBeenCalledTimes(1);
        } else {
            await screen.findByText(
                'Analysis outcome could not be verified. Some updates may already be saved. Review the segments and run before retrying.',
                {},
                { timeout: 3000 },
            );
            expect(screen.queryByText(verifiedZero)).toBeNull();
            expect(mocks.success).not.toHaveBeenCalled();
        }
    },
);

it.each(
    ['before', 'after'].flatMap((order) =>
        (['failed', 'completed'] as const).flatMap((state) =>
            [true, false].map((matching) => [order, state, matching] as const),
        ),
    ),
)(
    'does not attribute obsolete %s-response terminal %s to replacement, matching proof=%s',
    async (order, state, matching) => {
        let accept!: (value: unknown) => void;
        mocks.generate.mockReturnValue(
            new Promise((resolve) => {
                accept = resolve;
            }),
        );
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        const obsolete = run(state === 'completed' ? completeProof : { success: false }, {
            state,
            startedAt: new Date(Date.now() - 1000).toISOString(),
        });
        mocks.getRun.mockResolvedValue({ data: obsolete });
        mocks.getSegments.mockResolvedValue(
            sourceResponse('replacement', matching ? 'replacement' : 'source-a'),
        );
        await fireEvent(window, new Event('focus'));
        await waitFor(() =>
            expect(screen.getByRole('button', { name: 'Refresh' }).hasAttribute('disabled')).toBe(
                false,
            ),
        );
        if (order === 'before') mocks.settled?.(obsolete);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mocks.getRun).not.toHaveBeenCalled();
        accept({ data: { runId: 'run-1', message: 'queued' } });
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (order === 'after') mocks.settled?.(obsolete);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mocks.success).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
        expect(screen.queryByText(verifiedZero)).toBeNull();
        expect(screen.queryByText(failedCopy)).toBeNull();
    },
);

it('does not apply a failure observed across an unknown input change as a current-source error', async () => {
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
    await generate();
    mocks.getSegments.mockResolvedValue(sourceResponse('replacement', null));
    await fireEvent(window, new Event('focus'));
    await waitFor(() => expect(mocks.getSegments).toHaveBeenCalledTimes(2));
    mocks.getRun.mockResolvedValue({ data: run({ success: false }, { state: 'failed' }) });
    mocks.settled?.(run(undefined));
    await screen.findByText(
        'Analysis outcome could not be verified. Some updates may already be saved. Review the segments and run before retrying.',
    );
    expect(await screen.findByRole('link', { name: 'View run' })).toBeTruthy();
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
});

it.each(['resolve', 'reject'])(
    'keeps unknown old terminal IDs fenced when obsolete enqueue later %s',
    async (outcome) => {
        let accept!: (value: unknown) => void, reject!: (error: Error) => void;
        mocks.generate.mockReturnValue(
            new Promise((yes, no) => {
                accept = yes;
                reject = no;
            }),
        );
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        const old = run(
            { success: false },
            {
                id: 'unknown-old',
                state: 'failed',
                startedAt: new Date(Date.now() - 1000).toISOString(),
            },
        );
        mocks.getSegments.mockResolvedValue(sourceResponse('new-source', null));
        await fireEvent(window, new Event('focus'));
        await waitFor(() => expect(mocks.getSegments).toHaveBeenCalledTimes(2));
        mocks.getRun.mockResolvedValue({ data: old });
        mocks.settled?.(old);
        if (outcome === 'resolve') accept({ data: { runId: 'different-old', message: 'queued' } });
        else reject(new Error('old enqueue offline'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(mocks.getRun).not.toHaveBeenCalled();
        expect(mocks.error).not.toHaveBeenCalled();
        const newer = run(
            { success: false },
            { id: 'genuine-external', startedAt: new Date(Date.now() + 1000).toISOString() },
        );
        mocks.getRun.mockResolvedValue({ data: newer });
        mocks.settled?.(newer);
        await screen.findByText(failedCopy);
        expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain(
            'genuine-external',
        );
    },
);

it('an unresolved old enqueue does not block a known superseding run or restore its own result', async () => {
    let acceptOld!: (value: unknown) => void;
    mocks.generate.mockReturnValueOnce(
        new Promise((resolve) => {
            acceptOld = resolve;
        }),
    );
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'series' });
    await fireEvent.click(await screen.findByRole('button', { name: 'Fingerprint' }));
    await waitFor(() => expect(mocks.generate).toHaveBeenCalledTimes(1));
    mocks.getSegments.mockResolvedValue(sourceResponse('replacement', null));
    await fireEvent(window, new Event('focus'));
    const next = await screen.findByRole('button', { name: 'Generate All Episodes' });
    await waitFor(() => expect(next.hasAttribute('disabled')).toBe(false));
    mocks.generate.mockResolvedValue({ data: { runId: 'run-2', message: 'queued' } });
    await fireEvent.click(next);
    await waitFor(() =>
        expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain(
            'run-2',
        ),
    );
    mocks.getRun.mockResolvedValue({ data: run({ success: false }, { id: 'run-2' }) });
    mocks.settled?.(run(undefined, { id: 'run-2' }));
    await screen.findByText(failedCopy);
    mocks.error.mockClear();
    acceptOld({ data: { runId: 'run-1', message: 'old queued' } });
    mocks.settled?.(run(undefined));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain('run-2');
    expect(mocks.error).not.toHaveBeenCalled();
    expect(mocks.success).not.toHaveBeenCalled();
});

it('old pending subject ownership cannot block external observation after navigation', async () => {
    let acceptOld!: (value: unknown) => void;
    mocks.generate.mockReturnValueOnce(
        new Promise((resolve) => {
            acceptOld = resolve;
        }),
    );
    const view = render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
    await generate();
    await view.rerender({ mediaId: 'episode-2', externalIds: {}, mediaType: 'movie' });
    await waitFor(() => expect(mocks.getSegments).toHaveBeenCalledWith('episode-2'));
    const newer = run(
        { success: false },
        { id: 'subject-2-run', scope: { subjectType: 'mediaItem', subjectId: 'episode-2' } },
    );
    mocks.getRun.mockResolvedValue({ data: newer });
    mocks.settled?.(newer);
    await screen.findByText(failedCopy);
    mocks.error.mockClear();
    acceptOld({ data: { runId: 'run-1', message: 'old queued' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain(
        'subject-2-run',
    );
    expect(mocks.error).not.toHaveBeenCalled();
});

it.each([
    ['failed', 'completed', failedCopy],
    [
        'cancelled',
        'completed',
        'Analysis was cancelled. Some updates may already be saved. Review the segments and run, then retry if needed.',
    ],
    ['completed', 'completed', verifiedZero],
    [
        'completed',
        'skipped',
        'Analysis did not run: it is disabled, no applicable detector is enabled, or no eligible target is available. Review the run and settings.',
    ],
] as const)(
    'bounds a stalled terminal %s/%s proof read, ignores late data and permits a fresh check',
    async (state, analysisOutcome, expected) => {
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        await screen.findByText('Analysis queued. Follow the run for its outcome.');
        let finish!: (value: unknown) => void;
        mocks.getSegments
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finish = resolve;
                    }),
            )
            .mockResolvedValue(sourceResponse('source-a'));
        mocks.getRun.mockResolvedValue({
            data: run(
                { ...completeProof, result: { ...completeProof.result, analysisOutcome } },
                { state },
            ),
        });
        vi.useFakeTimers();
        try {
            mocks.settled?.(run(undefined));
            await vi.advanceTimersByTimeAsync(0);
            expect(finish).toBeTypeOf('function');
            await vi.advanceTimersByTimeAsync(10_000);
            const check = screen.getByRole('button', { name: 'Check result again' });
            expect(check.hasAttribute('disabled')).toBe(false);
            expect(screen.getByRole('link', { name: 'View run' })).toBeTruthy();
            finish(sourceResponse('late-obsolete-response'));
            await vi.advanceTimersByTimeAsync(0);
            expect(screen.queryByText(verifiedZero)).toBeNull();
            expect(mocks.success).not.toHaveBeenCalled();
            expect(mocks.error).not.toHaveBeenCalled();
            await fireEvent.click(check);
            await vi.advanceTimersByTimeAsync(0);
            expect(screen.getByText(expected)).toBeTruthy();
            expect(mocks.getRun).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    },
);

it.each(['failed', 'cancelled', 'completed'] as const)(
    'keeps an older deduped %s run unverified on unchanged current input without proof',
    async (state) => {
        mocks.getSegments.mockResolvedValue(sourceResponse('observed-current', null));
        mocks.generate.mockResolvedValue({
            data: { runId: 'run-1', deduped: true, message: 'already queued' },
        });
        render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
        await generate();
        await screen.findByText('Analysis queued. Follow the run for its outcome.');
        const old = run(state === 'completed' ? completeProof : { success: false }, {
            state,
            startedAt: '2026-10-23T00:00:00Z',
        });
        mocks.getRun.mockResolvedValue({ data: old });
        mocks.settled?.(old);
        await screen.findByText(
            'Analysis outcome could not be verified. Some updates may already be saved. Review the segments and run before retrying.',
        );
        expect(screen.getByRole('link', { name: 'View run' }).getAttribute('href')).toContain(
            'run-1',
        );
        expect(screen.queryByText(verifiedZero)).toBeNull();
        expect(screen.queryByText(failedCopy)).toBeNull();
        expect(mocks.error).not.toHaveBeenCalled();
        expect(mocks.success).not.toHaveBeenCalled();
    },
);

it('verifies a deduped completed run only when canonical proof matches the current input', async () => {
    mocks.getSegments.mockResolvedValue(sourceResponse('observed-current', null));
    mocks.generate.mockResolvedValue({
        data: { runId: 'run-1', deduped: true, message: 'already queued' },
    });
    render(SyncTab, { mediaId: 'episode-1', externalIds: {}, mediaType: 'movie' });
    await generate();
    await screen.findByText('Analysis queued. Follow the run for its outcome.');
    mocks.getSegments.mockResolvedValue(sourceResponse('observed-current'));
    mocks.getRun.mockResolvedValue({ data: run(completeProof) });
    mocks.settled?.(run(undefined));
    await screen.findByText(verifiedZero);
    expect(mocks.success).toHaveBeenCalledTimes(1);
    expect(mocks.error).not.toHaveBeenCalled();
});
