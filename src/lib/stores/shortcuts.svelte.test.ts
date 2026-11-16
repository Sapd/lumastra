// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test, vi } from 'vitest';
import { shortcuts } from './shortcuts.svelte';

describe('shortcuts registry', () => {
    test('registering and unregistering leaves no group, without a proxy-equality warning', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const off = shortcuts.register({ label: 'A', entries: [{ keys: ['?'], description: 'x' }] });
        expect(shortcuts.groups.map((g) => g.label)).toEqual(['A']);
        off();
        expect(shortcuts.groups).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        warn.mockRestore();
    });

    test('a second registration with the same label replaces the first', () => {
        const off1 = shortcuts.register({ label: 'A', entries: [] });
        const off2 = shortcuts.register({ label: 'A', entries: [] });
        expect(shortcuts.groups).toHaveLength(1);
        off1();
        off2();
        expect(shortcuts.groups).toEqual([]);
    });
});
