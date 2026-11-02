// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Fake EventSource ──────────────────────────────────────────────────────────
let fakeESInstances: FakeEventSource[] = [];

class FakeEventSource {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;

    readonly url: string;
    readyState: number = FakeEventSource.CONNECTING;
    onopen: ((e: Event) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    private _listeners: Map<string, Array<(e: MessageEvent) => void>> = new Map();
    closed = false;

    constructor(url: string) {
        this.url = url;
        fakeESInstances.push(this);
    }

    addEventListener(type: string, listener: (e: MessageEvent) => void): void {
        if (!this._listeners.has(type)) this._listeners.set(type, []);
        this._listeners.get(type)!.push(listener);
    }

    dispatch(type: string, data: unknown): void {
        const listeners = this._listeners.get(type) ?? [];
        for (const l of listeners) {
            l({ data: JSON.stringify(data) } as MessageEvent);
        }
    }

    close(): void {
        this.readyState = FakeEventSource.CLOSED;
        this.closed = true;
    }
}

// ── Module isolation helpers ──────────────────────────────────────────────────
vi.mock('$app/environment', () => ({ browser: true }));

// Fetch mock: return a valid empty collection for seedActiveRuns.
function setupFetchMock(): void {
    global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ items: [], page: { limit: 200, hasMore: false } }),
    } as Response);
}

async function freshBus(): Promise<typeof import('./run-sse-bus.js')> {
    vi.resetModules();
    // The `$app/environment` mock lives at the top of this file. It used to be
    // repeated here too, which read as "re-arm the mock after resetModules" but
    // never did that: vi.mock is hoisted to module scope regardless of where it
    // is written, so this was the same single registration. Vitest 5 rejects the
    // nested form outright rather than silently hoisting it.
    setupFetchMock();
    return import('./run-sse-bus.js');
}

