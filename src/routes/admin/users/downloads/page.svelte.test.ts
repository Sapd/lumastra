// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdminDownloadsResponse } from '$lib/schemas/api-admin-responses';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));

vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ data: {}, url: new URL('http://localhost/admin/users/downloads') }),
        navigating: readable(null),
    };
});

const getAdminDownloads = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    getAdminDownloads,
}));

import DownloadsPage from './+page.svelte';

const payload: AdminDownloadsResponse = {
    totalBytesPerSec: 3 * 1024 * 1024,
    totalCapBytesPerSec: 10 * 1024 * 1024,
    active: [
        {
            userId: 'u1',
            username: 'alice',
            fileId: 'f1',
            title: 'Pilot',
            seriesTitle: 'Example Show',
            season: 1,
            episode: 2,
            clientName: 'Firefox',
            surface: 'web',
            bytesTotal: 2048,
            bytesSent: 1024,
            bytesPerSec: 3 * 1024 * 1024,
            startedAt: '2026-11-16T10:00:00.000Z',
        },
    ],
    events: [
        {
            id: 'e1',
            count: 1,
            userId: 'u1',
            username: 'alice',
            title: 'A Movie',
            surface: 'web',
            bytesSent: 0,
            outcome: 'denied',
            startedAt: '2026-11-16T09:00:00.000Z',
        },
        {
            id: 'e2',
            count: 1,
            userId: 'u2',
            username: 'bob',
            title: 'Other Movie',
            surface: 'jellyfin',
            bytesSent: 0,
            outcome: 'rate_limited',
            startedAt: '2026-11-16T08:00:00.000Z',
        },
        {
            id: 'e3',
            count: 1,
            userId: 'u2',
            username: 'bob',
            title: 'Done Movie',
            surface: 'api',
            bytesTotal: 100,
            bytesSent: 100,
            outcome: 'completed',
            startedAt: '2026-11-16T07:00:00.000Z',
            endedAt: '2026-11-16T07:01:00.000Z',
        },
        {
            id: 'e5',
            count: 1,
            userId: 'u1',
            username: 'alice',
            title: 'Season 2',
            seriesTitle: 'Zip Show',
            season: 2,
            archive: true,
            surface: 'web',
            bytesTotal: 100,
            bytesSent: 40,
            outcome: 'error',
            startedAt: '2026-11-16T06:00:00.000Z',
        },
        {
            id: 'e6',
            count: 1,
            userId: 'u1',
            username: 'alice',
            title: 'Whole Show',
            archive: true,
            surface: 'web',
            bytesSent: 0,
            outcome: 'aborted',
            startedAt: '2026-11-16T05:00:00.000Z',
        },
        {
            // Still running: shown above, not repeated in the history.
            id: 'e4',
            count: 1,
            userId: 'u1',
            username: 'alice',
            title: 'Pilot',
            surface: 'web',
            bytesSent: 1024,
            startedAt: '2026-11-16T10:00:00.000Z',
        },
    ],
};

beforeEach(() => {
    getAdminDownloads.mockReset().mockResolvedValue({ data: payload, error: null });
});
afterEach(cleanup);

