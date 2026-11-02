// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';

const check = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ checkProviderHealth: check }));

import TextInput from './TextInput.svelte';
import type { SettingDefinition } from '$lib/config/schema';

const setting = {
    key: 'SONARRURL',
    label: 'Sonarr Server URL',
    type: 'url',
    section: 'services',
    defaultValue: '',
    uiHints: { healthCheckProvider: 'sonarr' },
} as unknown as SettingDefinition;

afterEach(() => {
    cleanup();
    check.mockReset();
});

describe('TextInput — Test connection', () => {
    it('sends the current form URL and key, not just the provider name', async () => {
        check.mockResolvedValue({ data: { healthy: true, latencyMs: 5 }, error: null });
        render(TextInput, {
            setting,
            value: 'http://typed:8989',
            allValues: { SONARRURL: 'http://typed:8989', SONARRAPIKEY: 'typed-key' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
        expect(check).toHaveBeenCalledWith('sonarr', {
            SONARRURL: 'http://typed:8989',
            SONARRAPIKEY: 'typed-key',
        });
    });

    it('is disabled while the URL is empty', () => {
        render(TextInput, { setting, value: '', allValues: {} });
        expect(
            (screen.getByRole('button', { name: /test connection/i }) as HTMLButtonElement)
                .disabled,
        ).toBe(true);
    });

    it('drops a result once the tested value is edited', async () => {
        check.mockResolvedValue({ data: { healthy: true, latencyMs: 5 }, error: null });
        const view = render(TextInput, {
            setting,
            value: 'http://a:1',
            allValues: { SONARRURL: 'http://a:1' },
        });
        await fireEvent.click(screen.getByRole('button', { name: /test connection/i }));
        await tick();
        expect(screen.getByRole('button', { name: /connected/i })).toBeTruthy();

        await view.rerender({
            setting,
            value: 'http://b:1',
            allValues: { SONARRURL: 'http://b:1' },
        });
        expect(screen.getByRole('button', { name: /test connection/i })).toBeTruthy();
    });
});
