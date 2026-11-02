// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Run } from '@sapd/lumastra-plugin-sdk';

const busRuns = new Map<string, Run>();
let anyChangeCb: (() => void) | null = null;

const bus = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    upsertRun: vi.fn((r: Run) => busRuns.set(r.id, r)),
    get runs() {
        return busRuns;
    },
    connected: true,
    onAnyChange: vi.fn((cb: () => void) => {
        anyChangeCb = cb;
        return () => {
            anyChangeCb = null;
        };
    }),
};

vi.mock('./run-sse-bus.js', () => ({ runSSEBus: bus }));

// Controllable apiGet: [0] is the subject-scoped list, [1..] are single-run reads.
const apiGetImpl = { fn: async (_url: string) => ({ data: undefined as unknown }) };
vi.mock('$lib/api/client.js', () => ({
    apiGet: (url: string) => apiGetImpl.fn(url),
}));

function run(over: Partial<Run> & { id: string }): Run {
    return {
        taskId: 'trickplay-generation',
        label: 'Trickplay',
        state: 'active',
        input: {},
        scope: { subjectType: 'mediaItem', subjectId: 'media-1' },
        trigger: { kind: 'manual' },
        startedAt: '2026-08-18T10:00:00.000Z',
        stages: [],
        actor: { type: 'user' },
        ...over,
    } as Run;
}

beforeEach(() => {
    busRuns.clear();
    vi.clearAllMocks();
    bus.connected = true;
    apiGetImpl.fn = async () => ({ data: undefined });
});

it('settles an accepted run that completed before the active listing or SSE saw it, without replaying work', async () => {
    const completed = run({
        id: 'finished-before-listing',
        state: 'completed',
        result: { success: true, itemsProcessed: 1 },
    });
    apiGetImpl.fn = async (url) => ({
        data: url.includes('subjectId=') ? { items: [] } : completed,
    });
    const { createSubjectRunsTracker } = await import('./subject-runs.js');
    const tracker = createSubjectRunsTracker('media-1', []);
    const settled = vi.fn();
    tracker.onSettled(settled);
    tracker.observeRun?.(completed.id);
    await vi.waitFor(() => expect(settled).toHaveBeenCalledExactlyOnceWith(completed));
    tracker.observeRun?.(completed.id);
    await Promise.resolve();
    expect(settled).toHaveBeenCalledOnce();
    expect(tracker.isActive(completed.taskId)).toBe(false);
    tracker.destroy();
});

it('keeps reading an accepted run after a transport failure even if it never appeared in the bus', async () => {
    vi.useFakeTimers();
    apiGetImpl.fn = async () => ({ data: undefined });
    const { createSubjectRunsTracker } = await import('./subject-runs.js');
    const tracker = createSubjectRunsTracker('media-1', []);
    const settled = vi.fn();
    tracker.onSettled(settled);
    tracker.observeRun?.('temporarily-unreadable');
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).not.toHaveBeenCalled();
    const completed = run({
        id: 'temporarily-unreadable',
        state: 'completed',
        result: { success: true, itemsProcessed: 1 },
    });
    apiGetImpl.fn = async (url) => ({
        data: url.includes('subjectId=') ? { items: [] } : completed,
    });
    await vi.advanceTimersByTimeAsync(35000);
    expect(settled).toHaveBeenCalledExactlyOnceWith(completed);
    tracker.destroy();
});

describe('createSubjectRunsTracker', () => {
    it('pushes the SSR seed through the bus so progress can merge into it', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [run({ id: 'r1' })]);

        expect(bus.upsertRun).toHaveBeenCalledTimes(1);
        expect(t.isActive('trickplay-generation')).toBe(true);
        t.destroy();
    });

    it('ignores runs belonging to another subject', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', []);
        busRuns.set(
            'r2',
            run({ id: 'r2', scope: { subjectType: 'mediaItem', subjectId: 'media-2' } }),
        );
        anyChangeCb?.();

        expect(t.isActive('trickplay-generation')).toBe(false);
        t.destroy();
    });

    it('tracks multiple concurrent runs for one task', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [run({ id: 'r1' }), run({ id: 'r2' })]);
        expect(t.runsFor('trickplay-generation')).toHaveLength(2);
        t.destroy();
    });

    it('fires onSettled exactly once per terminal transition', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [run({ id: 'r1' })]);
        const settled = vi.fn();
        t.onSettled(settled);

        busRuns.set(
            'r1',
            run({ id: 'r1', state: 'failed', completedAt: '2026-08-18T10:05:00.000Z' }),
        );
        anyChangeCb?.();
        anyChangeCb?.();

        expect(settled).toHaveBeenCalledTimes(1);
        expect(settled.mock.calls[0][0].state).toBe('failed');
        t.destroy();
    });

    it('does NOT fire onSettled for a run already terminal in the seed', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [
            run({ id: 'r1', state: 'completed', completedAt: '2026-08-18T10:05:00.000Z' }),
        ]);
        const settled = vi.fn();
        t.onSettled(settled);
        anyChangeCb?.();

        expect(settled).not.toHaveBeenCalled();
        t.destroy();
    });

    it('disconnects the bus exactly once on destroy', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', []);
        t.destroy();
        t.destroy();
        expect(bus.disconnect).toHaveBeenCalledTimes(1);
    });
});

