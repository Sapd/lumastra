// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import SettingsGroup from './SettingsGroup.svelte';

describe('SettingsGroup', () => {
    afterEach(() => cleanup());

    test('renders an uppercase micro-label when provided', () => {
        render(SettingsGroup, { label: 'Privacy' });
        const label = screen.getByText('Privacy');
        expect(label.className).toContain('uppercase');
    });

    test('renders the card-glass container', () => {
        const { container } = render(SettingsGroup, { label: 'Account' });
        expect(container.querySelector('.card-glass')).toBeTruthy();
    });
});
