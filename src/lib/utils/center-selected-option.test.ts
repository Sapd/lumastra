// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';
import { centerSelectedOption } from './center-selected-option';

/**
 * happy-dom has no layout engine — every offset reads 0, so an assertion on
 * `scrollTop` against real elements would pass no matter what the maths did.
 * These tests stub the three geometry reads: option rows are `OPTION_H` tall
 * and stacked inside a `LIST_H`-tall scroll container.
 */
const OPTION_H = 60;
const LIST_H = 300;

let restoreGeometry: (() => void) | null = null;

function stubGeometry(): void {
    const saved = new Map<string, PropertyDescriptor | undefined>();
    const define = (prop: string, get: (this: HTMLElement) => number) => {
        saved.set(prop, Object.getOwnPropertyDescriptor(HTMLElement.prototype, prop));
        Object.defineProperty(HTMLElement.prototype, prop, { configurable: true, get });
    };
    const isOption = (el: HTMLElement) => el.getAttribute('role') === 'option';
    define('offsetTop', function (this: HTMLElement) {
        if (!isOption(this)) return 0;
        const siblings = Array.from(this.parentElement?.querySelectorAll('[role="option"]') ?? []);
        return siblings.indexOf(this) * OPTION_H;
    });
    define('offsetHeight', function (this: HTMLElement) {
        return isOption(this) ? OPTION_H : 0;
    });
    define('clientHeight', function (this: HTMLElement) {
        return this.getAttribute('role') === 'listbox' ? LIST_H : 0;
    });
    restoreGeometry = () => {
        for (const [prop, descriptor] of saved) {
            if (descriptor) Object.defineProperty(HTMLElement.prototype, prop, descriptor);
            else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[prop];
        }
    };
}

/** Build a listbox of `count` options with `selectedIndex` marked selected. */
function buildList(count: number, selectedIndex: number | null): HTMLElement {
    const list = document.createElement('div');
    list.setAttribute('role', 'listbox');
    for (let i = 0; i < count; i++) {
        const option = document.createElement('button');
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', String(i === selectedIndex));
        option.textContent = `Season ${i + 1}`;
        list.appendChild(option);
    }
    document.body.appendChild(list);
    return list;
}

describe('centerSelectedOption', () => {
    afterEach(() => {
        restoreGeometry?.();
        restoreGeometry = null;
        document.body.innerHTML = '';
    });

    test('centres a selected option that sits far down the list', () => {
        stubGeometry();
        const list = buildList(20, 14); // season 15 of 20

        centerSelectedOption(list);

        // 14 * 60 = 840px from the top, minus half the leftover viewport
        // height ((300 - 60) / 2 = 120) to sit in the middle of the band.
        expect(list.scrollTop).toBe(720);
    });

    test('never scrolls above the first option', () => {
        stubGeometry();
        const list = buildList(20, 0);

        centerSelectedOption(list);

        // 0 - 120 would be negative; the list stays pinned at the top.
        expect(list.scrollTop).toBe(0);
    });

    test('leaves the list alone when nothing is selected', () => {
        stubGeometry();
        const list = buildList(20, null);
        list.scrollTop = 42;

        centerSelectedOption(list);

        expect(list.scrollTop).toBe(42);
    });

    test('is a no-op for an unmounted list', () => {
        expect(() => centerSelectedOption(undefined)).not.toThrow();
        expect(() => centerSelectedOption(null)).not.toThrow();
    });
});
