// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Library types (sidebar names/icons/order for non-entertainment libraries),
 * now on Settings → Homepage & navigation. One Save writes only the rows that
 * changed; an unused type says its entry will not show yet.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const api = vi.hoisted(() => ({
    getLibraryTypeSettings: vi.fn(),
    upsertLibraryTypeSetting: vi.fn(),
    getLibraryPaths: vi.fn(),
}));
vi.mock('$lib/api/admin', () => api);

import LibraryTypeSettingsPanel from './LibraryTypeSettingsPanel.svelte';

beforeEach(() => {
    vi.clearAllMocks();
    api.getLibraryTypeSettings.mockResolvedValue({ data: { settings: [] }, error: null });
    api.getLibraryPaths.mockResolvedValue({
        data: { items: [{ mediaType: 'training', libraryGroupId: 'g1' }] },
        error: null,
    });
    api.upsertLibraryTypeSetting.mockImplementation(
        async (body: { mediaType: string; displayName: string | null }) => ({
            data: {
                setting: {
                    media_type: body.mediaType,
                    display_name: body.displayName,
                    sidebar_visible: true,
                    icon: null,
                    sort_order: 0,
                },
            },
            error: null,
        }),
    );
});

afterEach(cleanup);

describe('LibraryTypeSettingsPanel', () => {
    it('saves every changed type with one Save, and only the changed ones', async () => {
        render(LibraryTypeSettingsPanel);

        const save = await screen.findByRole('button', { name: 'Save changes' });
        expect((save as HTMLButtonElement).disabled).toBe(true);

        await fireEvent.input(screen.getByPlaceholderText('Home Videos'), {
            target: { value: 'Family' },
        });
        await waitFor(() => expect((save as HTMLButtonElement).disabled).toBe(false));
        await fireEvent.click(save);

        await waitFor(() => expect(api.upsertLibraryTypeSetting).toHaveBeenCalledTimes(1));
        expect(api.upsertLibraryTypeSetting).toHaveBeenCalledWith(
            expect.objectContaining({ mediaType: 'home_video', displayName: 'Family', icon: null }),
        );
        expect(toasts.success).toHaveBeenCalledTimes(1);
    });

    it('says which types no library uses yet, and counts the ones in use', async () => {
        render(LibraryTypeSettingsPanel);

        await waitFor(() => expect(screen.getByText('Used by 1 library')).toBeTruthy());
        expect(screen.getAllByText('No library uses this type yet')).toHaveLength(3);
    });
});
