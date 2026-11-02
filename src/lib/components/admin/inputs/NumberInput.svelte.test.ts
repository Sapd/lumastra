// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import NumberInput from './NumberInput.svelte';
import type { SettingDefinition } from '$lib/config/schema';

const setting = {
    key: 'SCAN_INTERVAL',
    label: 'Scan interval',
    type: 'number',
    section: 'tasks',
    defaultValue: 30,
} as unknown as SettingDefinition;

afterEach(cleanup);

describe('NumberInput', () => {
    it('shows the value in force again when the box is left empty', async () => {
        // Emptying dispatches nothing, so the form keeps 45; the box must not
        // look cleared while 45 is what gets saved.
        const onchange = vi.fn();
        render(NumberInput, { setting, value: 45, onchange });
        const input = document.getElementById('SCAN_INTERVAL') as HTMLInputElement;

        await fireEvent.input(input, { target: { value: '' } });
        await fireEvent.change(input);

        expect(onchange).not.toHaveBeenCalled();
        expect(input.value).toBe('45');
    });

    it('dispatches a typed number', async () => {
        const onchange = vi.fn();
        render(NumberInput, { setting, value: 45, onchange });
        const input = document.getElementById('SCAN_INTERVAL') as HTMLInputElement;
        await fireEvent.input(input, { target: { value: '60' } });
        expect(onchange).toHaveBeenCalledWith(60);
    });
});