describe('admin downloads page', () => {
    it('shows running downloads above the history, with total speed against the cap', async () => {
        render(DownloadsPage);
        const running = await screen.findByRole('region', { name: 'Running now' });
        const history = screen.getByRole('region', { name: 'History' });
        expect(
            running.compareDocumentPosition(history) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(within(running).getByText(/Example Show/)).toBeTruthy();
        expect(within(running).getByText(/S1E2/)).toBeTruthy();
        expect(within(running).getByText('alice')).toBeTruthy();
        expect(screen.getByText('3.0 MB/s of 10.0 MB/s')).toBeTruthy();
        expect(within(history).queryByText('Pilot')).toBeNull();
    });

    it('shows a ZIP with its series, "Season NN" for a season, and "(ZIP)"', async () => {
        render(DownloadsPage);
        const history = await screen.findByRole('region', { name: 'History' });
        expect(within(history).getByText('Zip Show - Season 02 (ZIP)')).toBeTruthy();
        expect(within(history).getByText('Whole Show (ZIP)')).toBeTruthy();
    });

    it('labels refused attempts "Not allowed" and "Limit reached"', async () => {
        render(DownloadsPage);
        const history = await screen.findByRole('region', { name: 'History' });
        expect(within(history).getByText('Not allowed')).toBeTruthy();
        expect(within(history).getByText('Limit reached')).toBeTruthy();
        expect(within(history).getByText('Completed')).toBeTruthy();
    });

    it('filters the log by user', async () => {
        render(DownloadsPage);
        await screen.findByRole('region', { name: 'History' });
        await fireEvent.input(screen.getByLabelText('Filter by user'), {
            target: { value: 'bob' },
        });
        await waitFor(() =>
            expect(getAdminDownloads).toHaveBeenLastCalledWith(
                expect.objectContaining({ user: 'bob' }),
            ),
        );
    });

    it('keeps the first page fixed once older rows are loaded, so refreshes do not skip rows', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const first = { ...payload, nextBefore: '2026-11-16T07:00:00.000Z' };
            const older: AdminDownloadsResponse = {
                ...payload,
                active: [],
                events: [
                    {
                        id: 'old1',
                        count: 1,
                        userId: 'u2',
                        username: 'bob',
                        title: 'Older Movie',
                        surface: 'web',
                        bytesSent: 1,
                        outcome: 'completed',
                        startedAt: '2026-11-15T07:00:00.000Z',
                    },
                ],
                nextBefore: undefined,
            };
            getAdminDownloads
                .mockResolvedValueOnce({ data: first, error: null })
                .mockResolvedValueOnce({ data: older, error: null });
            render(DownloadsPage);
            await screen.findByText('A Movie');
            await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
            await screen.findByText('Older Movie');

            // A refresh now returns a shifted first page: it must not replace the first page.
            const shifted = {
                ...first,
                events: [{ ...first.events[2], id: 'new', title: 'Brand New' }, ...first.events],
            };
            getAdminDownloads.mockResolvedValue({ data: shifted, error: null });
            await vi.advanceTimersByTimeAsync(5_000);
            await waitFor(() => expect(getAdminDownloads.mock.calls.length).toBeGreaterThan(2));
            expect(screen.queryByText('Brand New')).toBeNull();
            expect(screen.getByText('A Movie')).toBeTruthy();
            expect(screen.getByText('Older Movie')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('a refresh landing while Load more is in flight neither moves the cursor nor the first page', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            const first = { ...payload, nextBefore: 'cursor-A' };
            const shifted = {
                ...first,
                nextBefore: 'cursor-SHIFTED',
                events: [{ ...first.events[2], id: 'new', title: 'Brand New' }, ...first.events],
            };
            let resolveMore!: (v: unknown) => void;
            const morePending = new Promise((r) => (resolveMore = r));
            getAdminDownloads
                .mockReset()
                .mockResolvedValueOnce({ data: first, error: null })
                .mockReturnValueOnce(morePending) // Load more, hangs
                .mockResolvedValue({ data: shifted, error: null }); // refreshes meanwhile
            render(DownloadsPage);
            await screen.findByText('A Movie');
            await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
            await vi.advanceTimersByTimeAsync(5_100); // a refresh lands while it is loading
            expect(screen.queryByText('Brand New')).toBeNull();
            resolveMore({
                data: {
                    ...payload,
                    active: [],
                    events: [{ ...payload.events[2], id: 'old1', title: 'Older Movie' }],
                    nextBefore: 'cursor-B',
                },
                error: null,
            });
            await screen.findByText('Older Movie');
            expect(screen.queryByText('Brand New')).toBeNull();
            // the next page continues from the answer's cursor, not from the shifted refresh
            getAdminDownloads.mockClear();
            getAdminDownloads.mockResolvedValueOnce({
                data: { ...payload, active: [], events: [] },
                error: null,
            });
            await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
            expect(getAdminDownloads).toHaveBeenCalledWith(
                expect.objectContaining({ before: 'cursor-B' }),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('serialises Load more: a second click while one is loading sends no second request', async () => {
        const first = { ...payload, nextBefore: 'cursor-A' };
        let resolveMore!: (v: unknown) => void;
        getAdminDownloads
            .mockReset()
            .mockResolvedValueOnce({ data: first, error: null })
            .mockReturnValueOnce(new Promise((r) => (resolveMore = r)));
        render(DownloadsPage);
        await screen.findByText('A Movie');
        const button = screen.getByRole('button', { name: 'Load more' });
        await fireEvent.click(button);
        await fireEvent.click(button);
        expect(getAdminDownloads).toHaveBeenCalledTimes(2); // first page + ONE load-more
        resolveMore({ data: { ...payload, active: [], events: [] }, error: null });
    });

    it('shows a burst as one row that opens to its single downloads', async () => {
        const group = {
            id: 'g1',
            userId: 'u3',
            username: 'carol',
            artist: 'Example Band',
            album: 'Example Album',
            surface: 'api' as const,
            clientName: 'Tempus',
            bytesTotal: 3000,
            bytesSent: 3000,
            outcome: 'completed' as const,
            startedAt: '2026-11-16T11:00:00.000Z',
            count: 192,
            mediaClass: 'music' as const,
            mediaType: 'track',
        };
        const member = {
            id: 'm1',
            userId: 'u3',
            username: 'carol',
            title: 'Song One',
            artist: 'Example Band',
            album: 'Example Album',
            surface: 'api' as const,
            bytesSent: 10,
            outcome: 'completed' as const,
            startedAt: '2026-11-16T11:00:00.000Z',
            count: 1,
        };
        getAdminDownloads.mockImplementation((p: { group?: string }) =>
            Promise.resolve({
                data: p.group
                    ? { ...payload, active: [], events: [member] }
                    : { ...payload, events: [group, ...payload.events] },
                error: null,
            }),
        );
        render(DownloadsPage);
        const toggle = await screen.findByRole('button', {
            name: /Example Band · Example Album \(192 tracks\)/,
        });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        await fireEvent.click(toggle);
        // the group row already names artist and album: the single downloads show the track
        expect(await screen.findByText('Song One')).toBeTruthy();
        expect(getAdminDownloads).toHaveBeenCalledWith({ group: 'g1' });
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
        await fireEvent.click(toggle);
        expect(screen.queryByText('Song One')).toBeNull();
    });

    it('closes a group again when its downloads cannot be loaded', async () => {
        const group = {
            id: 'g1',
            userId: 'u3',
            username: 'carol',
            album: 'Example Album',
            surface: 'api' as const,
            bytesSent: 30,
            outcome: 'completed' as const,
            startedAt: '2026-11-16T11:00:00.000Z',
            count: 3,
            mediaClass: 'music' as const,
            mediaType: 'track',
        };
        getAdminDownloads.mockImplementation((p: { group?: string }) =>
            Promise.resolve(
                p.group
                    ? { data: null, error: new Error('boom') }
                    : { data: { ...payload, events: [group] }, error: null },
            ),
        );
        render(DownloadsPage);
        const toggle = await screen.findByRole('button', { name: /Example Album \(3 tracks\)/ });
        await fireEvent.click(toggle);
        await waitFor(() => expect(getAdminDownloads).toHaveBeenCalledWith({ group: 'g1' }));
        await waitFor(() => expect(toggle.getAttribute('aria-expanded')).toBe('false'));
    });

    it('names a single track by artist, album and title', async () => {
        getAdminDownloads.mockResolvedValue({
            data: {
                ...payload,
                events: [
                    {
                        id: 't1',
                        userId: 'u1',
                        username: 'alice',
                        title: 'Song One',
                        artist: 'Example Band',
                        album: 'Example Album',
                        surface: 'api',
                        bytesSent: 5,
                        outcome: 'completed',
                        startedAt: '2026-11-16T11:00:00.000Z',
                        count: 1,
                        mediaClass: 'music',
                        mediaType: 'track',
                    },
                ],
            },
            error: null,
        });
        render(DownloadsPage);
        expect(await screen.findByText('Example Band · Example Album · Song One')).toBeTruthy();
    });

    it('names a grouped season by series and season', async () => {
        getAdminDownloads.mockResolvedValue({
            data: {
                ...payload,
                events: [
                    {
                        id: 'g2',
                        userId: 'u1',
                        username: 'alice',
                        seriesTitle: 'Example Show',
                        season: 3,
                        surface: 'jellyfin',
                        bytesSent: 5,
                        outcome: 'completed',
                        startedAt: '2026-11-16T11:00:00.000Z',
                        count: 10,
                        mediaClass: 'video',
                        mediaType: 'episode',
                    },
                ],
            },
            error: null,
        });
        render(DownloadsPage);
        expect(
            await screen.findByRole('button', { name: /Example Show - Season 03 \(10 episodes\)/ }),
        ).toBeTruthy();
    });

    it('filters the log by kind', async () => {
        render(DownloadsPage);
        await screen.findByRole('region', { name: 'History' });
        const music = screen.getByRole('button', { name: 'Music' });
        await fireEvent.click(music);
        expect(music.getAttribute('aria-pressed')).toBe('true');
        await waitFor(() =>
            expect(getAdminDownloads).toHaveBeenLastCalledWith(
                expect.objectContaining({ kind: 'music' }),
            ),
        );
        await fireEvent.click(screen.getByRole('button', { name: 'All' }));
        await waitFor(() =>
            expect(getAdminDownloads).toHaveBeenLastCalledWith(
                expect.objectContaining({ kind: undefined }),
            ),
        );
    });

    it('shows a warning when limits run on the local fallback', async () => {
        getAdminDownloads.mockResolvedValue({ data: { ...payload, degraded: true }, error: null });
        render(DownloadsPage);
        expect(await screen.findByRole('status')).toBeTruthy();
    });

    it('a stale response for an old filter cannot overwrite a newer one', async () => {
        let resolveOld!: (v: unknown) => void;
        const oldP = new Promise((r) => (resolveOld = r));
        getAdminDownloads
            .mockReset()
            .mockResolvedValueOnce({ data: payload, error: null })
            .mockReturnValueOnce(oldP)
            .mockResolvedValue({
                data: {
                    ...payload,
                    events: [{ ...payload.events[0], id: 'n1', title: 'Newest Filter Row' }],
                },
                error: null,
            });
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            render(DownloadsPage);
            await screen.findByText('A Movie');
            await vi.advanceTimersByTimeAsync(5_000); // refresh #2 hangs
            await fireEvent.input(screen.getByLabelText('Filter by user'), {
                target: { value: 'bob' },
            });
            await vi.advanceTimersByTimeAsync(400); // filter reload #3 answers
            await screen.findByText('Newest Filter Row');
            resolveOld({ data: payload, error: null }); // the old one arrives late
            await vi.advanceTimersByTimeAsync(10);
            expect(screen.getByText('Newest Filter Row')).toBeTruthy();
            expect(screen.queryByText('A Movie')).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});
