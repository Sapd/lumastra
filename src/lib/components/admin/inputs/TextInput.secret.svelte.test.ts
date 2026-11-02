// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import TextInput from './TextInput.svelte';
import { SECRET_CONFIGURED_SENTINEL } from '$lib/shared/secret-sentinel';
import type { SettingDefinition } from '$lib/config/schema';

const setting = {
    key: 'SONARRAPIKEY',
    label: 'Sonarr API Key',
    type: 'string',
    section: 'services',
    defaultValue: '',
    uiHints: { sensitive: true, placeholder: 'xxxxxxxx' },
} as unknown as SettingDefinition;

afterEach(cleanup);

describe('TextInput — masked secrets', () => {
    it('never shows the sentinel and says the key is stored', () => {
        render(TextInput, { setting, value: SECRET_CONFIGURED_SENTINEL });
        const input = document.getElementById('SONARRAPIKEY') as HTMLInputElement;
        expect(input.value).toBe('');
        expect(input.placeholder).toMatch(/stored/i);
    });

    it('says "not set" for an empty secret instead of a fake masked placeholder', () => {
        render(TextInput, { setting, value: '' });
        const input = document.getElementById('SONARRAPIKEY') as HTMLInputElement;
        expect(input.placeholder).toMatch(/not set/i);
    });

    it('reverts to "keep stored" when the typed replacement is erased again', async () => {
        const onchange = vi.fn();
        render(TextInput, { setting, value: SECRET_CONFIGURED_SENTINEL, onchange });
        const input = document.getElementById('SONARRAPIKEY') as HTMLInputElement;
        await fireEvent.input(input, { target: { value: 'new' } });
        await fireEvent.input(input, { target: { value: '' } });
        expect(onchange).toHaveBeenLastCalledWith(SECRET_CONFIGURED_SENTINEL);
    });

    it('clears a stored secret only through the explicit Clear button', async () => {
        const onchange = vi.fn();
        render(TextInput, { setting, value: SECRET_CONFIGURED_SENTINEL, onchange });
        await fireEvent.click(screen.getByRole('button', { name: /remove the stored/i }));
        expect(onchange).toHaveBeenCalledWith('');
    });
});