beforeEach(() => {
    fakeESInstances = [];
    // Install FakeEventSource globally before each test
    vi.stubGlobal('EventSource', FakeEventSource);
    setupFetchMock();
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('runSSEBus refcount', () => {
    it('first connect() opens exactly one EventSource; second connect() does NOT open another', async () => {
        const { runSSEBus: bus } = await freshBus();

        bus.connect();
        expect(fakeESInstances).toHaveLength(1);

        bus.connect();
        // Refcount is now 2 — still only one EventSource
        expect(fakeESInstances).toHaveLength(1);
        expect(fakeESInstances[0].closed).toBe(false);
    });

    it('two connects, first disconnect keeps connection open; second disconnect closes it', async () => {
        const { runSSEBus: bus } = await freshBus();

        bus.connect(); // refcount → 1
        bus.connect(); // refcount → 2

        const es = fakeESInstances[0];
        expect(es.closed).toBe(false);

        bus.disconnect(); // refcount → 1 — must NOT close
        expect(es.closed).toBe(false);
        expect(fakeESInstances).toHaveLength(1); // no new instance

        bus.disconnect(); // refcount → 0 — MUST close
        expect(es.closed).toBe(true);
    });

    it('stray disconnect at refcount 0 is a no-op; subsequent connect opens exactly one', async () => {
        const { runSSEBus: bus } = await freshBus();

        // Should not throw and should not produce a negative refcount
        expect(() => bus.disconnect()).not.toThrow();
        expect(fakeESInstances).toHaveLength(0);

        bus.connect(); // should open normally
        expect(fakeESInstances).toHaveLength(1);
        expect(fakeESInstances[0].closed).toBe(false);
    });
});

const RUN_EVENT = {
    specversion: '1.0',
    id: 'evt-1',
    source: '/lumastra/orchestrator',
    type: 'org.lumastra.task.run.started',
    subject: 'run-1',
    time: '2026-08-18T10:00:00.000Z',
    datacontenttype: 'application/json',
    data: {
        id: 'run-1',
        taskId: 'trickplay-generation',
        label: 'Trickplay',
        state: 'active',
        scope: { subjectType: 'mediaItem', subjectId: 'media-1' },
        trigger: { kind: 'manual' },
        actor: { type: 'user' },
        startedAt: '2026-08-18T10:00:00.000Z',
        heartbeatAt: '2026-08-18T10:00:01.000Z',
        stages: [],
    },
};

describe('runSSEBus REST seed', () => {
    it('seeds active runs from items in the collection envelope', async () => {
        const { runSSEBus: bus } = await freshBus();
        const seeded = { ...RUN_EVENT.data, input: { mediaItemId: 'media-1' } };
        vi.mocked(fetch).mockResolvedValue({
            ok: true,
            json: async () => ({ items: [seeded], page: { limit: 200, hasMore: false } }),
        } as Response);

        bus.connect();
        await vi.waitFor(() => expect(bus.runs.get('run-1')).toEqual(seeded));
        bus.disconnect();
    });
});

describe('runSSEBus lifecycle ingestion', () => {
    it('adds a run to the map from a run.started frame', async () => {
        const { runSSEBus: bus } = await freshBus();
        bus.connect();
        fakeESInstances[0].dispatch('org.lumastra.task.run.started', RUN_EVENT);

        expect(bus.runs.get('run-1')?.state).toBe('active');
    });

    it('applies a terminal frame even though heartbeatAt predates completedAt', async () => {
        const { runSSEBus: bus } = await freshBus();
        bus.connect();
        fakeESInstances[0].dispatch('org.lumastra.task.run.started', RUN_EVENT);

        fakeESInstances[0].dispatch('org.lumastra.task.run.completed', {
            ...RUN_EVENT,
            type: 'org.lumastra.task.run.completed',
            data: {
                ...RUN_EVENT.data,
                state: 'completed',
                // Deliberately OLDER than the active frame's heartbeatAt.
                heartbeatAt: '2026-08-18T10:00:00.500Z',
                completedAt: '2026-08-18T10:05:00.000Z',
            },
        });

        expect(bus.runs.get('run-1')?.state).toBe('completed');
    });

    it('upsertRun does not clobber a terminal run with a stale active one', async () => {
        const { runSSEBus: bus } = await freshBus();
        bus.connect();
        fakeESInstances[0].dispatch('org.lumastra.task.run.completed', {
            ...RUN_EVENT,
            type: 'org.lumastra.task.run.completed',
            data: {
                ...RUN_EVENT.data,
                state: 'completed',
                completedAt: '2026-08-18T10:05:00.000Z',
            },
        });

        bus.upsertRun({ ...RUN_EVENT.data, state: 'active' } as never);

        expect(bus.runs.get('run-1')?.state).toBe('completed');
    });
});

describe('runSSEBus preserves REST-only fields across lifecycle frames', () => {
    // Lifecycle frames carry the redacted RunEvent projection, which has no
    // `input` and no `result`. The bus map is also filled from REST, which DOES
    // carry them, and the admin runs UI reads both (RunCard's item-context chip
    // reads run.input; run-items-processed prefers result.itemsProcessed).
    // Replacing wholesale silently blanks those surfaces the moment any frame
    // lands, so the merge has to preserve fields the projection cannot carry.
    it('keeps input and result when a lifecycle frame updates an existing run', async () => {
        const { runSSEBus: bus } = await freshBus();
        bus.connect();

        bus.upsertRun({
            ...RUN_EVENT.data,
            state: 'active',
            input: { mediaItemId: 'media-1' },
            result: { itemsProcessed: 42 },
        } as never);

        fakeESInstances[0].dispatch('org.lumastra.task.run.completed', {
            ...RUN_EVENT,
            type: 'org.lumastra.task.run.completed',
            data: {
                ...RUN_EVENT.data,
                state: 'completed',
                completedAt: '2026-08-18T10:05:00.000Z',
            },
        });

        const merged = bus.runs.get('run-1') as unknown as {
            state: string;
            input?: unknown;
            result?: unknown;
        };
        expect(merged.state).toBe('completed');
        expect(merged.input).toEqual({ mediaItemId: 'media-1' });
        expect(merged.result).toEqual({ itemsProcessed: 42 });
    });

    it('keeps a REST count summary when a legacy terminal frame has no summary', async () => {
        const { runSSEBus: bus } = await freshBus();
        bus.connect();
        bus.upsertRun({
            ...RUN_EVENT.data,
            state: 'active',
            countSummary: { count: 663, unit: 'frames' },
        } as never);

        fakeESInstances[0].dispatch('org.lumastra.task.run.completed', {
            ...RUN_EVENT,
            type: 'org.lumastra.task.run.completed',
            data: {
                ...RUN_EVENT.data,
                state: 'completed',
                completedAt: '2026-08-18T10:05:00.000Z',
            },
        });

        expect(bus.runs.get('run-1')?.countSummary).toEqual({ count: 663, unit: 'frames' });
    });
});
