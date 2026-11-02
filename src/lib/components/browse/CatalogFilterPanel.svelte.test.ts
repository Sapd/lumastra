// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import CatalogFilterPanel from './CatalogFilterPanel.svelte';

afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

it('dismisses only clicks that start and end outside the drawer', async () => {
    const view = render(CatalogFilterPanel);
    const dialog = view.container.querySelector('dialog')!;
    const close = vi.spyOn(dialog, 'close').mockImplementation(() => undefined);
    vi.spyOn(dialog, 'getBoundingClientRect').mockReturnValue({
        left: 500,
        right: 900,
        top: 0,
        bottom: 800,
        x: 500,
        y: 0,
        width: 400,
        height: 800,
        toJSON: () => ({}),
    });
    // Padding is part of the drawer, not its backdrop.
    await fireEvent.pointerDown(dialog, { clientX: 510, clientY: 100 });
    await fireEvent.click(dialog, { clientX: 510, clientY: 100 });
    expect(close).not.toHaveBeenCalled();
    // Dragging from inside to outside must not dismiss it.
    await fireEvent.pointerDown(dialog, { clientX: 510, clientY: 100 });
    await fireEvent.click(dialog, { clientX: 100, clientY: 100 });
    expect(close).not.toHaveBeenCalled();
    // Desktop backdrop.
    await fireEvent.pointerDown(dialog, { clientX: 100, clientY: 100 });
    await fireEvent.click(dialog, { clientX: 100, clientY: 100 });
    expect(close).toHaveBeenCalledTimes(1);
    // Mobile bottom-sheet backdrop lies above the dialog.
    await fireEvent.pointerDown(dialog, { clientX: 600, clientY: -20 });
    await fireEvent.click(dialog, { clientX: 600, clientY: -20 });
    expect(close).toHaveBeenCalledTimes(2);
});
