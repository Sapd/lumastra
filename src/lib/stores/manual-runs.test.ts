// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ManualRun, ManualRunsResponse } from '$lib/schemas/manual-runs';

const getMyManualRuns = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/manual-runs', () => ({ getMyManualRuns }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const authFailed = vi.hoisted(() => ({ value: false }));
vi.mock('$lib/auth-monitor', () => ({ isAuthFailed: () => authFailed.value }));

import { manualRuns } from './manual-runs.svelte';
import { signalRunStartedIfPresent } from '$lib/api/run-started-signal';

const T0 = Date.parse('2026-09-23T12:00:00.000Z');
const KEY = 'v1:manual-runs:denis';
let serverClock = T0;

const run = (over: Partial<ManualRun>): ManualRun => ({
    id: 'r1',
    taskId: 'file-library-scan',
    title: 'File Library Scan',
    detail: 'Kids',
    state: 'active',
    startedAt: new Date(T0 - 600_000).toISOString(),
    ...over,
});
/** A terminal run that ended `agoMs` before the server's current time. */
const ended = (
    state: ManualRun['state'],
    agoMs: number,
    over: Partial<ManualRun> = {},
): ManualRun => run({ state, completedAt: new Date(serverClock - agoMs).toISOString(), ...over });
const answer = (runs: ManualRun[]): { data: ManualRunsResponse; error: null } => ({
    data: { runs, serverTime: new Date(serverClock).toISOString() },
    error: null,
});
/** A returning visitor: something was stored by an earlier page load. */
function returning(announced: Record<string, [string, number]> = {}): void {
    localStorage.setItem(
        KEY,
        JSON.stringify({ lastServerTime: new Date(T0 - 3_600_000).toISOString(), announced }),
    );
}

async function tick(ms: number): Promise<void> {
    serverClock += ms;
    await vi.advanceTimersByTimeAsync(ms);
}

