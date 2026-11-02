// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, fireEvent, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
    updateMediaMetadata: vi.fn(async () => ({ error: null })),
}));

import OverviewTab from './OverviewTab.svelte';

const baseProps = {
    mediaId: 'abc-123',
    title: 'The Great Movie',
    locked: false,
    mediaType: 'movie',
};

// The detail page owns deletion under More actions; Overview exposes no duplicate destructive control.
describe('OverviewTab parent-owned actions', () => {
    it('leaves deletion and its confirmation to the parent detail page', () => {
        render(OverviewTab, { props: baseProps });
        expect(screen.queryByText('Delete Media Item')).toBeNull();
        expect(screen.queryByLabelText('Type the item title to confirm')).toBeNull();
    });

    it('calls the parent-owned onUnlock when the lock banner button is clicked', async () => {
        const onUnlock = vi.fn();
        render(OverviewTab, {
            props: { ...baseProps, locked: true, lockedBy: 'alice', onUnlock },
        });

        await fireEvent.click(screen.getByText('Unlock'));

        expect(onUnlock).toHaveBeenCalledTimes(1);
    });

    it('disables the Unlock button while the parent-owned unlock call is in flight, so a double click cannot fire it twice', async () => {
        // Before the fix this button's `disabled` was wired to this component's
        // own `saving` state (which only tracks the metadata-save flow), so a
        // slow unlock could be double-submitted from here even though the
        // header's own copy of this button was correctly guarded.
        const onUnlock = vi.fn();
        const { rerender } = render(OverviewTab, {
            props: { ...baseProps, locked: true, lockedBy: 'alice', onUnlock, unlocking: false },
        });

        const unlockButton = screen.getByText('Unlock').closest('button') as HTMLButtonElement;
        await fireEvent.click(unlockButton);
        expect(onUnlock).toHaveBeenCalledTimes(1);

        // Simulate the parent setting `unlocking = true` for the duration of
        // the in-flight call -- this is what the real onUnlock does.
        await rerender({ unlocking: true });
        expect(unlockButton.disabled).toBe(true);

        await fireEvent.click(unlockButton);
        expect(onUnlock).toHaveBeenCalledTimes(1);
    });
});
