// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
vi.mock('$app/stores', () => ({
    page: readable({ data: { mediaLanguagePriority: ['de-DE', 'en', 'fr'] } }),
}));
import LanguageBadges from './LanguageBadges.svelte';
afterEach(cleanup);

test('prioritizes server languages separately and exposes the complete list', async () => {
    const view = render(LanguageBadges, {
        audioLanguages: ['ara', 'fra', 'eng', 'deu', 'ger'],
        subtitleLanguages: ['jpn', 'fra', 'de', 'eng', 'ita'],
    });
    expect(view.container.querySelector('[data-language-kind="audio"]')?.textContent).toMatch(
        /DE.*EN.*\+2/s,
    );
    expect(view.container.querySelector('[data-language-kind="subtitles"]')?.textContent).toMatch(
        /DE.*EN.*\+3/s,
    );
    const overflow = screen.getAllByRole('button')[0];
    await fireEvent.focus(overflow);
    expect(screen.getByRole('region').textContent).toContain('German');
    await fireEvent.click(overflow);
    await fireEvent.mouseLeave(overflow);
    expect(overflow.getAttribute('aria-expanded')).toBe('true');
    await fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('region')).toBeNull();
    await fireEvent.click(overflow);
    await fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('region')).toBeNull();
});
test('no overflow control when all normalized languages fit', () => {
    render(LanguageBadges, { audioLanguages: ['ger', 'deu', 'eng'] });
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.getByText('DE')).toBeTruthy();
});
