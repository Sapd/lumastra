// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The confirm sheet is opened from inside the media modal. The REAL ModalContainer (its window
 * Tab trap and Escape handler) is mounted here: the sheet must be the topmost overlay for the
 * keyboard, and the "..." menu popover must not be thrown out of the modal by that trap.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { tick } from 'svelte';

vi.mock('$app/paths', () => ({ base: '' }));
const { toast } = vi.hoisted(() => ({
    toast: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), success: vi.fn() },
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: toast }));

import ModalContainer from '$lib/components/ui/ModalContainer.svelte';
import ModalFixture from '$lib/components/ui/modal-container-fixture.svelte';
import DownloadConfirmSheet from './DownloadConfirmSheet.svelte';
import { downloadQueue } from '$lib/downloads/download-queue.svelte';
import { modals } from '$lib/stores/modal.store';

function stubList() {
    const mk = (n: number) => ({
        mediaItemId: `ep-${n}`,
        fileId: `f-${n}`,
        season: 1,
        episode: n,
        seasonFolder: 'Season 01',
        fileName: `Show - S01E0${n}.mkv`,
        sizeBytes: 1000,
        available: true,
    });
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        allowed: true,
                        maxParallel: 3,
                        seriesFolder: 'Show (2020)',
                        missingCount: 0,
                        items: [mk(1), mk(2)],
                    }),
                ),
        ),
    );
}

async function settle() {
    await tick();
    await new Promise((r) => setTimeout(r, 20));
    await tick();
}

async function openSheetOverModal() {
    render(ModalContainer);
    render(DownloadConfirmSheet);
    modals.open(ModalFixture, {});
    await settle();
    const opener = screen.getByTestId('inner-button');
    opener.focus();
    await downloadQueue.enqueue('movie-1');
    await settle();
    return { opener, sheet: await screen.findByTestId('download-confirm-sheet') };
}

afterEach(async () => {
    downloadQueue.dismissPending();
    await modals.closeAll();
    cleanup();
    vi.unstubAllGlobals();
});