describe('subject REST collection', () => {
    it('adopts active items from the subject-scoped envelope', async () => {
        const active = run({ id: 'from-rest' });
        apiGetImpl.fn = async () => ({
            data: { items: [active], page: { limit: 200, hasMore: false } },
        });
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', []);
        await vi.waitFor(() => expect(tracker.runsFor(active.taskId)).toEqual([active]));
        expect(bus.upsertRun).toHaveBeenCalledWith(active);
        tracker.destroy();
    });
});

describe('startup reconcile (SSE healthy)', () => {
    // Regression: a run can terminalize between the SSR seed query and the
    // client's first SSE frame. Its terminal event fired before the bus
    // connected, and the subject-scoped fetch only asks for live states, so the
    // run appears in NEITHER. It used to stay 'active' forever with SSE up.
    it('re-reads an adopted run the active listing does not confirm, and settles it', async () => {
        const seeded = run({ id: 'r1' });
        apiGetImpl.fn = async (url: string) => {
            if (url.includes('subjectId='))
                return { data: { items: [], page: { limit: 200, hasMore: false } } };
            return {
                data: run({
                    id: 'r1',
                    state: 'completed',
                    completedAt: '2026-08-18T10:05:00.000Z',
                }),
            };
        };

        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [seeded]);
        const settled = vi.fn();
        t.onSettled(settled);

        // let the startup reconcile's awaits drain
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
        anyChangeCb?.();

        expect(settled).toHaveBeenCalledTimes(1);
        expect(settled.mock.calls[0][0].state).toBe('completed');
        expect(t.isActive('trickplay-generation')).toBe(false);
        t.destroy();
    });
});

describe('progressFor with an unknown denominator', () => {
    it('reports an open-ended count when a stage has processed but no total', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [
            run({ id: 'r1', stages: [{ id: 's', processed: 3 }] as never }),
        ]);

        // Gating on `total > 0` hid a real, advancing count behind a bare
        // "Running" — a stage can report progress before it knows its total.
        expect(t.progressFor('trickplay-generation')).toEqual({ processed: 3, total: 0 });
        t.destroy();
    });

    it('still reports nothing when no progress has been recorded at all', async () => {
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const t = createSubjectRunsTracker('media-1', [run({ id: 'r2', stages: [] })]);
        expect(t.progressFor('trickplay-generation')).toBeUndefined();
        t.destroy();
    });
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('bounded reconciliation after startup', () => {
    it('settles a missed terminal event while SSE stays connected, then stops polling the idle subject', async () => {
        vi.useFakeTimers();
        let finished = false;
        const active = run({ id: 'late-terminal', state: 'pending' });
        const request = vi.fn(async (url: string) => ({
            data: url.includes('subjectId=')
                ? { items: finished ? [] : [active] }
                : { ...active, state: 'completed', completedAt: new Date().toISOString() },
        }));
        apiGetImpl.fn = request;
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', [active]);
        try {
            const settled = vi.fn();
            tracker.onSettled(settled);
            await vi.advanceTimersByTimeAsync(0);
            expect(request).toHaveBeenCalledTimes(1);
            expect(tracker.isActive(active.taskId)).toBe(true);
            finished = true;
            await vi.advanceTimersByTimeAsync(29999);
            expect(request).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(1);
            expect(bus.connected).toBe(true);
            expect(request.mock.calls[2][0]).toBe('/api/runs/late-terminal');
            expect(tracker.isActive(active.taskId)).toBe(false);
            expect(settled).toHaveBeenCalledTimes(1);
            expect(settled.mock.calls[0][0].state).toBe('completed');
            await vi.advanceTimersByTimeAsync(60000);
            expect(request).toHaveBeenCalledTimes(3);
        } finally {
            tracker.destroy();
        }
    });
    it('defers safety reconciliation while hidden and resumes when the active subject becomes visible', async () => {
        vi.useFakeTimers();
        const documentState = { visibilityState: 'hidden' };
        vi.stubGlobal('document', documentState);
        const active = run({ id: 'hidden-run' });
        const request = vi.fn(async () => ({ data: { items: [active] } }));
        apiGetImpl.fn = request;
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', [active]);
        try {
            await vi.advanceTimersByTimeAsync(60000);
            expect(request).toHaveBeenCalledTimes(1);
            documentState.visibilityState = 'visible';
            await vi.advanceTimersByTimeAsync(5000);
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            tracker.destroy();
        }
    });
    it('coalesces slow startup with timer ticks and ignores its response after destroy', async () => {
        vi.useFakeTimers();
        let finish: ((value: { data: unknown }) => void) | undefined;
        const request = vi.fn(
            () =>
                new Promise<{ data: unknown }>((resolve) => {
                    finish = resolve;
                }),
        );
        apiGetImpl.fn = request;
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', [run({ id: 'slow-run' })]);
        await vi.advanceTimersByTimeAsync(25000);
        expect(request).toHaveBeenCalledTimes(1);
        tracker.destroy();
        finish?.({ data: { items: [] } });
        await vi.advanceTimersByTimeAsync(0);
        expect(request).toHaveBeenCalledTimes(1);
        expect(bus.upsertRun).toHaveBeenCalledTimes(1);
    });
    it('does not adopt a canonical terminal response after its subject tracker is destroyed', async () => {
        vi.useFakeTimers();
        const active = run({ id: 'late-response' });
        let finish: ((value: { data: unknown }) => void) | undefined;
        apiGetImpl.fn = async (url) =>
            url.includes('subjectId=')
                ? { data: { items: [] } }
                : new Promise<{ data: unknown }>((resolve) => {
                      finish = resolve;
                  });
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', [active]);
        await vi.advanceTimersByTimeAsync(0);
        expect(finish).toBeTypeOf('function');
        tracker.destroy();
        finish?.({ data: { ...active, state: 'completed' } });
        await vi.advanceTimersByTimeAsync(0);
        expect(busRuns.get(active.id)?.state).toBe('active');
    });
    it('retains disconnected discovery polling even with no known active subject runs', async () => {
        vi.useFakeTimers();
        bus.connected = false;
        const request = vi.fn(async () => ({ data: { items: [] } }));
        apiGetImpl.fn = request;
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', []);
        try {
            await vi.advanceTimersByTimeAsync(5000);
            expect(request).toHaveBeenCalledTimes(2);
        } finally {
            tracker.destroy();
        }
    });
});

