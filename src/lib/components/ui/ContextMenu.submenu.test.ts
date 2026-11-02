// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ContextMenu from './ContextMenu.svelte';
import { submenuComponent, type ContextMenuEntry } from './context-menu-types';
import SubmenuProbe from './context-menu-submenu-probe.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

function entries(onDoneSpy?: () => void): ContextMenuEntry[] {
    return [
        { label: 'Play', onSelect: vi.fn() },
        {
            kind: 'submenu',
            label: 'Add to Playlist',
            ...submenuComponent(SubmenuProbe, { marker: 'Handsup', onCommit: onDoneSpy }),
        },
    ];
}

function renderMenu(props: Partial<{ mobileSheet: boolean; onClose: () => void }> = {}) {
    const onClose = props.onClose ?? vi.fn();
    return {
        onClose,
        ...render(ContextMenu, {
            props: {
                x: 40,
                y: 40,
                items: entries(),
                mobileSheet: props.mobileSheet ?? false,
                onClose,
            },
        }),
    };
}

describe('ContextMenu submenu', () => {
    beforeEach(() => vi.clearAllMocks());
    afterEach(() => cleanup());

    it('does not render the panel until the row is hovered', () => {
        renderMenu();
        expect(screen.queryByText('Handsup')).toBeNull();
    });

    it('opens the flyout on hover and keeps it open while the pointer is inside it', async () => {
        renderMenu();
        const row = screen.getByText('Add to Playlist').closest('button')!;

        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        await screen.findByText('Handsup');

        // Regression guard: the open entry is compared by identity against the
        // caller's object. Holding it in a reactive proxy (plain $state) makes
        // that comparison always false and silently kills the open-row state.
        await waitFor(() => expect(row.getAttribute('aria-expanded')).toBe('true'));

        // Leaving the row starts a grace timer; entering the panel must cancel
        // it, otherwise the flyout disappears as the pointer crosses the gap.
        row.dispatchEvent(new MouseEvent('mouseleave', { bubbles: false }));
        const panel = screen.getByText('Handsup').closest('[role="menu"]')!;
        panel.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));

        await new Promise((r) => setTimeout(r, 250));
        expect(screen.queryByText('Handsup')).not.toBeNull();
    });

    it('does not close the whole menu when the flyout is clicked', async () => {
        const onClose = vi.fn();
        renderMenu({ onClose });
        const row = screen.getByText('Add to Playlist').closest('button')!;
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        const marker = await screen.findByText('Handsup');

        // The flyout is portaled as a sibling of the main panel, so a naive
        // "is the target inside menuEl?" outside-click test would close here.
        await new Promise((r) => setTimeout(r, 300));
        marker.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        expect(onClose).not.toHaveBeenCalled();
    });

    it('drills in rather than flying out on the mobile sheet', async () => {
        renderMenu({ mobileSheet: true });
        const row = screen.getByText('Add to Playlist').closest('button')!;

        // Hover must not open anything on a touch sheet.
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));
        expect(screen.queryByText('Handsup')).toBeNull();

        await new Promise((r) => setTimeout(r, 300));
        row.click();
        await screen.findByText('Handsup');

        // Drill-in replaces the root list and offers a way back.
        expect(screen.queryByText('Play')).toBeNull();
        const back = screen.getByLabelText('Back');
        back.click();
        await waitFor(() => expect(screen.queryByText('Handsup')).toBeNull());
        expect(screen.getByText('Play')).toBeTruthy();
    });

    it('closes the whole menu when the panel reports it is done', async () => {
        const onClose = vi.fn();
        renderMenu({ onClose });
        const row = screen.getByText('Add to Playlist').closest('button')!;
        row.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }));

        const commit = await screen.findByText('commit');
        commit.click();
        expect(onClose).toHaveBeenCalled();
    });
});
