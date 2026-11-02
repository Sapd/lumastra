// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { page } from '$app/state';
const api = vi.hoisted(() => ({
    inspectQuarantineGroup: vi.fn(),
    resolveQuarantineEntry: vi.fn(),
}));
const modal = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
const toast = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/stores/modal.store', () => ({ modals: modal }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: toast }));
vi.mock('$app/state', async () => {
    const { fromStore, writable } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new URL('http://localhost:3000/admin/library/quarantine'),
            data: {},
            get state(): App.PageState {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin/library/quarantine'), data: {} }),
    navigating: readable(null),
}));
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        goto: vi.fn(),
        invalidateAll: vi.fn(),
        pushState: vi.fn(),
        replaceState: vi.fn((target: URL, state: App.PageState): void => {
            window.history.replaceState(state, '', target);
            page.state = state;
        }),
    };
});
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
import Panel from './InspectionPanel.svelte';
const id = '12345678-1234-4234-8234-123456789abc';
const entry = {
    id,
    fingerprint: 'a'.repeat(64),
    provider: 'lumastra-reconcile',
    externalId: id,
    mediaType: 'episode',
    reason: 'reconcile-backfill:below-threshold',
    createdAt: '2026-10-24T00:00:00Z',
    expectedSeriesId: null,
    parentTmdbId: null,
    historicalSeriesId: null,
    proposedTitle: null,
    proposedTmdbEpisodeId: null,
    payload: null,
    subjectState: 'current' as const,
    current: {
        id,
        title: 'Invented subject',
        mediaType: 'episode',
        status: 'active',
        seasonNumber: 1,
        episodeNumber: 1,
        seriesId: null,
        seriesTitle: null,
        fileCount: 1,
        detailAvailable: true,
    },
};
beforeEach(() => {
    vi.clearAllMocks();
    page.url = new URL(
        '/admin/library/quarantine?inspect=unknown&after=12345678-1234-4234-8234-123456789abc',
        window.location.origin,
    ) as typeof page.url;
    page.state = {};
    window.history.replaceState({}, '', page.url);
    api.inspectQuarantineGroup.mockResolvedValue({ data: { items: [entry], total: 1 } });
});
afterEach(cleanup);
describe('current warning inspection', () => {
    it('restores the bounded cursor and provides current episode, Files and Metadata links while keeping history separate', async () => {
        render(Panel, { group: 'unknown', onclose: vi.fn(), onchanged: vi.fn() });
        expect(await screen.findByRole('link', { name: 'Open Invented subject' })).toBeTruthy();
        expect(api.inspectQuarantineGroup).toHaveBeenCalledWith('unknown', id);
        expect(screen.getByText('No usable historical proposal was recorded.')).toBeTruthy();
        expect(screen.getByRole('link', { name: 'Files (1)' }).getAttribute('href')).toBe(
            `/admin/library/media/${id}?tab=files`,
        );
        expect(screen.getByRole('link', { name: 'Metadata' }).getAttribute('href')).toBe(
            `/admin/library/media/${id}?tab=maintenance&section=metadata`,
        );
        expect(
            screen.getByRole('link', { name: 'Open Invented subject' }).getAttribute('target'),
        ).toBe('_blank');
        expect(api.resolveQuarantineEntry).not.toHaveBeenCalled();
    });
    it('hides one captured warning in one click and refuses a stale review without a modal', async () => {
        api.resolveQuarantineEntry.mockResolvedValue({ error: { message: 'changed' } });
        render(Panel, { group: 'unknown', onclose: vi.fn(), onchanged: vi.fn() });
        await fireEvent.click(await screen.findByRole('button', { name: 'Hide this warning' }));
        await waitFor(() =>
            expect(api.resolveQuarantineEntry).toHaveBeenCalledExactlyOnceWith(
                id,
                'dismissed',
                entry.fingerprint,
            ),
        );
        expect(modal.open).not.toHaveBeenCalled();
        expect(toast.error).toHaveBeenCalledWith(
            'This review is no longer available. Refresh and inspect again before dismissing.',
        );
        expect(api.inspectQuarantineGroup).toHaveBeenCalledTimes(2);
    });
    it('does not replace a newly selected group with an older response', async () => {
        let finish!: (value: unknown) => void;
        api.inspectQuarantineGroup.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const view = render(Panel, { group: 'unknown', onclose: vi.fn(), onchanged: vi.fn() });
        await waitFor(() => expect(api.inspectQuarantineGroup).toHaveBeenCalledTimes(1));
        api.inspectQuarantineGroup.mockResolvedValue({ data: { items: [], total: 0 } });
        await view.rerender({ group: 'tmdb:12', onclose: vi.fn(), onchanged: vi.fn() });
        await waitFor(() =>
            expect(api.inspectQuarantineGroup).toHaveBeenCalledWith('tmdb:12', undefined),
        );
        finish({ data: { items: [entry], total: 1 } });
        await waitFor(() =>
            expect(screen.queryByText('Invented subject', { exact: false })).toBeNull(),
        );
    });
});
