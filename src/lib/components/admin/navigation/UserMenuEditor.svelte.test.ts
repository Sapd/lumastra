// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'vitest';
import UserMenuEditor from './UserMenuEditor.svelte';

describe('UserMenuEditor built-in items panel', () => {
    afterEach(() => cleanup());

    test('no longer lists API Tokens or Customize Widgets (moved to /settings)', () => {
        render(UserMenuEditor, { links: [] });
        expect(screen.queryByText('API Tokens')).toBeNull();
        expect(screen.queryByText('Customize Widgets')).toBeNull();
    });

    // The 2026-09 menu redesign moved the preference toggles to /settings; the
    // panel must describe what the menu actually renders now.
    test('lists what the account menu renders on its own', () => {
        render(UserMenuEditor, { links: [] });
        expect(screen.getByText('Playing now')).toBeTruthy();
        expect(screen.getByText('Sessions & devices')).toBeTruthy();
        expect(screen.getByText('My Stats')).toBeTruthy();
        expect(screen.getByText('Settings')).toBeTruthy();
        expect(screen.getByText('Sign out')).toBeTruthy();
        expect(screen.queryByText('Dock')).toBeNull();
    });

    test('points operators at the /settings surface', () => {
        render(UserMenuEditor, { links: [] });
        expect(screen.getByText(/\/settings/)).toBeTruthy();
    });
});
