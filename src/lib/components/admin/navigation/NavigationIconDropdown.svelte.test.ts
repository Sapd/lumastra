// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import NavigationIconDropdown from './NavigationIconDropdown.svelte';
import { navigationIconMap, iconsWithSuggestedFirst } from './navigation-icons';

const SUGGESTED = ['film', 'tv', 'sparkles'];
// Image icons occupy the option indices before the vector ones, so including
// them is what makes the index assertions able to catch an offset bug.
const LOCAL_ICONS = ['/icons/play.svg', '/icons/radarr.svg'];

function renderPicker(overrides: Record<string, unknown> = {}) {
    return render(NavigationIconDropdown, {
        value: '',
        availableIcons: iconsWithSuggestedFirst(SUGGESTED),
        suggestedIcons: SUGGESTED,
        availableLocalIcons: LOCAL_ICONS,
        ...overrides,
    });
}

/** Every option button, in the order the listbox renders them. */
function renderedOptions(): HTMLElement[] {
    return Array.from(document.querySelectorAll<HTMLElement>('[data-option-index]'));
}

describe('NavigationIconDropdown', () => {
    afterEach(() => cleanup());

    test('offers the whole catalog, not just the suggested handful', () => {
        renderPicker();
        // One option per icon, plus the "No icon" and "Custom path" rows.
        expect(renderedOptions().length).toBe(
            Object.keys(navigationIconMap).length + LOCAL_ICONS.length + 2,
        );
        expect(Object.keys(navigationIconMap).length).toBeGreaterThan(100);
    });

    test('lists the surface-specific suggestions ahead of the rest', () => {
        renderPicker();
        const labels = renderedOptions().map((el) => el.textContent?.trim());
        const firstIcon = labels.indexOf('film');
        const anAlphabeticalOne = labels.indexOf('academic-cap');
        expect(firstIcon).toBeGreaterThan(-1);
        expect(anAlphabeticalOne).toBeGreaterThan(firstIcon);
    });

    test('filters by substring across both groups', async () => {
        renderPicker();
        const filter = screen.getByPlaceholderText(/filter icons/i);

        await fireEvent.input(filter, { target: { value: 'music' } });

        const labels = renderedOptions()
            .map((el) => el.textContent?.trim() ?? '')
            .filter((label) => label !== 'No icon' && !label.startsWith('Custom path'));
        expect(labels.length).toBeGreaterThan(0);
        expect(labels.every((label) => label.includes('music'))).toBe(true);
        expect(labels).toContain('musical-note');
    });

    /**
     * The indices are what keyboard navigation addresses options by, and they
     * are computed from the filtered lists — an off-by-one between the markup's
     * offsets and the flat list would send arrow keys to the wrong icon, which
     * nothing else in the suite would notice.
     */
    test('option indices stay contiguous and in visual order while filtering', async () => {
        renderPicker();
        const filter = screen.getByPlaceholderText(/filter icons/i);

        for (const query of ['', 'arrow', 'music', 'zzz-no-such-icon']) {
            await fireEvent.input(filter, { target: { value: query } });
            const indices = renderedOptions().map((el) =>
                Number(el.dataset.optionIndex ?? Number.NaN),
            );
            expect(indices).toEqual(indices.map((_, position) => position));
        }
    });

    test('an empty result still leaves the "No icon" and custom-path rows', async () => {
        renderPicker();
        const filter = screen.getByPlaceholderText(/filter icons/i);

        await fireEvent.input(filter, { target: { value: 'zzz-no-such-icon' } });

        expect(renderedOptions().length).toBe(2);
    });

    test('hides the filter for a short curated list', () => {
        renderPicker({
            availableIcons: SUGGESTED,
            suggestedIcons: SUGGESTED,
            availableLocalIcons: [],
        });
        expect(screen.queryByPlaceholderText(/filter icons/i)).toBeNull();
    });

    test('reports the picked icon', async () => {
        const picked: string[] = [];
        renderPicker({ onChange: (value: string) => picked.push(value) });

        const option = renderedOptions().find((el) => el.textContent?.trim() === 'server-stack');
        expect(option).toBeTruthy();
        await fireEvent.click(option!);

        expect(picked).toEqual(['server-stack']);
    });
});
