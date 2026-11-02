// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { afterEach, describe, expect, test } from 'vitest';
import { handleMusicSearchShortcut } from './music-search-shortcut';

function setup(): HTMLInputElement {
    const input = document.createElement('input');
    document.body.append(input);
    // happy-dom reports no layout boxes; the helper treats that as "hidden".
    input.getClientRects = () => [{}] as unknown as DOMRectList;
    return input;
}

function press(
    target: EventTarget,
    init: NonNullable<ConstructorParameters<typeof KeyboardEvent>[1]>,
): KeyboardEvent {
    const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
    Object.defineProperty(e, 'target', { value: target });
    return e;
}

describe('handleMusicSearchShortcut', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    test.each([{ key: 'f', metaKey: true }, { key: 'f', ctrlKey: true }, { key: '/' }])(
        'focuses the search input on %o',
        (init) => {
            const input = setup();
            const e = press(document.body, init);
            handleMusicSearchShortcut(e, input);
            expect(e.defaultPrevented).toBe(true);
            expect(document.activeElement).toBe(input);
        },
    );

    test('a second ⌘F from inside a text field falls through to native find', () => {
        const input = setup();
        input.focus();
        const e = press(input, { key: 'f', metaKey: true });
        handleMusicSearchShortcut(e, input);
        expect(e.defaultPrevented).toBe(false);
    });

    test('does nothing while a modal dialog is open or the input is hidden', () => {
        const input = setup();
        const dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-modal', 'true');
        document.body.append(dialog);
        const e1 = press(document.body, { key: 'f', metaKey: true });
        handleMusicSearchShortcut(e1, input);
        expect(e1.defaultPrevented).toBe(false);
        dialog.remove();

        input.getClientRects = () => [] as unknown as DOMRectList;
        const e2 = press(document.body, { key: '/' });
        handleMusicSearchShortcut(e2, input);
        expect(e2.defaultPrevented).toBe(false);
    });

    test('ignores ⌘⇧F and plain letters', () => {
        const input = setup();
        for (const init of [{ key: 'F', metaKey: true, shiftKey: true }, { key: 'f' }]) {
            const e = press(document.body, init);
            handleMusicSearchShortcut(e, input);
            expect(e.defaultPrevented).toBe(false);
        }
    });
});
