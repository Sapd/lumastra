// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import HeroButtonsEditor from './HeroButtonsEditor.svelte';

/**
 * Local shape rather than the component's exported `HeroButton`: in a .ts file
 * the ambient `*.svelte` module declaration wins over svelte2tsx, so a type
 * import from the component does not resolve (TS2614).
 */
interface EmittedButton {
    id: string;
    // The component's own union, restated: a `.ts` file cannot import a type
    // from a `.svelte` module (the ambient `*.svelte` declaration wins), and a
    // plain `string` here does not satisfy the `links` prop.
    action: 'link' | 'search' | 'browse' | 'assistant';
    label: string;
    icon: string;
    url?: string;
    external?: boolean;
    enabled: boolean;
}

const JELLYFIN_CONNECT_URL = '/settings/connections?connect=jellyfin';

/**
 * Scoped to the header's quick-add row: a configured button carries the same
 * label down in the list, so an unscoped query matches two elements.
 */
function quickAddRow(): HTMLElement {
    const search = screen.getAllByRole('button', { name: /search/i })[0];
    return search.parentElement as HTMLElement;
}

function quickAddButton(): HTMLElement | null {
    return within(quickAddRow()).queryByRole('button', { name: /set up a jellyfin app/i });
}

describe('HeroButtonsEditor — Jellyfin connect quick-add', () => {
    afterEach(() => cleanup());

    test('is offered when the /j surface is enabled', () => {
        render(HeroButtonsEditor, { links: [], featureFlags: { jellyfinCompat: true } });
        expect(quickAddButton()).toBeTruthy();
    });

    /**
     * With jellyfinCompat off, /settings/connections ignores ?connect=jellyfin —
     * the button would lead to a page with no modal on it.
     */
    test('is hidden when the /j surface is disabled', () => {
        render(HeroButtonsEditor, { links: [], featureFlags: { jellyfinCompat: false } });
        expect(quickAddButton()).toBeNull();
    });

    test('is hidden when the flag is absent entirely', () => {
        render(HeroButtonsEditor, { links: [] });
        expect(quickAddButton()).toBeNull();
    });

    test('adds an ordinary link button with the deep link pre-filled', async () => {
        let emitted: EmittedButton[] = [];
        render(HeroButtonsEditor, {
            links: [],
            featureFlags: { jellyfinCompat: true },
            onchange: (detail: EmittedButton[]) => (emitted = detail),
        });

        await fireEvent.click(quickAddButton()!);

        expect(emitted).toHaveLength(1);
        expect(emitted[0]).toMatchObject({
            action: 'link',
            url: JELLYFIN_CONNECT_URL,
            icon: 'server-stack',
            enabled: true,
            // Internal navigation — a new tab would strand the viewer in settings.
            external: false,
        });
        expect(emitted[0].label).toBeTruthy();
        expect(emitted[0].id).toBeTruthy();
    });

    test('stops offering the quick-add once the button exists', () => {
        render(HeroButtonsEditor, {
            links: [
                {
                    id: 'existing',
                    action: 'link',
                    label: 'Connect Jellyfin client',
                    icon: 'server-stack',
                    url: JELLYFIN_CONNECT_URL,
                    external: false,
                    enabled: true,
                },
            ] satisfies EmittedButton[],
            featureFlags: { jellyfinCompat: true },
        });
        expect(quickAddButton()).toBeNull();
    });

    test('leaves the built-in quick-adds alone', () => {
        render(HeroButtonsEditor, { links: [], featureFlags: { jellyfinCompat: false } });
        expect(screen.getByRole('button', { name: /search/i })).toBeTruthy();
        expect(screen.getByRole('button', { name: /browse/i })).toBeTruthy();
    });
});
