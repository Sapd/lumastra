// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Setting-row UX fixes from the /admin/settings review: colour and URL fields
 * show inline errors, root-relative branding paths are valid, image URL fields
 * preview, and a section on the one-section-at-a-time settings page is not
 * collapsible.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/svelte';
import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';
import ColorInput from './inputs/ColorInput.svelte';
import TextInput from './inputs/TextInput.svelte';
import SettingSection from './SettingSection.svelte';

vi.mock('$lib/api/admin', () => ({ checkProviderHealth: vi.fn() }));

afterEach(cleanup);

const colorSetting: SettingDefinition = {
    key: 'APP_THEME_COLOR',
    type: 'color',
    label: 'Theme Color',
    description: 'Tint',
    defaultValue: '#7c3aed',
    section: 'branding',
};

const logoSetting: SettingDefinition = {
    key: 'APP_LOGO_SMALL',
    type: 'url',
    label: 'Small Logo URL',
    description: 'Logo',
    defaultValue: '',
    section: 'branding',
    uiHints: { placeholder: 'Default logo', preview: 'image' },
};

describe('ColorInput', () => {
    it('flags a malformed hex inline and hides the swatch', () => {
        render(ColorInput, { setting: colorSetting, value: '#7c3aedx' });
        const input = screen.getByRole('textbox');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        const errorId = input.getAttribute('aria-describedby');
        expect(errorId && document.getElementById(errorId)?.textContent).toBeTruthy();
        expect(document.querySelector('input[type="color"]')).toBeNull();
    });

    it('renders a native swatch for a valid hex, expanding #rgb', () => {
        render(ColorInput, { setting: colorSetting, value: '#fff' });
        expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('false');
        const swatch = document.querySelector<HTMLInputElement>('input[type="color"]');
        expect(swatch?.value).toBe('#ffffff');
    });
});

describe('TextInput (url)', () => {
    it('accepts the documented root-relative path and previews it', () => {
        render(TextInput, { setting: logoSetting, value: '/custom/site-button.webp' });
        const input = screen.getByRole('textbox');
        // type="url" would make the browser flag "/custom/…" as invalid.
        expect(input.getAttribute('type')).toBe('text');
        expect(input.getAttribute('inputmode')).toBe('url');
        expect(input.getAttribute('aria-invalid')).toBe('false');
        const img = document.querySelector('img');
        expect(img?.getAttribute('src')).toContain('/custom/site-button.webp');
    });

    it('flags a bogus value and shows no preview when empty', () => {
        render(TextInput, { setting: logoSetting, value: 'custom/logo.png' });
        expect(screen.getByRole('textbox').getAttribute('aria-invalid')).toBe('true');
        cleanup();
        render(TextInput, { setting: logoSetting, value: '' });
        expect(document.querySelector('img')).toBeNull();
        expect(screen.getByRole('textbox').getAttribute('placeholder')).toBe('Default logo');
    });
});

describe('SettingSection collapsible', () => {
    const section: SectionDefinition = {
        id: 'branding',
        label: 'Branding',
        description: 'Identity',
        order: 1,
    };

    it('renders no toggle button when collapsible is false', () => {
        render(SettingSection, {
            section,
            values: {},
            envOverrides: new Set<string>(),
            collapsible: false,
            settingsOverride: [colorSetting],
        });
        expect(screen.queryByRole('button', { expanded: true })).toBeNull();
        expect(screen.getByText('Branding')).toBeTruthy();
    });

    it('keeps the toggle by default', () => {
        render(SettingSection, {
            section,
            values: {},
            envOverrides: new Set<string>(),
            settingsOverride: [colorSetting],
        });
        expect(screen.getByRole('button', { expanded: true })).toBeTruthy();
    });
});
