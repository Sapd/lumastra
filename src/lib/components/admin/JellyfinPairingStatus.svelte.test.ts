// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import JellyfinPairingStatus from './JellyfinPairingStatus.svelte';

afterEach(cleanup);
describe('Jellyfin pairing visibility', () => {
    it('shows the count and example titles', () => {
        render(JellyfinPairingStatus, {
            status: { count: 12, examples: ['Holiday film', 'Family concert'] },
        });
        expect(screen.getByRole('heading').textContent).toBe('Jellyfin: 12 titles not paired');
        expect(screen.getAllByRole('listitem').map((item) => item.textContent)).toEqual([
            'Holiday film',
            'Family concert',
        ]);
        expect(screen.getByText(/File pairing checks run separately/)).toBeTruthy();
    });
    it('shows a load failure instead of silently claiming everything is paired', () => {
        render(JellyfinPairingStatus, { status: null });
        expect(screen.getByRole('status').textContent).toContain('could not be loaded');
    });
    it('clears the warning when no titles remain unpaired', () => {
        render(JellyfinPairingStatus, { status: { count: 0, examples: [] } });
        expect(screen.queryByRole('region')).toBeNull();
        expect(screen.queryByRole('status')).toBeNull();
    });
    it('shows durable failures and one-sided counts separately from unpaired titles', () => {
        render(JellyfinPairingStatus, {
            status: {
                count: 0,
                examples: [],
                failed: {
                    count: 1,
                    examples: ['Film: HTTP 404 (attempt 3; retry after tomorrow)'],
                },
                oneSided: 2,
            },
        });
        expect(screen.getByText(/Film: HTTP 404/)).toBeTruthy();
        expect(screen.getByText(/2 titles have no matching/)).toBeTruthy();
    });
});
