// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dragScroll } from './drag-scroll';

describe('dragScroll — card drag vs row scroll', () => {
    let row: HTMLDivElement;
    let card: HTMLDivElement;
    let action: ReturnType<typeof dragScroll>;
    let cardDragStart: ReturnType<typeof vi.fn<(e: Event) => void>>;

    beforeEach(() => {
        row = document.createElement('div');
        card = document.createElement('div');
        card.setAttribute('draggable', 'true');
        card.dataset['dragScrollAllow'] = '';
        cardDragStart = vi.fn();
        card.addEventListener('dragstart', cardDragStart);
        row.appendChild(card);
        document.body.appendChild(row);
        action = dragScroll(row);
    });

    afterEach(() => {
        action.destroy?.();
        row.remove();
    });

    function press(x: number, y: number) {
        card.dispatchEvent(
            new MouseEvent('mousedown', { bubbles: true, button: 0, clientX: x, clientY: y }),
        );
    }

    // happy-dom has no DragEvent; the action only reads clientX/Y.
    function dragStart(x: number, y: number) {
        const e = new MouseEvent('dragstart', {
            bubbles: true,
            cancelable: true,
            clientX: x,
            clientY: y,
        });
        card.dispatchEvent(e);
        return e;
    }

    it('cancels the card drag when the gesture starts horizontally', () => {
        press(100, 100);
        const e = dragStart(106, 101);
        expect(e.defaultPrevented).toBe(true);
        expect(cardDragStart).not.toHaveBeenCalled();
    });

    it('lets the card drag through when the gesture starts vertically', () => {
        press(100, 100);
        const e = dragStart(101, 106);
        expect(e.defaultPrevented).toBe(false);
        expect(cardDragStart).toHaveBeenCalledOnce();
        expect(row.style.cursor).toBe('grab');
    });

    it('reads the direction from the last mousemove, not the dragstart coordinates', () => {
        // Chromium stamps dragstart with the mousedown position.
        press(100, 100);
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 101, clientY: 108 }));
        const e = dragStart(100, 100);
        expect(e.defaultPrevented).toBe(false);
        expect(cardDragStart).toHaveBeenCalledOnce();
    });

    it('cancels after a horizontal mousemove even when dragstart reports 0/0', () => {
        press(100, 100);
        window.dispatchEvent(new MouseEvent('mousemove', { clientX: 108, clientY: 101 }));
        const e = dragStart(0, 0);
        expect(e.defaultPrevented).toBe(true);
        expect(cardDragStart).not.toHaveBeenCalled();
    });

    it('still suppresses native drags from non-card elements', () => {
        const img = document.createElement('img');
        row.appendChild(img);
        const e = new MouseEvent('dragstart', { bubbles: true, cancelable: true });
        img.dispatchEvent(e);
        expect(e.defaultPrevented).toBe(true);
    });
});
