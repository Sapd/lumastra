// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('./client.js', () => ({ apiGet: mocks.get, apiPost: mocks.post }));
import { recheckFileHealth, awaitFileHealthRecheck } from './file-health-recheck.js';
const FILE = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const run = (state = 'active', extra = {}) => ({
    data: { id: 'run_selected', taskId: 'media-probe', state, input: { fileId: FILE }, ...extra },
    error: null,
    status: 200,
});
beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.post.mockResolvedValue({ data: { runId: 'run_selected', deduped: false } });
});
afterEach(() => {
    vi.useRealTimers();
});
it('acceptance and 35 seconds of pending work never become success or a 30-second probe HTTP timeout', async () => {
    let state = run();
    mocks.get.mockImplementation(async () => state);
    let done = false;
    const accepted = vi.fn();
    const result = recheckFileHealth(FILE, new AbortController().signal, accepted).then((r) => {
        done = true;
        return r;
    });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(accepted).toHaveBeenCalledWith('run_selected');
    expect(done).toBe(false);
    state = run('completed', {
        result: {
            recheck: {
                fileId: FILE,
                outcome: 'warning',
                issues: [{ type: 'truncated_video', detected_at: '2026-10-24T00:00:00Z' }],
            },
        },
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await result).data?.outcome).toBe('warning');
});
it('aborting tracking settles promptly without claiming the queued run completed', async () => {
    mocks.get.mockResolvedValue(run());
    const controller = new AbortController();
    const pending = awaitFileHealthRecheck(FILE, 'run_selected', controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const result = await pending;
    expect(result.data).toBeNull();
    expect(result.error).toContain('may still be running');
});
it('rejects an unrelated broad run rather than following its result', async () => {
    mocks.get.mockResolvedValue(
        run('completed', {
            id: 'run_global',
            input: {},
            result: { recheck: { fileId: FILE, outcome: 'healthy', issues: [] } },
        }),
    );
    expect(
        await awaitFileHealthRecheck(FILE, 'run_global', new AbortController().signal),
    ).toMatchObject({ data: null, status: 409 });
    expect(mocks.get).toHaveBeenCalledTimes(1);
});
it('a cancelled or failed run is never healthy', async () => {
    for (const state of ['cancelled', 'failed']) {
        mocks.get.mockResolvedValue(run(state));
        expect(
            (await awaitFileHealthRecheck(FILE, 'run_selected', new AbortController().signal)).data
                ?.outcome,
        ).toBe(state === 'cancelled' ? 'cancelled' : 'error');
    }
});
it('a missing terminal payload is an error, never a stale zero warning count', async () => {
    mocks.get.mockResolvedValue(run('completed'));
    const result = await awaitFileHealthRecheck(FILE, 'run_selected', new AbortController().signal);
    expect(result.data).toBeNull();
    expect(result.error).toBeTruthy();
});

it('retries temporary poll failures before reporting the actual terminal result', async () => {
    mocks.get
        .mockResolvedValueOnce({ data: null, error: 'temporarily unavailable', status: 503 })
        .mockResolvedValueOnce({ data: null, error: 'network lost', status: 0 })
        .mockResolvedValue(
            run('completed', {
                result: { recheck: { fileId: FILE, outcome: 'healthy', issues: [] } },
            }),
        );
    const pending = awaitFileHealthRecheck(FILE, 'run_selected', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await pending).data?.outcome).toBe('healthy');
    expect(mocks.get).toHaveBeenCalledTimes(3);
});
it('bounds failed poll retries and reports lost tracking rather than a failed worker', async () => {
    mocks.get.mockResolvedValue({ data: null, error: 'gateway failure', status: 503 });
    const pending = awaitFileHealthRecheck(FILE, 'run_selected', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.error).toContain('may still be running');
    expect(mocks.get.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.get.mock.calls.length).toBeLessThanOrEqual(5);
});

it('authorization loss remains immediate after a temporary interruption', async () => {
    mocks.get
        .mockResolvedValueOnce({ data: null, error: 'temporarily unavailable', status: 503 })
        .mockResolvedValue({ data: null, error: 'Sign in again', status: 403 });
    const pending = awaitFileHealthRecheck(FILE, 'run_selected', new AbortController().signal);
    await vi.advanceTimersByTimeAsync(15000);
    expect(await pending).toMatchObject({ data: null, error: 'Sign in again', status: 403 });
    expect(mocks.get).toHaveBeenCalledTimes(2);
});

it.each([
    { id: 'run_other' },
    { taskId: 'other-task' },
    { input: { fileId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' } },
    {
        result: {
            recheck: {
                fileId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff',
                outcome: 'healthy',
                issues: [],
            },
        },
    },
])('rejects a mismatched run/task/file identity: %j', async (extra) => {
    mocks.get.mockResolvedValue(
        run('completed', {
            result: { recheck: { fileId: FILE, outcome: 'healthy', issues: [] } },
            ...extra,
        }),
    );
    expect(
        (await awaitFileHealthRecheck(FILE, 'run_selected', new AbortController().signal)).data,
    ).toBeNull();
});

it.each(['active', 'cancelling'])(
    'stops immediately on a %s run with a mismatched run/task/file identity',
    async (state) => {
        for (const extra of [
            { id: 'run_other' },
            { taskId: 'other-task' },
            { input: { fileId: 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff' } },
            { input: {} },
        ]) {
            mocks.get.mockReset();
            mocks.get.mockResolvedValue(run(state, extra));
            const controller = new AbortController();
            let settled = false;
            const pending = awaitFileHealthRecheck(FILE, 'run_selected', controller.signal).then(
                (result) => {
                    settled = true;
                    return result;
                },
            );
            await vi.advanceTimersByTimeAsync(0);
            const immediate = settled;
            controller.abort();
            expect(immediate).toBe(true);
            expect(await pending).toMatchObject({ data: null, status: 409 });
            await vi.advanceTimersByTimeAsync(5000);
            expect(mocks.get).toHaveBeenCalledTimes(1);
            controller.abort();
        }
    },
);
