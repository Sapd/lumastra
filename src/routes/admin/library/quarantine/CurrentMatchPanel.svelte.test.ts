// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ resolveQuarantineSeriesGroup: vi.fn() }));
const modal = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('$lib/api/admin', () => api);
vi.mock('$lib/stores/modal.store', () => ({ modals: modal }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn() } }));
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import Panel from './CurrentMatchPanel.svelte';

const seriesId = '12345678-1234-4234-8234-123456789abc';
const warningId = '12345678-1234-4234-8234-123456789abd';
const blockedId = '12345678-1234-4234-8234-123456789abe';
const page = { ids: [warningId, blockedId], fingerprint: 'a'.repeat(64) };
const group = {
    fingerprint: 'd'.repeat(32),
    seriesId,
    parentTmdbId: null,
    seriesTitle: 'Invented Series',
    totalUnresolved: 2,
    reasonCounts: { 'reconcile-backfill:matched': 1, 'reconcile-backfill:below-threshold': 1 },
    oldestCreatedAt: '2026-10-24T00:00:00Z',
    newestCreatedAt: '2026-10-24T00:00:00Z',
};
const matching = {
    id: warningId,
    fingerprint: 'b'.repeat(64),
    episodeId: seriesId,
    proposedTitle: 'Invented Episode',
    proposedTmdbEpisodeId: '870001',
    proposedSeasonNumber: 1,
    proposedEpisodeNumber: 1,
    currentTitle: 'Invented Episode',
    currentTmdbEpisodeId: '870001',
    currentSeasonNumber: 1,
    currentEpisodeNumber: 1,
    currentSeriesId: seriesId,
    titleBinding: 'position',
    eligible: true,
};
const blocked = {
    ...matching,
    id: blockedId,
    fingerprint: 'c'.repeat(64),
    proposedTmdbEpisodeId: null,
    titleBinding: 'identity',
    eligible: false,
    retainedReason: 'historical-target-unconfirmed',
};

beforeEach(() => {
    vi.clearAllMocks();
    api.resolveQuarantineSeriesGroup.mockResolvedValue({
        data: {
            action: 'preview-current-match',
            examined: 2,
            resolved: 0,
            retained: 2,
            reviewedPage: page,
            currentMatchReview: [matching, blocked],
        },
    });
});
afterEach(cleanup);

describe('current-match review panel', () => {
    it('requires deliberate selection, displays binding and excludes untargeted history', async () => {
        const changed = vi.fn();
        render(Panel, { group, onclose: vi.fn(), onchanged: changed });
        expect(
            await screen.findByText(
                '2 warnings on this page; 1 exact positional matches can be selected.',
            ),
        ).toBeTruthy();
        expect(
            screen.getByText('The historical proposal has no confirmed target.', { exact: false }),
        ).toBeTruthy();
        const checkboxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
        expect(checkboxes).toHaveLength(2);
        expect(checkboxes[0].checked).toBe(false);
        expect(checkboxes[1].disabled).toBe(true);
        const confirm = screen.getByRole('button', {
            name: 'Hide selected warnings (0)',
        }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(true);
        await fireEvent.click(checkboxes[0]);
        api.resolveQuarantineSeriesGroup.mockResolvedValueOnce({
            data: { action: 'confirm-current-match', examined: 2, resolved: 1, retained: 1 },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Hide selected warnings (1)' }));
        expect(modal.open).not.toHaveBeenCalled();
        await waitFor(() => expect(changed).toHaveBeenCalledOnce());
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenLastCalledWith({
            seriesId,
            action: 'confirm-current-match',
            after: undefined,
            reviewedPage: page,
            reviewed: [{ id: warningId, fingerprint: matching.fingerprint }],
        });
        expect(screen.getByRole('status').textContent).toContain('hidden: 1');
    });

    it('keeps a changed review open and supports refresh without retaining selection', async () => {
        render(Panel, { group, onclose: vi.fn(), onchanged: vi.fn() });
        const checkbox = (await screen.findAllByRole('checkbox'))[0];
        await fireEvent.click(checkbox);
        api.resolveQuarantineSeriesGroup.mockResolvedValueOnce({
            data: {
                action: 'confirm-current-match',
                examined: 0,
                resolved: 0,
                retained: 0,
                pageChanged: true,
            },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Hide selected warnings (1)' }));
        await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        expect(screen.getByRole('alert').textContent).toContain('Nothing was closed');
        expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.getAllByRole('checkbox')).toHaveLength(2));
        expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(false);
    });
});
