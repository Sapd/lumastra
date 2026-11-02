// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { get } from 'svelte/store';
import { describe, expect, it } from 'vitest';
import { registerSearchOverlay, searchOverlayOpen } from './search-overlay.store';

describe('searchOverlayOpen', () => {
    it('stays open until every registered overlay released, and release is idempotent', () => {
        expect(get(searchOverlayOpen)).toBe(false);
        const first = registerSearchOverlay();
        const second = registerSearchOverlay();
        first();
        first();
        expect(get(searchOverlayOpen)).toBe(true);
        second();
        expect(get(searchOverlayOpen)).toBe(false);
    });
});
