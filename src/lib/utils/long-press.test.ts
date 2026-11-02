// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { longPress } from './long-press';

describe('longPress action', () => {
    let node: HTMLDivElement;
    let button: HTMLButtonElement;

    beforeEach(() => {
        vi.useFakeTimers();
        node = document.createElement('div');
        button = document.createElement('button');
        button.textContent = 'Nested action';
        node.appendChild(button);
        document.body.appendChild(node);
    });

    afterEach(() => {
        node.remove();
        vi.useRealTimers();
    });

    function dispatchTouch(
        target: HTMLElement,
        type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
        touches: Array<{
            identifier: number;
            clientX: number;
            clientY: number;
            target: HTMLElement;
        }>,
    ): void {
        const event = new Event(type, {
            bubbles: true,
            cancelable: true,
        });
        Object.defineProperty(event, 'touches', {
            value: touches,
        });
        target.dispatchEvent(event);
    }

    it('ignores nested interactive targets by default', () => {
        const onPress = vi.fn();
        longPress(node, { duration: 300, onPress });

        dispatchTouch(button, 'touchstart', [
            { identifier: 1, clientX: 20, clientY: 20, target: button },
        ]);
        vi.advanceTimersByTime(300);

        expect(onPress).not.toHaveBeenCalled();
    });

    it('can fire from nested interactive targets when opted in', () => {
        const onPress = vi.fn();
        const eventListener = vi.fn();
        longPress(node, {
            duration: 300,
            ignoreInteractive: false,
            onPress,
        });
        node.addEventListener('longpress', eventListener);

        dispatchTouch(button, 'touchstart', [
            { identifier: 1, clientX: 20, clientY: 30, target: button },
        ]);
        vi.advanceTimersByTime(300);

        expect(onPress).toHaveBeenCalledWith({ x: 20, y: 30 });
        expect(eventListener).toHaveBeenCalledOnce();
        expect(eventListener.mock.calls[0][0]).toMatchObject({
            detail: { x: 20, y: 30 },
        });
    });

    it('cancels when touch movement exceeds the touch threshold', () => {
        const onPress = vi.fn();
        longPress(node, {
            duration: 300,
            touchMoveThreshold: 10,
            ignoreInteractive: false,
            onPress,
        });

        dispatchTouch(button, 'touchstart', [
            { identifier: 1, clientX: 20, clientY: 20, target: button },
        ]);
        dispatchTouch(button, 'touchmove', [
            { identifier: 1, clientX: 40, clientY: 20, target: button },
        ]);
        vi.advanceTimersByTime(300);

        expect(onPress).not.toHaveBeenCalled();
    });

    it('still observes touches when a descendant stops bubbling', () => {
        const onPress = vi.fn();
        button.addEventListener('touchstart', (e) => e.stopPropagation());
        button.addEventListener('touchmove', (e) => e.stopPropagation());
        longPress(node, {
            duration: 300,
            touchMoveThreshold: 10,
            ignoreInteractive: false,
            onPress,
        });

        dispatchTouch(button, 'touchstart', [
            { identifier: 1, clientX: 20, clientY: 20, target: button },
        ]);
        dispatchTouch(button, 'touchmove', [
            { identifier: 1, clientX: 25, clientY: 20, target: button },
        ]);
        vi.advanceTimersByTime(300);

        expect(onPress).toHaveBeenCalledOnce();
    });

    it('suppresses the first global click after a touch long-press release', () => {
        const onPress = vi.fn();
        const outside = document.createElement('button');
        const outsideClick = vi.fn();
        outside.addEventListener('click', outsideClick);
        document.body.appendChild(outside);
        longPress(node, {
            duration: 300,
            ignoreInteractive: false,
            onPress,
        });

        dispatchTouch(button, 'touchstart', [
            { identifier: 1, clientX: 20, clientY: 30, target: button },
        ]);
        vi.advanceTimersByTime(300);
        dispatchTouch(button, 'touchend', []);

        const click = new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
        });
        outside.dispatchEvent(click);

        expect(onPress).toHaveBeenCalledOnce();
        expect(click.defaultPrevented).toBe(true);
        expect(outsideClick).not.toHaveBeenCalled();

        outside.remove();
    });
});
