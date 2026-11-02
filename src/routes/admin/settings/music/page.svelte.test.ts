// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * A tab switch is not a navigation, so the settings form's leave guard never
 * ran: switching to Quick Picks and back unmounted the form and dropped its
 * unsaved edits without a word.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'svelte';

vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ url: new URL('http://localhost/admin/settings/music'), state: {} }),
    };
});
vi.mock('$app/navigation', () => ({ replaceState: vi.fn() }));
vi.mock('$lib/components/admin', async () => ({
    AdminSettingsPage: (await import('./__fixtures__/DraftForm.svelte')).default,
}));
vi.mock('$lib/components/admin/settings-pages/MusicQuickPicksTab.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));
vi.mock('$lib/components/admin/settings-pages/MusicRadioTab.svelte', async () => ({
    default: (await import('../../library/media/__fixtures__/EmptyComponent.svelte')).default,
}));

import MusicPage from './+page.svelte';

afterEach(cleanup);

it('keeps unsaved settings when switching to another tab and back', async () => {
    render(MusicPage, {
        data: { quickPicks: {} },
        form: null,
    } as unknown as ComponentProps<typeof MusicPage>);

    await fireEvent.input(screen.getByLabelText('Draft'), { target: { value: 'unsaved edit' } });
    await fireEvent.click(screen.getByRole('tab', { name: /quick picks/i }));
    await fireEvent.click(screen.getByRole('tab', { name: 'Music' }));

    expect((screen.getByLabelText('Draft') as HTMLInputElement).value).toBe('unsaved edit');
});
