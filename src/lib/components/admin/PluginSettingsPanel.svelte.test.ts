// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Plugin settings: load -> edit -> save.
 *
 * The reload after a save reset the draft wholesale, so anything typed while
 * the save was in flight vanished and the panel claimed everything was saved.
 * And loads were not sequenced: an older answer (a previous plugin, a Retry)
 * could land after a newer one and replace the fields.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getSettings, updateSettings } = vi.hoisted(() => ({
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
}));

vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
    getPluginSettings: getSettings,
    updatePluginSettings: updateSettings,
    testPluginConnection: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: vi.fn(), success: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));

import PluginSettingsPanel from './PluginSettingsPanel.svelte';

const fields = [
    { key: 'name', label: 'Name', type: 'string', default: '' },
    { key: 'note', label: 'Note', type: 'string', default: '' },
];

function settingsResponse(current: Record<string, unknown>) {
    return { data: { settingsConfig: { fields }, currentSettings: current }, error: null };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => (resolve = r));
    return { promise, resolve };
}

function input(key: string): HTMLInputElement {
    return document.getElementById(key) as HTMLInputElement;
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

describe('PluginSettingsPanel', () => {
    it('keeps an edit typed while the save was in flight', async () => {
        getSettings.mockResolvedValueOnce(settingsResponse({ name: 'old', note: '' }));
        render(PluginSettingsPanel, { pluginId: 'demo', heading: 'Demo' });
        await waitFor(() => expect(input('name')).toBeTruthy());

        await fireEvent.input(input('name'), { target: { value: 'new' } });
        const put = deferred<{ error: null }>();
        updateSettings.mockReturnValueOnce(put.promise);
        await fireEvent.click(screen.getByRole('button', { name: /save/i }));

        // Typed after the request left.
        await fireEvent.input(input('note'), { target: { value: 'typed during save' } });

        getSettings.mockResolvedValueOnce(settingsResponse({ name: 'new', note: '' }));
        put.resolve({ error: null });

        await waitFor(() => expect(getSettings).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(screen.getByText(/unsaved/i)).toBeTruthy());
        expect(input('note').value).toBe('typed during save');
        expect(updateSettings).toHaveBeenCalledWith('demo', { settings: { name: 'new' } });
    });

    it('ignores an older load that answers after a newer one', async () => {
        const first = deferred<ReturnType<typeof settingsResponse>>();
        getSettings.mockReturnValueOnce(first.promise);
        const { rerender } = render(PluginSettingsPanel, { pluginId: 'a', heading: 'A' });

        getSettings.mockResolvedValueOnce(settingsResponse({ name: 'from b', note: '' }));
        await rerender({ pluginId: 'b', heading: 'B' });
        await waitFor(() => expect(input('name').value).toBe('from b'));

        first.resolve(settingsResponse({ name: 'from a', note: '' }));
        await new Promise((r) => setTimeout(r, 0));
        expect(input('name').value).toBe('from b');
    });
});