describe('download sheet above the media modal', () => {
    test('Tab wraps inside the sheet; the modal trap does not pull focus out', async () => {
        stubList();
        const { sheet } = await openSheetOverModal();
        const start = screen.getByTestId('download-start');
        start.focus();
        const notPrevented = await fireEvent.keyDown(start, { key: 'Tab' });
        expect(notPrevented).toBe(false);
        expect(sheet.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).not.toBe(start);

        const first = document.activeElement as HTMLElement;
        await fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
        expect(sheet.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toBe(start);
    });

    test('Escape closes only the sheet, then focus returns to the opener', async () => {
        stubList();
        const { opener } = await openSheetOverModal();
        expect(modals.count).toBe(1);
        await fireEvent.keyDown(screen.getByTestId('download-start'), { key: 'Escape' });
        await settle();
        expect(downloadQueue.pending).toBeNull();
        expect(modals.count).toBe(1);
        await waitFor(() => expect(document.activeElement).toBe(opener));
        // the next Escape is the modal's
        await fireEvent.keyDown(opener, { key: 'Escape' });
        await settle();
        expect(modals.count).toBe(0);
    });

    test('Shift+Tab from the first tab stop wraps inside the sheet when "season" follows an unchecked radio', async () => {
        const mk = (season: number, n: number) => ({
            mediaItemId: `s${season}e${n}`,
            fileId: `f${season}${n}`,
            season,
            episode: n,
            seasonFolder: 'Season 01',
            fileName: `Show - S0${season}E0${n}.mkv`,
            sizeBytes: 1000,
            available: true,
        });
        vi.stubGlobal(
            'fetch',
            vi.fn(
                async () =>
                    new Response(
                        JSON.stringify({
                            allowed: true,
                            maxParallel: 3,
                            seriesFolder: 'Show',
                            missingCount: 0,
                            items: [mk(1, 1), mk(1, 2), mk(1, 3), mk(2, 1)],
                        }),
                    ),
            ),
        );
        render(ModalContainer);
        render(DownloadConfirmSheet);
        modals.open(ModalFixture, {});
        await settle();
        screen.getByTestId('inner-button').focus();
        await downloadQueue.enqueueSeries('series-1', { scope: 'season', season: 1 });
        await settle();
        const sheet = await screen.findByTestId('download-confirm-sheet');
        const season = screen.getByTestId('download-scope-season') as HTMLInputElement;
        expect(season.checked).toBe(true);
        expect((screen.getByTestId('download-scope-custom') as HTMLInputElement).checked).toBe(
            false,
        );
        season.focus();
        const notPrevented = await fireEvent.keyDown(season, { key: 'Tab', shiftKey: true });
        expect(notPrevented).toBe(false);
        expect(document.activeElement).toBe(screen.getByTestId('download-start'));
        expect(sheet.contains(document.activeElement)).toBe(true);
        // and forward from the last stop wraps to the checked radio, not an unchecked one
        await fireEvent.keyDown(screen.getByTestId('download-start'), { key: 'Tab' });
        expect(document.activeElement).toBe(season);
    });

    describe('"..." menu keyboard (menu button pattern)', () => {
        async function openMenu() {
            render(ModalContainer);
            const Holder = (await import('./download-menu-fixture.svelte')).default;
            modals.open(Holder, {});
            await settle();
            const trigger = screen.getByRole('button', { name: 'More' });
            trigger.focus();
            await fireEvent.click(trigger);
            await settle();
            await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('menu-item')));
            return trigger;
        }

        test('arrows wrap, Home/End jump, so the last entry is reachable', async () => {
            await openMenu();
            const first = screen.getByTestId('menu-item');
            const admin = screen.getByTestId('menu-item-admin');
            await fireEvent.keyDown(first, { key: 'ArrowDown' });
            expect(document.activeElement).toBe(screen.getByTestId('menu-item-2'));
            await fireEvent.keyDown(document.activeElement!, { key: 'ArrowDown' });
            expect(document.activeElement).toBe(admin);
            await fireEvent.keyDown(admin, { key: 'ArrowDown' });
            expect(document.activeElement).toBe(first);
            await fireEvent.keyDown(first, { key: 'ArrowUp' });
            expect(document.activeElement).toBe(admin);
            await fireEvent.keyDown(admin, { key: 'Home' });
            expect(document.activeElement).toBe(first);
            await fireEvent.keyDown(first, { key: 'End' });
            expect(document.activeElement).toBe(admin);
        });

        test('Escape closes only the menu and returns focus to the trigger', async () => {
            const trigger = await openMenu();
            await fireEvent.keyDown(screen.getByTestId('menu-item'), { key: 'Escape' });
            await settle();
            expect(screen.queryByTestId('menu-item')).toBeNull();
            expect(modals.count).toBe(1);
            expect(document.activeElement).toBe(trigger);
        });

        test('Tab closes the menu with focus on the trigger, so the next control follows', async () => {
            const trigger = await openMenu();
            const notPrevented = await fireEvent.keyDown(screen.getByTestId('menu-item'), {
                key: 'Tab',
            });
            await settle();
            expect(screen.queryByTestId('menu-item')).toBeNull();
            // not prevented: the browser moves on from the trigger to the control after it
            expect(notPrevented).toBe(true);
            expect(document.activeElement).toBe(trigger);
            expect(
                trigger.compareDocumentPosition(screen.getByTestId('after-trigger')) &
                    Node.DOCUMENT_POSITION_FOLLOWING,
            ).toBeTruthy();
        });

        test('with the menu closed the modal trap applies: Tab on the last control wraps', async () => {
            await openMenu();
            await fireEvent.keyDown(screen.getByTestId('menu-item'), { key: 'Tab' });
            await settle();
            const last = screen.getByTestId('after-trigger');
            last.focus();
            const notPrevented = await fireEvent.keyDown(last, { key: 'Tab' });
            expect(notPrevented).toBe(false);
            expect(document.activeElement).toBe(screen.getByTestId('inner-button'));
        });
    });
});
