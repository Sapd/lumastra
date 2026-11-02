// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import Tooltip from './Tooltip.svelte';

describe('Tooltip disabled prop', () => {
    afterEach(() => cleanup());

    test('shows on hover when not disabled', async () => {
        const { container } = render(Tooltip, {
            props: { text: 'Show details', delay: 0, triggerClass: 'tooltip-trigger' },
        });
        const trigger = container.querySelector('.tooltip-trigger');
        if (!trigger) throw new Error('trigger not found');

        await fireEvent.mouseEnter(trigger);
        await waitFor(() => expect(screen.getByText('Show details')).toBeTruthy());
    });

    test('never shows on hover when disabled', async () => {
        const { container } = render(Tooltip, {
            props: {
                text: 'Show details',
                delay: 0,
                disabled: true,
                triggerClass: 'tooltip-trigger',
            },
        });
        const trigger = container.querySelector('.tooltip-trigger');
        if (!trigger) throw new Error('trigger not found');

        await fireEvent.mouseEnter(trigger);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(screen.queryByText('Show details')).toBeNull();
    });

    test('hides an already-visible tooltip when disabled flips true', async () => {
        const { container, rerender } = render(Tooltip, {
            props: {
                text: 'Show details',
                delay: 0,
                disabled: false,
                triggerClass: 'tooltip-trigger',
            },
        });
        const trigger = container.querySelector('.tooltip-trigger');
        if (!trigger) throw new Error('trigger not found');

        await fireEvent.mouseEnter(trigger);
        await waitFor(() => expect(screen.getByText('Show details')).toBeTruthy());

        await rerender({
            text: 'Show details',
            delay: 0,
            disabled: true,
            triggerClass: 'tooltip-trigger',
        });
        await waitFor(() => expect(screen.queryByText('Show details')).toBeNull());
    });

    test('hides an already-visible FIXED tooltip when disabled flips true', async () => {
        const { container, rerender } = render(Tooltip, {
            props: {
                text: 'Show details',
                delay: 0,
                fixed: true,
                disabled: false,
                triggerClass: 'tooltip-trigger',
            },
        });
        const trigger = container.querySelector('.tooltip-trigger');
        if (!trigger) throw new Error('trigger not found');

        await fireEvent.mouseEnter(trigger);
        // `fixed` tooltips render into a body portal, not `container`, and
        // their bubble is built imperatively in createPortalContent() rather
        // than reactively from `text` — so this must be asserted against the
        // document, not the render container.
        await waitFor(() => {
            const bubble = document.querySelector('.tooltip-content');
            expect(bubble).not.toBeNull();
            expect(bubble!.textContent).toBe('Show details');
        });

        await rerender({
            text: 'Show details',
            delay: 0,
            fixed: true,
            disabled: true,
            triggerClass: 'tooltip-trigger',
        });
        await waitFor(() => expect(document.querySelector('.tooltip-content')).toBeNull());
    });
});

describe('Tooltip branding', () => {
    afterEach(() => cleanup());

    test.each([false, true])('keeps branding inside the bubble (fixed=%s)', async (fixed) => {
        const { container } = render(Tooltip, {
            props: {
                text: 'Data from Last.fm',
                image: {
                    src: '/attribution/lastfm-logo.png',
                    alt: 'Last.fm',
                    width: 60,
                    height: 14,
                },
                fixed,
                delay: 0,
                triggerClass: 'tooltip-trigger',
            },
        });
        const trigger = container.querySelector('.tooltip-trigger');
        if (!trigger) throw new Error('trigger not found');
        expect(screen.queryByAltText('Last.fm')).toBeNull();
        await fireEvent.mouseEnter(trigger);
        await waitFor(() => {
            const bubble = screen.getByRole('tooltip');
            expect(bubble.contains(screen.getByAltText('Last.fm'))).toBe(true);
            expect(bubble.textContent).toContain('Data from Last.fm');
        });
        await fireEvent.mouseLeave(trigger);
        expect(screen.queryByRole('tooltip')).toBeNull();
        expect(screen.queryByAltText('Last.fm')).toBeNull();
    });
});

test('click-pinned tooltip keeps its three-second timeout across hover re-entry', async () => {
    vi.useFakeTimers();
    try {
        const { container } = render(Tooltip, {
            props: {
                text: 'Remaining languages',
                toggleOnClick: false,
                delay: 0,
                triggerClass: 'tooltip-trigger',
            },
        });
        const trigger = container.querySelector('.tooltip-trigger')!;
        await fireEvent.focusIn(trigger);
        await fireEvent.click(trigger);
        await fireEvent.mouseEnter(trigger);
        await fireEvent.mouseLeave(trigger);
        expect(screen.getByRole('tooltip').textContent?.trim()).toBe('Remaining languages');
        await vi.advanceTimersByTimeAsync(2999);
        expect(screen.getByRole('tooltip')).toBeTruthy();
        await vi.advanceTimersByTimeAsync(1);
        expect(screen.queryByRole('tooltip')).toBeNull();
    } finally {
        cleanup();
        vi.useRealTimers();
    }
});
