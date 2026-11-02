// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import { configSchema } from '$lib/config/schema';
import TextInput from './TextInput.svelte';

const setting = configSchema.find((s) => s.key === 'TMDB_LANGUAGE')!;
afterEach(cleanup);

describe('Settings primary metadata language', () => {
    it('rejects newly entered free text without echoing it', async () => {
        const view = render(TextInput, { setting, value: 'en-US' });
        await view.rerender({ value: 'https://user:secret@example.com' });
        expect(document.getElementById('TMDB_LANGUAGE')?.getAttribute('aria-invalid')).toBe('true');
        expect(screen.getByText(/language code/i)).toBeTruthy();
        expect(document.body.textContent).not.toMatch(/user:secret|example.com/);
    });

    it.each(['es-419', 'zh-Hans', 'en-001', 'zh-Hant-TW'])('accepts %s', async (value) => {
        const view = render(TextInput, { setting, value: 'en-US' });
        await view.rerender({ value });
        expect(document.getElementById('TMDB_LANGUAGE')?.getAttribute('aria-invalid')).toBe(
            'false',
        );
    });

    it('does not mark an unchanged legacy value or environment-owned value invalid', () => {
        render(TextInput, { setting, value: 'legacy-language', envLocked: true });
        expect(document.getElementById('TMDB_LANGUAGE')?.getAttribute('aria-invalid')).toBe(
            'false',
        );
    });
});
