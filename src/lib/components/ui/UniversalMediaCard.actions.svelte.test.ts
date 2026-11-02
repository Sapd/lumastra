// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';
import ContextMenu from './ContextMenu.svelte';
import SubmenuProbe from './context-menu-submenu-probe.svelte';
import { submenuComponent } from './context-menu-types';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));
vi.mock('$lib/utils/similar-prefetch', () => ({ prefetchSimilar: vi.fn() }));

const movie: UniversalMediaItem = {
    id: 'movie-1',
    externalIds: {},
    mediaType: 'movie',
    title: 'The Lantern',
    image: '/poster.png',
    isAvailable: true,
    canRequest: false,
};

beforeEach(() => {
    window.matchMedia = vi.fn().mockImplementation(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    }));
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('consistent video card actions', () => {
    it.each(['poster', 'backdrop'] as const)(
        '%s cards offer Similar and Hide together without activating the card',
        async (variant) => {
            const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
            const onmore = vi.fn();
            const onremove = vi.fn();
            const onclick = vi.fn();
            const { container } = render(UniversalMediaCard, {
                item: movie,
                variant,
                showDismiss: true,
                alwaysShowDismiss: true,
                onmore,
                onremove,
                onclick,
            });
            const card = container.querySelector<HTMLElement>('.card-touch-root')!;
            expect(screen.queryByRole('button', { name: m.card_actions_aria() })).toBeNull();
            await fireEvent.mouseEnter(card);
            const trigger = screen.getByRole('button', { name: m.card_actions_aria() });
            expect(trigger.classList.contains('right-1')).toBe(true);
            expect(screen.queryByRole('button', { name: m.card_hide() })).toBeNull();
            expect(screen.queryByRole('button', { name: m.card_similar_titles() })).toBeNull();

            await fireEvent.click(trigger, { detail: 1 });
            const similar = await screen.findByRole('menuitem', { name: m.card_similar_titles() });
            expect(screen.getByRole('menuitem', { name: m.card_hide() })).toBeTruthy();
            expect(trigger.getAttribute('aria-expanded')).toBe('true');
            now.mockReturnValue(1500);
            await fireEvent.click(similar);
            expect(onmore).toHaveBeenCalledExactlyOnceWith(movie);
            expect(onremove).not.toHaveBeenCalled();
            expect(onclick).not.toHaveBeenCalled();

            await fireEvent.click(trigger, { detail: 1 });
            now.mockReturnValue(2000);
            await fireEvent.click(screen.getByRole('menuitem', { name: m.card_hide() }));
            expect(onremove).toHaveBeenCalledExactlyOnceWith(movie);
            expect(onclick).not.toHaveBeenCalled();
        },
    );

    it('discovery cards use the same trigger without offering an unsupported Hide', async () => {
        const { container } = render(UniversalMediaCard, { item: movie, onmore: vi.fn() });
        await fireEvent.mouseEnter(container.querySelector<HTMLElement>('.card-touch-root')!);
        await fireEvent.click(screen.getByRole('button', { name: m.card_actions_aria() }), {
            detail: 1,
        });
        expect(screen.getByRole('menuitem', { name: m.card_similar_titles() })).toBeTruthy();
        expect(screen.queryByRole('menuitem', { name: m.card_hide() })).toBeNull();
    });

    it('keyboard users can open the menu and Escape returns focus to its trigger', async () => {
        const { container } = render(UniversalMediaCard, { item: movie, onmore: vi.fn() });
        const card = container.querySelector<HTMLElement>('.card-touch-root')!;
        card.focus();
        const trigger = await screen.findByRole('button', { name: m.card_actions_aria() });
        trigger.focus();
        await fireEvent.click(trigger, { detail: 0 });
        await waitFor(() => expect(document.activeElement?.getAttribute('role')).toBe('menuitem'));
        expect(trigger.isConnected).toBe(true);
        await fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('does not offer Similar when explicitly disabled', async () => {
        const { container } = render(UniversalMediaCard, {
            item: movie,
            showMoreButton: false,
            onmore: vi.fn(),
        });
        await fireEvent.mouseEnter(container.querySelector<HTMLElement>('.card-touch-root')!);
        await fireEvent.click(screen.getByRole('button', { name: m.card_actions_aria() }), {
            detail: 1,
        });
        expect(screen.queryByRole('menuitem', { name: m.card_similar_titles() })).toBeNull();
    });

    it('keyboard opening targets this card even with another menu already in the document', async () => {
        const unrelatedMenu = document.createElement('div');
        unrelatedMenu.setAttribute('role', 'menu');
        const unrelatedEntry = document.createElement('button');
        unrelatedEntry.setAttribute('role', 'menuitem');
        unrelatedMenu.appendChild(unrelatedEntry);
        document.body.prepend(unrelatedMenu);
        try {
            const { container } = render(UniversalMediaCard, { item: movie });
            container.querySelector<HTMLElement>('.card-touch-root')!.focus();
            const trigger = await screen.findByRole('button', { name: m.card_actions_aria() });
            await fireEvent.click(trigger, { detail: 0 });
            await waitFor(() => {
                expect(document.activeElement?.getAttribute('role')).toBe('menuitem');
                expect(unrelatedMenu.contains(document.activeElement)).toBe(false);
            });
            expect(trigger.getAttribute('aria-controls')).toBe(
                document.activeElement?.closest('[role="menu"]')?.id,
            );
        } finally {
            unrelatedMenu.remove();
        }
    });

    it.each([false, true])(
        'Tab closes the portaled menu before normal navigation (shift=%s)',
        async (shiftKey) => {
            const { container } = render(UniversalMediaCard, { item: movie });
            container.querySelector<HTMLElement>('.card-touch-root')!.focus();
            const trigger = await screen.findByRole('button', { name: m.card_actions_aria() });
            await fireEvent.click(trigger, { detail: 0 });
            await waitFor(() =>
                expect(document.activeElement?.getAttribute('role')).toBe('menuitem'),
            );
            const event = new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey,
                bubbles: true,
                cancelable: true,
            });
            document.activeElement!.dispatchEvent(event);
            await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
            expect(event.defaultPrevented).toBe(false);
            expect(document.activeElement).toBe(trigger);
        },
    );

    it.each([false, true])(
        'Tab exits a separately portaled submenu (shift=%s)',
        async (shiftKey) => {
            const onClose = vi.fn();
            render(ContextMenu, {
                id: 'card-menu-probe',
                x: 40,
                y: 40,
                onClose,
                items: [
                    {
                        kind: 'submenu',
                        label: 'A submenu',
                        ...submenuComponent(SubmenuProbe, { marker: 'Probe' }),
                    },
                ],
            });
            await fireEvent.mouseEnter(screen.getByText('A submenu').closest('button')!);
            const entry = await screen.findByText('commit');
            entry.focus();
            expect(entry.closest('[role="menu"]')?.id).toBe('card-menu-probe-submenu');
            const event = new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey,
                bubbles: true,
                cancelable: true,
            });
            entry.dispatchEvent(event);
            expect(onClose).toHaveBeenCalledOnce();
            expect(event.defaultPrevented).toBe(false);
        },
    );

    it('keeps suspicious-watch warnings visible and actionable on hover', async () => {
        const { container } = render(UniversalMediaCard, {
            item: { ...movie, isSuspicious: true },
            variant: 'backdrop',
            showDismiss: true,
            alwaysShowDismiss: true,
            onremove: vi.fn(),
        });
        await fireEvent.mouseEnter(container.querySelector<HTMLElement>('.card-touch-root')!);
        await fireEvent.click(screen.getByRole('button', { name: m.ui_suspicious_bulk_watch() }), {
            detail: 1,
        });
        expect(screen.getByRole('menuitem', { name: m.card_hide() })).toBeTruthy();
    });

    it.each(['track', 'tvchannel'] as const)(
        'keeps the existing desktop dismissal for %s cards',
        async (mediaType) => {
            const onremove = vi.fn();
            const { container } = render(UniversalMediaCard, {
                item: { ...movie, mediaType },
                showDismiss: true,
                alwaysShowDismiss: true,
                onremove,
            });
            await fireEvent.mouseEnter(container.querySelector<HTMLElement>('.card-touch-root')!);
            await fireEvent.click(screen.getByRole('button', { name: m.card_hide() }));
            expect(onremove).toHaveBeenCalledOnce();
        },
    );

    it('Continue Watching keeps its scoped Hide label on progress-free Next Up episodes', async () => {
        const episode: UniversalMediaItem = {
            ...movie,
            mediaType: 'episode',
            seriesName: 'Night Signals',
            seriesId: '10000000-0000-0000-0000-000000000001',
            seasonNumber: 2,
            episodeNumber: 3,
            isNextUp: true,
        };
        const { container } = render(UniversalMediaCard, {
            item: episode,
            variant: 'backdrop',
            continueWatching: true,
            showDismiss: true,
            alwaysShowDismiss: true,
            onremove: vi.fn(),
        });
        await fireEvent.mouseEnter(container.querySelector<HTMLElement>('.card-touch-root')!);
        expect(container.textContent).toContain('S2:E3');
        expect(container.textContent).toContain('▶ Next');
        expect(
            screen.getByRole('button', { name: m.card_actions_aria() }).classList.contains('top-8'),
        ).toBe(true);
        await fireEvent.click(screen.getByRole('button', { name: m.card_actions_aria() }), {
            detail: 1,
        });
        expect(
            screen.getByRole('menuitem', {
                name: m.card_hide_title_from_continue_watching({ title: 'Night Signals' }),
            }),
        ).toBeTruthy();
    });
});
