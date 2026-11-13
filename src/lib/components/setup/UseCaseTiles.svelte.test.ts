// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The use-case tiles toggle a selection, but only colour showed it — a screen
 * reader heard three plain buttons with no state. Each tile must expose its
 * state via aria-pressed, stay a real (keyboard-operable) button, and the group
 * must be named by its heading.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import UseCaseTiles from './UseCaseTiles.svelte';
import { TRAINING_USE_CASE } from '$lib/config/use-case-ids';

afterEach(cleanup);

const options = [
    { id: 'vod', label: 'Movies & TV' },
    { id: 'music', label: 'Music' },
    { id: TRAINING_USE_CASE, label: 'Training', note: 'Lands on /learn' },
];

describe('UseCaseTiles', () => {
    it('exposes each tile as a toggle button with aria-pressed', () => {
        const { getByRole } = render(UseCaseTiles, {
            props: { options, selected: ['vod'], ontoggle: vi.fn() },
        });
        expect(getByRole('button', { name: 'Movies & TV' }).getAttribute('aria-pressed')).toBe(
            'true',
        );
        expect(getByRole('button', { name: 'Music' }).getAttribute('aria-pressed')).toBe('false');
        expect(getByRole('button', { name: /Training/ }).getAttribute('type')).toBe('button');
    });

    it('reports the toggled id on click, and flips aria-pressed when the parent updates', async () => {
        const ontoggle = vi.fn();
        const { getByRole, rerender } = render(UseCaseTiles, {
            props: { options, selected: ['vod'], ontoggle },
        });
        await fireEvent.click(getByRole('button', { name: 'Music' }));
        expect(ontoggle).toHaveBeenCalledWith('music');

        await rerender({ options, selected: ['vod', 'music'], ontoggle });
        expect(getByRole('button', { name: 'Music' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('names the group by its heading and draws a visible focus outline', () => {
        const { getByRole } = render(UseCaseTiles, {
            props: { options, selected: [], ontoggle: vi.fn(), labelledby: 'uc-title' },
        });
        expect(getByRole('group').getAttribute('aria-labelledby')).toBe('uc-title');
        for (const id of ['Movies & TV', 'Music']) {
            expect(getByRole('button', { name: id }).className).toContain(
                'focus-visible:outline-primary-400',
            );
        }
    });

    it('renders the note under the label', () => {
        const { getByRole } = render(UseCaseTiles, {
            props: { options, selected: [], ontoggle: vi.fn(), appearance: 'admin' },
        });
        expect(getByRole('button', { name: /Training/ }).textContent).toContain('Lands on /learn');
    });
});
