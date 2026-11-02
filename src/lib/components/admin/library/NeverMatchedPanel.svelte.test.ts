// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    listUnmatchedFiles: vi.fn(),
    keepPersonalMedia: vi.fn(),
    restoreKeptPersonalMedia: vi.fn(),
    getUnmatchedFileChildren: vi.fn(),
    startAutoIdentify: vi.fn(),
    dismissUnmatchedFile: vi.fn(),
    restoreUnmatchedFile: vi.fn(),
}));
const runApi = vi.hoisted(() => ({ poll: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet: runApi.poll }));
const modalState = vi.hoisted(() => ({ open: vi.fn() }));
const toastState = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn() }));
let keptState = false;

vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/stores/modal.store', () => ({ modals: modalState }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: toastState }));

import NeverMatchedPanel from './NeverMatchedPanel.svelte';

const item = {
    id: '740fee5d-dd69-4c69-9b4c-d0b02a6a5ed0',
    title: 'Family Video',
    media_type: 'movie',
    release_year: 2020,
    overview: null,
    custom_poster_url: null,
    custom_backdrop_url: null,
    custom_logo_url: null,
    custom_thumb_url: null,
    metadata_locked: false,
    metadata_locked_by: null,
    metadata_locked_at: null,
    created_at: '2026-10-26T12:00:00.000Z',
    episode_count: 0,
    season_count: 0,
    file_path: '/library/Family Video.mkv',
};

function page(items: (typeof item)[], total = items.length, offset = 0) {
    return { data: { items, page: { total, limit: 25, offset } }, error: null };
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

beforeEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    keptState = false;
    api.listUnmatchedFiles.mockImplementation(
        async (opts: { disposition?: string; offset?: number }) => {
            const rows =
                opts.disposition === 'kept' ? (keptState ? [item] : []) : keptState ? [] : [item];
            return page(rows, rows.length, opts.offset ?? 0);
        },
    );
    api.keepPersonalMedia.mockImplementation(async () => {
        keptState = true;
        return { data: { disposition: 'kept' }, error: null };
    });
    api.restoreKeptPersonalMedia.mockImplementation(async () => {
        keptState = false;
        return { data: { restored: true }, error: null };
    });
    api.getUnmatchedFileChildren.mockResolvedValue({ data: { seasons: [] }, error: null });
});

afterEach(cleanup);