it.each(['pending', 'unavailable'] as const)(
    'does not unlock from listing absence with %s canonical evidence',
    async (evidence) => {
        vi.useFakeTimers();
        const active = run({ id: 'inconclusive' });
        let disappeared = false;
        apiGetImpl.fn = async (url) => ({
            data: url.includes('subjectId=')
                ? { items: disappeared ? [] : [active] }
                : evidence === 'pending'
                  ? active
                  : undefined,
        });
        const { createSubjectRunsTracker } = await import('./subject-runs.js');
        const tracker = createSubjectRunsTracker('media-1', [active]);
        try {
            const settled = vi.fn();
            tracker.onSettled(settled);
            await vi.advanceTimersByTimeAsync(0);
            disappeared = true;
            await vi.advanceTimersByTimeAsync(30000);
            expect(tracker.isActive(active.taskId)).toBe(true);
            expect(settled).not.toHaveBeenCalled();
        } finally {
            tracker.destroy();
        }
    },
);

it('bounds an unfinished response body and retries without accepting its obsolete late payload', async () => {
    vi.useFakeTimers();
    const active = run({ id: 'stalled-body' });
    let finish: ((value: { data: unknown }) => void) | undefined;
    const request = vi.fn(
        (_url: string) =>
            new Promise<{ data: unknown }>((resolve) => {
                finish = resolve;
            }),
    );
    apiGetImpl.fn = request;
    const { createSubjectRunsTracker } = await import('./subject-runs.js');
    const tracker = createSubjectRunsTracker('media-1', [active]);
    try {
        await vi.advanceTimersByTimeAsync(25000);
        expect(request).toHaveBeenCalledTimes(1);
        expect(tracker.isActive(active.taskId)).toBe(true);
        apiGetImpl.fn = async (url) => ({
            data: url.includes('subjectId=') ? { items: [] } : { ...active, state: 'failed' },
        });
        await vi.advanceTimersByTimeAsync(10000);
        expect(tracker.isActive(active.taskId)).toBe(false);
        expect(busRuns.get(active.id)?.state).toBe('failed');
        finish?.({ data: { items: [{ ...active, state: 'pending' }] } });
        await vi.advanceTimersByTimeAsync(0);
        expect(busRuns.get(active.id)?.state).toBe('failed');
    } finally {
        tracker.destroy();
    }
});

it('reconciles a missing native result after SSE completion and transport uncertainty, without certifying success early', async () => {
    vi.useFakeTimers();
    const { createSubjectRunsTracker } = await import('./subject-runs.js');
    const active = run({ id: 'result-pending' });
    const tracker = createSubjectRunsTracker('media-1', [active], ['trickplay-generation']);
    const settled = vi.fn();
    tracker.onSettled(settled);
    await vi.advanceTimersByTimeAsync(0);
    busRuns.set(active.id, { ...active, state: 'completed' });
    anyChangeCb?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toHaveBeenCalledOnce();
    expect(settled.mock.calls[0][0].result).toBeUndefined();
    const finished = {
        ...active,
        state: 'completed' as const,
        result: { success: true, itemsProcessed: 1 },
    };
    apiGetImpl.fn = async (url) => ({
        data: url.includes('subjectId=') ? { items: [] } : finished,
    });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(settled).toHaveBeenCalledTimes(2);
    expect(settled.mock.calls[1][0]).toEqual(finished);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toHaveBeenCalledTimes(2);
    tracker.destroy();
    vi.useRealTimers();
});
