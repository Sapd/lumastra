// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/stores', () => ({ navigating: { subscribe: () => () => {} } }));

import { popup } from './popup';

function setup(focusOnOpen = false) {
    document.body.innerHTML = `
        <button id="trigger">Open</button>
        <div data-popup="menu"><a href="/x" id="first">First</a><a href="/y">Second</a></div>
        <button id="after">After</button>`;
    const trigger = document.getElementById('trigger') as HTMLButtonElement;
    const menu = document.querySelector('[data-popup="menu"]') as HTMLElement;
    const action = popup(trigger, { event: 'click', target: 'menu', focusOnOpen });
    return { trigger, menu, action };
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('popup (click)', () => {
    it('tells assistive tech whether it is open', () => {
        const { trigger, action } = setup();
        expect(trigger.getAttribute('aria-haspopup')).toBe('true');
        expect(trigger.getAttribute('aria-expanded')).toBe('false');
        trigger.click();
        expect(trigger.getAttribute('aria-expanded')).toBe('true');
        action.destroy?.();
    });

    // The account menu ignored Escape and stayed open.
    it('Escape closes it and returns focus to the trigger', async () => {
        const { trigger, menu, action } = setup(true);
        trigger.click();
        await new Promise((r) => requestAnimationFrame(() => r(null)));
        expect(document.activeElement?.id).toBe('first');
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        expect(menu.classList.contains('popup-visible')).toBe(false);
        expect(document.activeElement).toBe(trigger);
        action.destroy?.();
    });

    it('closes when focus leaves it', () => {
        const { trigger, menu, action } = setup();
        trigger.click();
        const after = document.getElementById('after') as HTMLButtonElement;
        menu.dispatchEvent(new FocusEvent('focusout', { relatedTarget: after, bubbles: true }));
        expect(menu.classList.contains('popup-visible')).toBe(false);
        action.destroy?.();
    });
});
