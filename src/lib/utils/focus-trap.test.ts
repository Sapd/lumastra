// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { trapFocus } from './focus-trap';

/**
 * Unit tests for the `trapFocus` Svelte action.
 *
 * These exercise the DOM contract directly (no Svelte component harness) so
 * we can dispatch keyboard events at specific elements and inspect focus
 * without mounting a host component. Every test mounts a detached container
 * into `document.body` and cleans up in `afterEach`.
 */
describe('trapFocus action', () => {
    let container: HTMLDivElement;
    let outsideBefore: HTMLButtonElement;
    let outsideAfter: HTMLButtonElement;
    let first: HTMLButtonElement;
    let middle: HTMLButtonElement;
    let last: HTMLButtonElement;

    beforeEach(() => {
        // Outside siblings exist to simulate the "page behind the modal" —
        // focus should never land on them while the trap is active.
        outsideBefore = document.createElement('button');
        outsideBefore.textContent = 'before';
        document.body.appendChild(outsideBefore);

        container = document.createElement('div');
        first = document.createElement('button');
        first.textContent = 'first';
        middle = document.createElement('button');
        middle.textContent = 'middle';
        last = document.createElement('button');
        last.textContent = 'last';
        container.appendChild(first);
        container.appendChild(middle);
        container.appendChild(last);
        document.body.appendChild(container);

        outsideAfter = document.createElement('button');
        outsideAfter.textContent = 'after';
        document.body.appendChild(outsideAfter);
    });

    afterEach(() => {
        outsideBefore.remove();
        container.remove();
        outsideAfter.remove();
    });

    function dispatchTab(target: HTMLElement, shift = false): void {
        target.dispatchEvent(
            new KeyboardEvent('keydown', {
                key: 'Tab',
                shiftKey: shift,
                bubbles: true,
                cancelable: true,
            }),
        );
    }

    test('excludes responsive-hidden ancestors and hidden autofocus targets', async () => {
        const hidden = document.createElement('div');
        hidden.style.display = 'none';
        container.insertBefore(hidden, first);
        hidden.appendChild(first);
        first.setAttribute('data-autofocus', '');
        trapFocus(container);
        await Promise.resolve();
        expect(document.activeElement).toBe(middle);
        last.focus();
        dispatchTab(last);
        expect(document.activeElement).toBe(middle);
    });

    test('excludes inert descendants and negative tabindex buttons', async () => {
        const inert = document.createElement('div');
        inert.setAttribute('inert', '');
        container.insertBefore(inert, first);
        inert.appendChild(first);
        last.tabIndex = -1;
        trapFocus(container);
        await Promise.resolve();
        expect(document.activeElement).toBe(middle);
        dispatchTab(middle, true);
        expect(document.activeElement).toBe(middle);
    });

    test('leaves native modal dialog focus handling to the browser', async () => {
        const dialog = document.createElement('dialog');
        dialog.setAttribute('open', '');
        dialog.appendChild(last);
        container.appendChild(dialog);
        trapFocus(container);
        await Promise.resolve();
        last.focus();
        const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
        last.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });

    test('autofocuses the first focusable when no [data-autofocus] is set', async () => {
        outsideBefore.focus();
        expect(document.activeElement).toBe(outsideBefore);

        trapFocus(container);
        // queueMicrotask flush
        await Promise.resolve();
        await Promise.resolve();

        expect(document.activeElement).toBe(first);
    });

    test('autofocuses [data-autofocus] element when present', async () => {
        middle.setAttribute('data-autofocus', '');

        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        expect(document.activeElement).toBe(middle);
    });

    test('Tab from last focusable wraps to first', async () => {
        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        last.focus();
        expect(document.activeElement).toBe(last);

        dispatchTab(last);
        expect(document.activeElement).toBe(first);
    });

    test('Shift+Tab from first focusable wraps to last', async () => {
        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        first.focus();
        dispatchTab(first, true);
        expect(document.activeElement).toBe(last);
    });

    test('Tab from middle focusable does not intervene (native flow)', async () => {
        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        middle.focus();
        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        middle.dispatchEvent(event);

        // From the middle element neither the first nor the last branch applies,
        // so the trap must NOT call preventDefault() — native tab cycles to the
        // next sibling (browser-native behavior; we just verify we didn't block).
        expect(event.defaultPrevented).toBe(false);
    });

    test('skips disabled focusables when computing boundaries', async () => {
        last.setAttribute('disabled', '');

        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        middle.focus();
        dispatchTab(middle);
        // With `last` disabled the boundary collapses to `middle`, so Tab
        // from middle should wrap to `first`.
        expect(document.activeElement).toBe(first);
    });

    test('returns focus to previously-focused element on destroy', async () => {
        outsideBefore.focus();
        expect(document.activeElement).toBe(outsideBefore);

        const handle = trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        last.focus();
        expect(document.activeElement).toBe(last);

        handle?.destroy?.();
        expect(document.activeElement).toBe(outsideBefore);
    });

    test('destroy does not throw when previous element was removed', async () => {
        outsideBefore.focus();

        const handle = trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        outsideBefore.remove();

        // Should silently no-op rather than throwing — DOM-removed element
        // cannot receive focus, and we guard with `document.contains`.
        expect(() => handle?.destroy?.()).not.toThrow();
    });

    test('autofocus microtask is a no-op after node is immediately destroyed', async () => {
        // Simulate the race where a parent toggles {#if open} true then false
        // synchronously. The microtask fires after destroy; node is detached.
        outsideBefore.focus();
        const initialFocus = document.activeElement;

        const handle = trapFocus(container);
        // Remove the container before the microtask resolves
        container.remove();
        handle?.destroy?.();

        // Flush the microtask queue
        await Promise.resolve();
        await Promise.resolve();

        // Focus must NOT have moved to any element inside the detached container
        expect(document.body.contains(document.activeElement)).toBe(true);
        expect(document.activeElement).toBe(initialFocus);
    });

    test('does not match input[type="hidden"] in focusable list', async () => {
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        container.insertBefore(hidden, first);

        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        // Hidden input must not be the autofocus target
        expect(document.activeElement).toBe(first);

        // Tab from last should wrap to first (not hidden)
        last.focus();
        dispatchTab(last);
        expect(document.activeElement).toBe(first);
    });

    test('stopPropagation prevents outer trap from also acting on Tab', async () => {
        // Outer container wraps the inner one — both have trapFocus.
        const outer = document.createElement('div');
        const outerFirst = document.createElement('button');
        outerFirst.textContent = 'outer-first';
        const outerLast = document.createElement('button');
        outerLast.textContent = 'outer-last';
        outer.appendChild(outerFirst);
        outer.appendChild(container);
        outer.appendChild(outerLast);
        document.body.appendChild(outer);

        trapFocus(outer);
        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        last.focus();
        const event = new KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        });
        last.dispatchEvent(event);

        // Inner trap handled it (focus moved to first inside container)
        // and stopPropagation prevented outer trap from also firing.
        expect(document.activeElement).toBe(first);
        // Event was prevented (inner trap acted)
        expect(event.defaultPrevented).toBe(true);

        outer.remove();
    });

    test('wraps correctly when active element has been removed from focusable list (disabled between Tab presses)', async () => {
        trapFocus(container);
        await Promise.resolve();
        await Promise.resolve();

        // Focus last, then disable it — simulates a button going disabled between Tab presses
        last.focus();
        expect(document.activeElement).toBe(last);
        last.setAttribute('disabled', '');

        // Dispatch Tab — active element is now out of focusable list (index === -1)
        dispatchTab(last);
        // Should wrap to first (not get stuck or do nothing)
        expect(document.activeElement).toBe(first);

        // Restore for cleanup
        last.removeAttribute('disabled');
    });
});
