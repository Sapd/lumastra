// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, waitFor } from '@testing-library/svelte';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vitest';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/utils/modal-utils', () => ({ openArtistModal: vi.fn() }));

const trackItem: UniversalMediaItem = {
    id: 'track-1',
    itemKey: 'qp:rotation:track-1',
    externalIds: {},
    mediaType: 'track',
    title: 'Harbortime',
    image: '/api/image/catalog/track-1?size=poster',
    isAvailable: true,
    canRequest: false,
    artists: [{ id: 'artist-1', title: 'Artist' }],
};

function dispatchTouch(
    target: HTMLElement,
    type: 'touchstart' | 'touchmove' | 'touchend',
    touches: Array<{ clientX: number; clientY: number }>,
): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: touches });
    target.dispatchEvent(event);
    return event;
}

describe('UniversalMediaCard touch context menu', () => {
    beforeEach(() => {
        window.matchMedia = vi.fn().mockImplementation(
            () =>
                ({
                    matches: false,
                    addEventListener: vi.fn(),
                    removeEventListener: vi.fn(),
                }) as unknown as MediaQueryList,
        );
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    async function renderTouchCard(): Promise<{
        container: HTMLElement;
        card: HTMLElement;
        actionsButton: HTMLButtonElement;
    }> {
        const { container } = render(UniversalMediaCard, {
            props: { item: trackItem },
        });
        const card = container.querySelector<HTMLElement>('.card-touch-root');
        expect(card).toBeTruthy();

        let actionsButton: HTMLButtonElement | null = null;
        await waitFor(() => {
            actionsButton = container.querySelector<HTMLButtonElement>(
                'button[class*="top-1"][class*="right-1"]',
            );
            expect(actionsButton).toBeTruthy();
        });

        return { container, card: card!, actionsButton: actionsButton! };
    }

    it('does not open from a poster-body press or touch-generated contextmenu', async () => {
        const { card } = await renderTouchCard();

        vi.useFakeTimers();
        dispatchTouch(card, 'touchstart', [{ clientX: 40, clientY: 60 }]);
        dispatchTouch(card, 'touchmove', [{ clientX: 40, clientY: 80 }]);
        vi.advanceTimersByTime(300);
        expect(document.querySelector('[role="menu"]')).toBeNull();
        dispatchTouch(card, 'touchend', []);
        vi.useRealTimers();

        const contextMenuEvent = new MouseEvent('contextmenu', {
            bubbles: true,
            cancelable: true,
            clientX: 40,
            clientY: 60,
        });
        card.dispatchEvent(contextMenuEvent);

        expect(contextMenuEvent.defaultPrevented).toBe(true);
        expect(document.querySelector('[role="menu"]')).toBeNull();
    });

    it('opens from a deliberate press and release on the three-dot button', async () => {
        const { actionsButton } = await renderTouchCard();

        dispatchTouch(actionsButton, 'touchstart', [{ clientX: 100, clientY: 100 }]);
        dispatchTouch(actionsButton, 'touchmove', [{ clientX: 106, clientY: 105 }]);
        dispatchTouch(actionsButton, 'touchend', []);

        await waitFor(() => expect(document.querySelector('[role="menu"]')).toBeTruthy());
    });

    it('does not open when the page moves during a three-dot press', async () => {
        const { actionsButton } = await renderTouchCard();

        dispatchTouch(actionsButton, 'touchstart', [{ clientX: 100, clientY: 100 }]);
        dispatchTouch(actionsButton, 'touchmove', [{ clientX: 100, clientY: 125 }]);
        dispatchTouch(actionsButton, 'touchend', []);
        actionsButton.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

        expect(document.querySelector('[role="menu"]')).toBeNull();
    });
});
