// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Once a window was repudiated the provenance page had no way to retry a
 * failed Jellyfin unmark (admin/users review 2026-10-07): this list retries it
 * with the same request the repudiation sent.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingJellyfinUnmarkWindow } from '$lib/server/database/queries/user-media-events.queries.js';

const apiPost = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiPost }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { show: toast } }));

import PendingJellyfinUnmarks from './PendingJellyfinUnmarks.svelte';

const USER_ID = '11111111-1111-4111-8111-111111111111';

function windowRow(
    overrides: Partial<PendingJellyfinUnmarkWindow> = {},
): PendingJellyfinUnmarkWindow {
    return {
        repudiated_at: '2026-10-06T12:05:00.000000Z',
        from_ts: '2026-10-06T12:00:00.100000Z',
        to_ts: '2026-10-06T12:00:00.250000Z',
        event_count: 120,
        pending_media_count: 40,
        last_attempt_at: '2026-10-06T12:05:01.000000Z',
        last_unmark: { attempted: 40, succeeded: 0, failed: 40, skippedNoExternalId: 0 },
        ...overrides,
    };
}

function renderList(windows: PendingJellyfinUnmarkWindow[], onretried = vi.fn()): void {
    render(PendingJellyfinUnmarks, {
        userId: USER_ID,
        windows,
        onretried,
        formatRelative: (iso: string) => `rel(${iso})`,
        formatDurationMs: (ms: number) => `${ms}ms`,
    });
}

beforeEach(() => {
    apiPost.mockReset();
    toast.mockReset();
});
afterEach(() => {
    cleanup();
});

describe('PendingJellyfinUnmarks', () => {
    it('renders nothing without windows', () => {
        renderList([]);
        expect(screen.queryByText('Jellyfin unmark pending')).toBeNull();
    });

    it('shows the last attempt: failed counts, not unmarked, or no record', () => {
        renderList([
            windowRow(),
            windowRow({ repudiated_at: 'b', last_unmark: null }),
            windowRow({ repudiated_at: 'c', last_unmark: null, last_attempt_at: null }),
        ]);
        expect(screen.getByText('40 of 40 failed')).toBeTruthy();
        expect(screen.getByText('Not unmarked')).toBeTruthy();
        expect(screen.getByText('No record')).toBeTruthy();
        expect(screen.getAllByRole('button', { name: 'Retry Jellyfin unmark' })).toHaveLength(3);
    });

    it('retries with the same body as the repudiation and shows the counts', async () => {
        apiPost.mockResolvedValue({
            data: {
                jellyfinUnmark: { attempted: 40, succeeded: 38, failed: 2, skippedNoExternalId: 0 },
            },
            error: null,
        });
        const onretried = vi.fn();
        renderList([windowRow()], onretried);

        await fireEvent.click(screen.getByRole('button', { name: 'Retry Jellyfin unmark' }));

        expect(apiPost).toHaveBeenCalledWith(
            '/api/admin/watch-events/repudiate',
            expect.anything(),
            {
                userId: USER_ID,
                source: 'jellyfin-sync',
                fromTs: '2026-10-06T12:00:00.100000Z',
                toTs: '2026-10-06T12:00:00.250000Z',
            },
        );
        await vi.waitFor(() => expect(onretried).toHaveBeenCalled());
        expect(toast).toHaveBeenCalledWith(
            'Jellyfin unmark: 38 of 40 unmarked, 2 failed, 0 without a Jellyfin ID.',
            'warning',
        );
        // The row shows this retry's result even before the audit row lands.
        expect(await screen.findByText('2 of 40 failed')).toBeTruthy();
    });

    it('says so when nothing is left to unmark', async () => {
        apiPost.mockResolvedValue({ data: { jellyfinUnmark: null }, error: null });
        renderList([windowRow()]);
        await fireEvent.click(screen.getByRole('button', { name: 'Retry Jellyfin unmark' }));
        await vi.waitFor(() =>
            expect(toast).toHaveBeenCalledWith(
                'Nothing left to unmark on Jellyfin: the user has watched these items since.',
                'success',
            ),
        );
    });

    it('reports a failed request and does not reload', async () => {
        apiPost.mockResolvedValue({ data: null, error: 'Database unavailable' });
        const onretried = vi.fn();
        renderList([windowRow()], onretried);
        await fireEvent.click(screen.getByRole('button', { name: 'Retry Jellyfin unmark' }));
        await vi.waitFor(() =>
            expect(toast).toHaveBeenCalledWith('Repudiation failed: Database unavailable', 'error'),
        );
        expect(onretried).not.toHaveBeenCalled();
        expect(screen.getByText('40 of 40 failed')).toBeTruthy();
    });
});
