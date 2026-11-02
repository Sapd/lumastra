// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { Run } from '@sapd/lumastra-plugin-sdk';
const mocks = vi.hoisted(() => ({ getRun: vi.fn(), getSegments: vi.fn(), success: vi.fn() }));
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet: mocks.getRun }));
vi.mock('$lib/api/admin', () => ({
    getMediaSegments: mocks.getSegments,
    generateMediaSegments: vi.fn(),
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
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: mocks.success, error: vi.fn(), info: vi.fn() },
}));
import SyncTab from './SyncTab.svelte';
import { runSSEBus } from '$lib/stores/run-sse-bus.js';

// Only the network boundary is replaced: tracker, shared bus, SyncTab and
// TaskActionButton all run together. This stream opens but misses completion.
class QuietEventSource extends EventTarget {
    static instances: QuietEventSource[] = [];
    onopen: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(_url: string) {
        super();
        QuietEventSource.instances.push(this);
    }
    close(): void {}
}
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it('unlocks both analysis actions and segment mutations after a missed terminal event with SSE still connected', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', QuietEventSource);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
    );
    const active: Run = {
        id: 'missed-analysis-completion',
        taskId: 'lumastra-intro-analyzer',
        label: 'Intro analysis',
        state: 'pending',
        input: { mediaId: 'reconcile-episode' },
        scope: { subjectType: 'mediaItem', subjectId: 'reconcile-episode' },
        trigger: { kind: 'manual' },
        actor: { type: 'system' },
        startedAt: new Date().toISOString(),
        stages: [],
    };
    const completed: Run = {
        ...active,
        state: 'completed',
        completedAt: new Date().toISOString(),
        result: {
            success: true,
            itemsProcessed: 1,
            result: { segmentsProduced: 1, seasonsProcessed: 0, analysisOutcome: 'completed' },
        },
    };
    let finished = false;
    mocks.getRun.mockImplementation(async (url: string) => ({
        data: url.includes('subjectId=') ? { items: finished ? [] : [active] } : completed,
    }));
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
    render(SyncTab, {
        mediaId: 'reconcile-episode',
        mediaType: 'episode',
        externalIds: {},
        activeRuns: [active],
        taskSection: 'processing',
    });
    await vi.advanceTimersByTimeAsync(0);
    QuietEventSource.instances[0].onopen?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(runSSEBus.connected).toBe(true);
    for (const name of ['Generate', 'Regenerate outros', 'Clear', 'Save segment'])
        expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Cancel' })).toHaveLength(2);
    finished = true;
    await vi.advanceTimersByTimeAsync(30000);
    expect(runSSEBus.connected).toBe(true);
    expect(runSSEBus.runs.get(active.id)?.state).toBe('completed');
    expect(mocks.getRun).toHaveBeenCalledWith(
        '/api/runs/missed-analysis-completion',
        expect.anything(),
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    for (const name of ['Generate', 'Regenerate outros', 'Clear', 'Save segment'])
        expect((screen.getByRole('button', { name }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
});
