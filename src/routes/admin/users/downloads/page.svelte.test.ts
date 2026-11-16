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
            // Still running: shown above, not repeated in the history.
            id: 'e4',
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
});