describe('NeverMatchedPanel Keep disposition', () => {
    it('confirms before Keep, retains the row on failure, and reloads it in Kept for reversal', async () => {
        const onTotal = vi.fn();
        render(NeverMatchedPanel, { props: { ontotalchange: onTotal } });
        expect(await screen.findByText('Family Video')).toBeTruthy();

        const keepButton = 'Keep Family Video as personal media';
        await fireEvent.click(screen.getByRole('button', { name: keepButton }));
        expect(modalState.open).toHaveBeenCalledTimes(1);
        expect(api.keepPersonalMedia).not.toHaveBeenCalled();

        const confirm = modalState.open.mock.calls[0][1] as { onConfirm: () => Promise<void> };
        api.keepPersonalMedia.mockResolvedValueOnce({ data: null, error: 'conflict' });
        await confirm.onConfirm();
        expect(toastState.error).toHaveBeenCalled();
        expect(screen.getByText('Family Video')).toBeTruthy();

        await fireEvent.click(screen.getByRole('button', { name: keepButton }));
        const confirmAgain = modalState.open.mock.calls[1][1] as {
            onConfirm: () => Promise<void>;
        };
        await confirmAgain.onConfirm();
        await waitFor(() => expect(screen.queryByText('Family Video')).toBeNull());

        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Family Video')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Return to matching' })).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Identify' })).toBeNull();
        expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
            expect.objectContaining({ disposition: 'kept' }),
        );

        await fireEvent.click(screen.getByRole('button', { name: 'Return to matching' }));
        await waitFor(() => expect(screen.queryByText('Family Video')).toBeNull());
        expect(api.restoreKeptPersonalMedia).toHaveBeenCalledWith(item.id);
        await waitFor(() => expect(onTotal).toHaveBeenLastCalledWith(1, false));
    });

    it('hides stale actions during a view switch and after the replacement load fails', async () => {
        render(NeverMatchedPanel);
        expect(await screen.findByText('Family Video')).toBeTruthy();
        const keptLoad = deferred<ReturnType<typeof page>>();
        api.listUnmatchedFiles.mockImplementationOnce(async () => keptLoad.promise);
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(screen.getByText('Family Video')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Identify' })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Return to matching' })).toBeNull();
        keptLoad.resolve({ data: null, error: 'Kept request failed' } as never);
        await waitFor(() => expect(toastState.error).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'Return to matching' })).toBeNull();
        expect(
            screen.queryByRole('button', { name: 'Keep Family Video as personal media' }),
        ).toBeNull();
    });

    it('does not expose selection or bulk removal for kept rows while Needs a match is loading', async () => {
        keptState = true;
        api.listUnmatchedFiles.mockImplementation(async (opts: { disposition?: string }) =>
            opts.disposition === 'kept' ? page([item]) : page([]),
        );
        render(NeverMatchedPanel);
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Family Video')).toBeTruthy();

        const unresolvedLoad = deferred<ReturnType<typeof page>>();
        api.listUnmatchedFiles.mockImplementationOnce(async () => unresolvedLoad.promise);
        await fireEvent.click(screen.getByRole('button', { name: 'Needs a match' }));
        const selectAll = screen.getByRole('checkbox', { name: /Select all/i });
        expect((selectAll as HTMLInputElement).disabled).toBe(true);
        expect(screen.queryByRole('checkbox', { name: /Select Family Video/i })).toBeNull();
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
        unresolvedLoad.resolve({ data: null, error: 'load failed' } as never);
        await waitFor(() => expect(toastState.error).toHaveBeenCalled());
        expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
        expect(api.dismissUnmatchedFile).not.toHaveBeenCalled();
    });

    it('fences pending Keep and Restore completions across view changes', async () => {
        render(NeverMatchedPanel);
        expect(await screen.findByText('Family Video')).toBeTruthy();
        const keepResult = deferred<{ data: { disposition: string }; error: null }>();
        api.keepPersonalMedia.mockReturnValueOnce(keepResult.promise);
        await fireEvent.click(
            screen.getByRole('button', { name: 'Keep Family Video as personal media' }),
        );
        const confirmKeep = modalState.open.mock.calls.at(-1)![1] as {
            onConfirm: () => Promise<void>;
        };
        const keepAction = confirmKeep.onConfirm();
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        keptState = true;
        keepResult.resolve({ data: { disposition: 'kept' }, error: null });
        await keepAction;
        expect(await screen.findByRole('button', { name: 'Return to matching' })).toBeTruthy();

        const restoreResult = deferred<{ data: { restored: boolean }; error: null }>();
        api.restoreKeptPersonalMedia.mockReturnValueOnce(restoreResult.promise);
        const restoreActionPromise = fireEvent.click(
            screen.getByRole('button', { name: 'Return to matching' }),
        );
        await restoreActionPromise;
        // Let the async action start before switching the scope.
        await waitFor(() => expect(api.restoreKeptPersonalMedia).toHaveBeenCalledWith(item.id));
        await fireEvent.click(screen.getByRole('button', { name: 'Needs a match' }));
        keptState = false;
        restoreResult.resolve({ data: { restored: true }, error: null });
        await waitFor(() => expect(screen.getByRole('button', { name: 'Identify' })).toBeTruthy());
        expect(screen.getByText('Family Video')).toBeTruthy();
    });

    it('does not let a pre-mutation refresh resurrect a row after Keep commits', async () => {
        render(NeverMatchedPanel);
        expect(await screen.findByText('Family Video')).toBeTruthy();
        const staleRefresh = deferred<ReturnType<typeof page>>();
        api.listUnmatchedFiles.mockImplementationOnce(async () => staleRefresh.promise);
        await fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
        await fireEvent.click(
            screen.getByRole('button', { name: 'Keep Family Video as personal media' }),
        );
        const confirm = modalState.open.mock.calls.at(-1)![1] as { onConfirm: () => Promise<void> };
        await confirm.onConfirm();
        expect(screen.queryByText('Family Video')).toBeNull();
        staleRefresh.resolve(page([item]));
        await waitFor(() => expect(api.listUnmatchedFiles).toHaveBeenCalledTimes(2));
        expect(screen.queryByText('Family Video')).toBeNull();
    });

    it('surfaces and retries an unresolved badge refresh separately from committed Restore', async () => {
        const onTotal = vi.fn();
        keptState = true;
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; limit?: number }) => {
                if (opts.disposition === 'kept') return keptState ? page([item]) : page([]);
                if (opts.limit === 1) return { data: null, error: 'count unavailable' };
                return page([item]);
            },
        );
        render(NeverMatchedPanel, { props: { ontotalchange: onTotal } });
        expect(await screen.findByText('Family Video')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Family Video')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Return to matching' }));
        await waitFor(() => expect(toastState.success).toHaveBeenCalled());
        expect(toastState.error).not.toHaveBeenCalled();
        const retry = await screen.findByRole('button', { name: 'Retry' });
        api.listUnmatchedFiles.mockImplementation(async (opts: { disposition?: string }) =>
            opts.disposition === 'kept' ? page([]) : page([item]),
        );
        await fireEvent.click(retry);
        await waitFor(() => expect(onTotal).toHaveBeenLastCalledWith(1, false));
    });

    it('discards a deferred count after clearing its search filter', async () => {
        keptState = true;
        const staleCount = deferred<ReturnType<typeof page>>();
        let countRequests = 0;
        const onTotal = vi.fn();
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; limit?: number; q?: string }) => {
                if (opts.disposition === 'kept') return keptState ? page([item]) : page([]);
                if (opts.limit === 1) {
                    if (opts.q === 'Family')
                        return countRequests++ === 0 ? staleCount.promise : page([], 8);
                    return page([], 4);
                }
                return page([item], 4);
            },
        );
        render(NeverMatchedPanel, { props: { ontotalchange: onTotal } });
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Family Video')).toBeTruthy();
        const search = screen.getByRole('searchbox');
        await fireEvent.input(search, { target: { value: 'Family' } });
        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
                expect.objectContaining({ q: 'Family', disposition: 'kept' }),
            ),
        );
        await waitFor(() => expect(countRequests).toBe(1));
        await fireEvent.click(screen.getAllByRole('button', { name: 'Return to matching' })[0]);
        await waitFor(() => expect(countRequests).toBe(2));
        await fireEvent.input(search, { target: { value: '' } });
        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
                expect.objectContaining({ q: undefined, disposition: 'unresolved' }),
            ),
        );
        staleCount.resolve(page([], 99));
        await Promise.resolve();
        await waitFor(() => expect(onTotal).toHaveBeenLastCalledWith(4, false));
        expect(onTotal).not.toHaveBeenCalledWith(99, true);
    });

    it('discards a deferred unresolved count when the host library changes', async () => {
        keptState = true;
        const staleCount = deferred<ReturnType<typeof page>>();
        let countRequests = 0;
        const onTotal = vi.fn();
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; limit?: number; libraryGroupId?: string }) => {
                if (opts.disposition === 'kept') return keptState ? page([item]) : page([]);
                if (opts.limit === 1)
                    return countRequests++ === 0 ? staleCount.promise : page([], 8);
                return page([item], opts.libraryGroupId === 'library-two' ? 8 : 3);
            },
        );
        const view = render(NeverMatchedPanel, {
            props: { libraryGroupId: 'library-one', ontotalchange: onTotal },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Family Video')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Return to matching' }));
        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenCalledWith(
                expect.objectContaining({ limit: 1, libraryGroupId: 'library-one' }),
            ),
        );
        await view.rerender({
            libraryGroupId: 'library-two',
            ontotalchange: onTotal,
        });
        await waitFor(() => expect(onTotal).toHaveBeenLastCalledWith(8, false));
        staleCount.resolve(page([], 99));
        await Promise.resolve();
        expect(onTotal).not.toHaveBeenCalledWith(99, false);
        expect(onTotal).toHaveBeenLastCalledWith(8, false);
    });

    it('lets only the newest overlapping unresolved count refresh update the badge', async () => {
        const secondItem = {
            ...item,
            id: '840fee5d-dd69-4c69-9b4c-d0b02a6a5ed0',
            title: 'Other Video',
        };
        const keptIds = new Set([item.id, secondItem.id]);
        const counts = [deferred<ReturnType<typeof page>>(), deferred<ReturnType<typeof page>>()];
        let countCalls = 0;
        const onTotal = vi.fn();
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; limit?: number }) => {
                if (opts.limit === 1) return counts[countCalls++].promise;
                if (opts.disposition === 'kept')
                    return page([item, secondItem].filter((row) => keptIds.has(row.id)));
                return page([item], 3);
            },
        );
        api.restoreKeptPersonalMedia.mockImplementation(async (id: string) => {
            keptIds.delete(id);
            return { data: { restored: true }, error: null };
        });
        render(NeverMatchedPanel, { props: { ontotalchange: onTotal } });
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Family Video')).toBeTruthy();
        expect(screen.getByText('Other Video')).toBeTruthy();

        await fireEvent.click(screen.getAllByRole('button', { name: 'Return to matching' })[0]);
        await waitFor(() => expect(countCalls).toBe(1));
        await waitFor(() => expect(screen.queryByText('Family Video')).toBeNull());
        await fireEvent.click(screen.getByRole('button', { name: 'Return to matching' }));
        await waitFor(() => expect(countCalls).toBe(2));
        counts[1].resolve(page([], 20));
        await waitFor(() => expect(onTotal).toHaveBeenCalledWith(20, false));
        counts[0].resolve(page([], 10));
        await Promise.resolve();
        expect(onTotal).not.toHaveBeenCalledWith(10, false);
        expect(onTotal).toHaveBeenLastCalledWith(20, false);
    });

    it('backs up from an empty later Kept page after restoring its last row', async () => {
        keptState = true;
        const tail = {
            ...item,
            id: '840fee5d-dd69-4c69-9b4c-d0b02a6a5ed0',
            title: 'Last Kept Item',
        };
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; offset?: number }) => {
                const offset = opts.offset ?? 0;
                if (opts.disposition !== 'kept') return page([], 1, offset);
                if (keptState && offset === 25) return page([tail], 26, 25);
                if (!keptState && offset === 25) return page([], 25, 25);
                return page(
                    Array.from({ length: 25 }, (_, i) => ({
                        ...item,
                        id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
                        title: `Kept ${i}`,
                    })),
                    keptState ? 26 : 25,
                    0,
                );
            },
        );
        render(NeverMatchedPanel);
        await fireEvent.click(screen.getByRole('button', { name: 'Kept as personal' }));
        expect(await screen.findByText('Kept 0')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(await screen.findByText('Last Kept Item')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Return to matching' }));
        await waitFor(() =>
            expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
                expect.objectContaining({ disposition: 'kept', offset: 0 }),
            ),
        );
        expect(screen.getByRole('button', { name: 'Kept as personal' })).toBeTruthy();
        expect(screen.queryByText('Last Kept Item')).toBeNull();
        expect(screen.getByText('Kept 0')).toBeTruthy();
    });

    it('loads the last valid unresolved page after Keeping its final row', async () => {
        const rows = Array.from({ length: 26 }, (_, index) => ({
            ...item,
            id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            title: index === 25 ? 'Last Unresolved Item' : `Unresolved ${index}`,
        }));
        let keptId: string | null = null;
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; offset?: number; limit?: number }) => {
                if (opts.limit === 1) return page([], 25);
                const unresolved = rows.filter((row) => row.id !== keptId);
                const available =
                    opts.disposition === 'kept'
                        ? rows.filter((row) => row.id === keptId)
                        : unresolved;
                const offset = opts.offset ?? 0;
                return page(available.slice(offset, offset + 25), available.length, offset);
            },
        );
        api.keepPersonalMedia.mockImplementation(async (id: string) => {
            keptId = id;
            return { data: { disposition: 'kept' }, error: null };
        });
        render(NeverMatchedPanel);
        expect(await screen.findByText('Unresolved 0')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Next' }));
        expect(await screen.findByText('Last Unresolved Item')).toBeTruthy();
        await fireEvent.click(
            screen.getByRole('button', { name: 'Keep Last Unresolved Item as personal media' }),
        );
        const confirm = modalState.open.mock.calls.at(-1)![1] as { onConfirm: () => Promise<void> };
        await confirm.onConfirm();
        expect(await screen.findByText('Unresolved 0')).toBeTruthy();
        expect(screen.queryByText('Last Unresolved Item')).toBeNull();
        expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
            expect.objectContaining({ disposition: 'unresolved', offset: 0 }),
        );
    });

    it('reloads the first page when Keeping its 25 visible rows would hide the 26th', async () => {
        const rows = Array.from({ length: 26 }, (_, index) => ({
            ...item,
            id: `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
            title: `First page ${index}`,
        }));
        const keptIds = new Set<string>();
        api.listUnmatchedFiles.mockImplementation(
            async (opts: { disposition?: string; offset?: number; limit?: number }) => {
                const unresolved = rows.filter((row) => !keptIds.has(row.id));
                const available =
                    opts.disposition === 'kept'
                        ? rows.filter((row) => keptIds.has(row.id))
                        : unresolved;
                const offset = opts.offset ?? 0;
                return page(available.slice(offset, offset + 25), available.length, offset);
            },
        );
        api.keepPersonalMedia.mockImplementation(async (id: string) => {
            keptIds.add(id);
            return { data: { disposition: 'kept' }, error: null };
        });
        render(NeverMatchedPanel);
        expect(await screen.findByText('First page 0')).toBeTruthy();
        expect(screen.getByText('First page 24')).toBeTruthy();
        expect(screen.queryByText('First page 25')).toBeNull();

        for (let index = 0; index < 25; index++) {
            const title = `First page ${index}`;
            await fireEvent.click(
                screen.getByRole('button', { name: `Keep ${title} as personal media` }),
            );
            const confirm = modalState.open.mock.calls.at(-1)![1] as {
                onConfirm: () => Promise<void>;
            };
            await confirm.onConfirm();
        }

        expect(await screen.findByText('First page 25')).toBeTruthy();
        expect(screen.queryByText('First page 24')).toBeNull();
        expect(screen.getByText('1 item')).toBeTruthy();
        expect(screen.queryByRole('button', { name: 'Next' })).toBeNull();
        expect(api.listUnmatchedFiles).toHaveBeenLastCalledWith(
            expect.objectContaining({ disposition: 'unresolved', offset: 0 }),
        );
    });
});

describe('ordinary matching outcomes', () => {
    it('shows retained provider-conflict entries without invoking a merge or demanding review', async () => {
        render(NeverMatchedPanel);
        await screen.findByText('Family Video');
        api.startAutoIdentify.mockResolvedValue({ data: { jobId: 'run-1' }, error: null });
        runApi.poll.mockResolvedValue({
            data: {
                state: 'completed',
                stages: [],
                result: {
                    result: {
                        matched: 0,
                        conflicts: 1,
                        conflictItems: [{ id: item.id, title: 'Shared Lantern' }],
                    },
                },
            },
        });
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            await fireEvent.click(screen.getByRole('button', { name: 'Find online matches' }));
            await vi.advanceTimersByTimeAsync(3000);
            expect(await screen.findByText(/1 online matches already belong/)).toBeTruthy();
            await fireEvent.click(screen.getByText('Open entries with shared online matches'));
            expect(screen.getByRole('link', { name: 'Shared Lantern' }).getAttribute('href')).toBe(
                `/admin/library/media/${item.id}`,
            );
            expect(api.startAutoIdentify).toHaveBeenCalledOnce();
            expect(modalState.open).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });
    it('does not report zero matches as a verified success when the run result is unreadable', async () => {
        render(NeverMatchedPanel);
        await screen.findByText('Family Video');
        api.startAutoIdentify.mockResolvedValue({ data: { jobId: 'run-2' }, error: null });
        runApi.poll.mockResolvedValue({
            data: { state: 'completed', stages: [], result: { result: { matched: 'unknown' } } },
        });
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            await fireEvent.click(screen.getByRole('button', { name: 'Find online matches' }));
            await vi.advanceTimersByTimeAsync(3000);
            await waitFor(() =>
                expect(toastState.warning).toHaveBeenCalledWith(
                    expect.stringContaining('result could not be read'),
                ),
            );
            expect(toastState.success).not.toHaveBeenCalledWith(
                'Auto-identify complete — 0 items matched',
            );
        } finally {
            vi.useRealTimers();
        }
    });
});
