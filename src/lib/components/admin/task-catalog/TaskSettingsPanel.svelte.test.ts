// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Task settings: an edit made while a save is in flight is still unsaved
 * afterwards, and clearing a number field does not leave the panel "dirty"
 * with nothing to send.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store.js', () => ({ toasts }));

const apiGet = vi.hoisted(() => vi.fn());
const apiPut = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet, apiPut }));

import TaskSettingsPanel from './TaskSettingsPanel.svelte';

const SETTINGS = {
    fields: [
        { key: 'region', label: 'Region', type: 'string' },
        { key: 'batch', label: 'Batch size', type: 'number' },
    ],
    values: { region: 'eu', batch: 10 },
    secrets: [],
};

afterEach(() => {
    cleanup();
    apiGet.mockReset();
    apiPut.mockReset();
});

const saveButton = () =>
    screen.getByRole('button', { name: /^(Save|Saving…)$/ }) as HTMLButtonElement;

describe('TaskSettingsPanel', () => {
    it('an edit made during the save stays unsaved', async () => {
        apiGet.mockResolvedValue({ data: SETTINGS, error: null });
        let finishSave: (v: unknown) => void = () => {};
        apiPut.mockImplementation(() => new Promise((r) => (finishSave = r)));
        render(TaskSettingsPanel, { props: { taskId: 'demo-task' } });

        const region = (await screen.findByLabelText('Region')) as HTMLInputElement;
        await fireEvent.input(region, { target: { value: 'us' } });
        await fireEvent.click(saveButton());

        await fireEvent.input(region, { target: { value: 'ap' } });
        finishSave({ data: { ok: true }, error: null });

        await waitFor(() => expect(saveButton().textContent).toBe('Save'));
        expect(apiPut.mock.calls[0][2]).toEqual({ values: { region: 'us' } });
        expect(saveButton().disabled).toBe(false);
        expect(screen.getByText('Unsaved changes')).toBeTruthy();
    });

    it('clearing a number field reverts it instead of making the panel dirty', async () => {
        apiGet.mockResolvedValue({ data: SETTINGS, error: null });
        render(TaskSettingsPanel, { props: { taskId: 'demo-task' } });

        const batch = (await screen.findByLabelText('Batch size')) as HTMLInputElement;
        await fireEvent.input(batch, { target: { value: '' } });

        expect(saveButton().disabled).toBe(true);
        expect(screen.queryByText('Unsaved changes')).toBeNull();
    });
});