describe('manual-run tracker', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.clearAllMocks();
        localStorage.clear();
        serverClock = T0;
        authFailed.value = false;
    });
    afterEach(() => {
        manualRuns.stop();
        vi.useRealTimers();
    });

    it('stops polling for good once the session is declared expired', async () => {
        getMyManualRuns.mockResolvedValue(answer([]));
        manualRuns.start('denis');
        await tick(0);
        expect(getMyManualRuns).toHaveBeenCalledTimes(1);

        authFailed.value = true;
        await tick(30_000); // the scheduled idle poll fires, sees the flag, sends nothing
        await tick(120_000);
        manualRuns.kick();
        await tick(1_000);
        expect(getMyManualRuns).toHaveBeenCalledTimes(1);
    });

    it('does not start a poll loop when the session is already expired', async () => {
        authFailed.value = true;
        manualRuns.start('denis');
        await tick(120_000);
        expect(getMyManualRuns).not.toHaveBeenCalled();
    });

    it('shows a live run, then announces its end exactly once', async () => {
        getMyManualRuns.mockResolvedValue(answer([run({ processed: 10, total: 100 })]));
        manualRuns.start('denis');
        await tick(0);
        expect(manualRuns.runs.map((r) => r.id)).toEqual(['r1']);

        getMyManualRuns.mockImplementation(async () => answer([ended('completed', 1_000)]));
        await tick(2_500);
        expect(manualRuns.runs).toEqual([]);
        expect(toasts.success).toHaveBeenCalledWith('File Library Scan · Kids finished');

        await tick(30_000); // the overlapping window returns it again: not re-announced
        expect(toasts.success).toHaveBeenCalledTimes(1);
    });

    it('asks for an OVERLAPPING window (last server time minus 10 min)', async () => {
        returning();
        getMyManualRuns.mockResolvedValue(answer([]));
        manualRuns.start('denis');
        await tick(0);
        expect(getMyManualRuns).toHaveBeenLastCalledWith(
            new Date(T0 - 3_600_000 - 600_000).toISOString(),
        );
    });

    it('announces a settled failure with its reason, and a stop as "stopped"', async () => {
        returning();
        getMyManualRuns.mockResolvedValue(
            answer([
                ended('failed', 120_000, { id: 'a', error: 'NFS timeout' }),
                ended('cancelled', 1_000, { id: 'b', detail: undefined }),
            ]),
        );
        manualRuns.start('denis');
        await tick(0);
        expect(toasts.error).toHaveBeenCalledWith('File Library Scan · Kids failed: NFS timeout');
        expect(toasts.info).toHaveBeenCalledWith('File Library Scan stopped');
    });

    it('a failure inside the retry grace that a retry then completes is announced ONLY as finished', async () => {
        returning();
        getMyManualRuns.mockImplementation(async () => answer([ended('failed', 0)]));
        manualRuns.start('denis');
        await tick(0);
        expect(toasts.error).not.toHaveBeenCalled();

        getMyManualRuns.mockImplementation(async () => answer([run({ state: 'active' })]));
        await tick(2_500); // grace keeps the fast cadence
        getMyManualRuns.mockImplementation(async () => answer([ended('completed', 0)]));
        await tick(2_500);
        expect(toasts.error).not.toHaveBeenCalled();
        expect(toasts.success).toHaveBeenCalledWith('File Library Scan · Kids finished');
    });

    it('a failure already announced that a slow retry later completes is announced again as finished', async () => {
        returning({ r1: ['failed', Date.now()] });
        getMyManualRuns.mockResolvedValue(answer([ended('completed', 0)]));
        manualRuns.start('denis');
        await tick(0);
        expect(toasts.success).toHaveBeenCalledWith('File Library Scan · Kids finished');
    });

    it('after a RELOAD: announces what finished while away, never what was already announced', async () => {
        returning({ old: ['completed', Date.now()] });
        getMyManualRuns.mockResolvedValue(
            answer([
                ended('completed', 5_000, { id: 'old' }),
                ended('completed', 5_000, { id: 'new' }),
            ]),
        );
        manualRuns.start('denis');
        await tick(0);
        expect(toasts.success).toHaveBeenCalledTimes(1);

        // A second tab (or the next reload) sees the shared record too.
        manualRuns.stop();
        manualRuns.start('denis');
        await tick(0);
        expect(toasts.success).toHaveBeenCalledTimes(1);
    });

    it('on a first visit (nothing stored) announces nothing historic', async () => {
        getMyManualRuns.mockResolvedValue(answer([ended('completed', 60_000)]));
        manualRuns.start('denis');
        await tick(0);
        expect(getMyManualRuns).toHaveBeenLastCalledWith(undefined);
        expect(toasts.success).not.toHaveBeenCalled();
    });

    it('a fan-out parent is neither listed nor announced — its children are', async () => {
        returning();
        getMyManualRuns.mockResolvedValue(
            answer([
                run({ id: 'parent', detail: undefined }),
                run({ id: 'child', parentRunId: 'parent', detail: 'Anime' }),
            ]),
        );
        manualRuns.start('denis');
        await tick(0);
        expect(manualRuns.runs.map((r) => r.id)).toEqual(['child']);

        getMyManualRuns.mockImplementation(async () =>
            answer([
                ended('completed', 0, { id: 'parent', detail: undefined }),
                ended('completed', 0, { id: 'child', parentRunId: 'parent', detail: 'Anime' }),
            ]),
        );
        await tick(2_500);
        expect(toasts.success).toHaveBeenCalledTimes(1);
        expect(toasts.success).toHaveBeenCalledWith('File Library Scan · Anime finished');
    });

    it('polls at once when an API response reports it started a run — also during a poll', async () => {
        getMyManualRuns.mockResolvedValue(answer([]));
        manualRuns.start('denis');
        await tick(0);
        expect(getMyManualRuns).toHaveBeenCalledTimes(1);

        signalRunStartedIfPresent({ jobId: 'run_1', message: 'Scan started' });
        await tick(400); // debounce, far below the 30s idle cadence
        expect(getMyManualRuns).toHaveBeenCalledTimes(2);

        signalRunStartedIfPresent({ message: 'saved' }); // no run id: ignored
        await tick(400);
        expect(getMyManualRuns).toHaveBeenCalledTimes(2);

        // A kick that lands while a poll is in flight re-polls after it.
        let release!: () => void;
        getMyManualRuns.mockImplementationOnce(
            () => new Promise((r) => (release = () => r(answer([])))),
        );
        await tick(30_000); // idle poll starts and hangs
        signalRunStartedIfPresent({ runId: 'run_2' });
        await tick(400);
        const before = getMyManualRuns.mock.calls.length;
        release();
        await tick(0);
        expect(getMyManualRuns.mock.calls.length).toBe(before + 1);
    });

    it('a stop + start during an in-flight poll does not leave the tracker dead', async () => {
        let release!: () => void;
        getMyManualRuns.mockImplementationOnce(
            () => new Promise((r) => (release = () => r(answer([])))),
        );
        manualRuns.start('denis');
        manualRuns.stop();
        getMyManualRuns.mockResolvedValue(answer([run({})]));
        manualRuns.start('denis');
        release();
        await tick(0);
        expect(manualRuns.runs.map((r) => r.id)).toEqual(['r1']);
    });

    // Prod 2026-09-25: 5,855 GET /api/me/manual-runs in ~34h — every open tab
    // polled every 30s all night. A hidden tab shows nothing; the visible-kick
    // plus the overlapping window catches up everything it missed.
    it('does not poll while the tab is hidden, and catches up at once when it becomes visible', async () => {
        const setHidden = (hidden: boolean) => {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => (hidden ? 'hidden' : 'visible'),
            });
            document.dispatchEvent(new Event('visibilitychange'));
        };
        try {
            returning();
            getMyManualRuns.mockResolvedValue(answer([]));
            manualRuns.start('denis');
            await tick(0);
            expect(getMyManualRuns).toHaveBeenCalledTimes(1);

            setHidden(true);
            await tick(10 * 60_000);
            expect(getMyManualRuns).toHaveBeenCalledTimes(1);

            getMyManualRuns.mockResolvedValue(answer([ended('completed', 5 * 60_000)]));
            setHidden(false);
            await tick(1_000);
            expect(getMyManualRuns).toHaveBeenCalledTimes(2);
            expect(toasts.success).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(document, 'visibilityState', {
                configurable: true,
                get: () => 'visible',
            });
        }
    });
});
