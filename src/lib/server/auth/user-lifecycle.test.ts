// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { isLifecycleActive } from './user-lifecycle.js';

describe('isLifecycleActive', () => {
    it('is true when both disabled_at and deleted_at are null', () => {
        expect(isLifecycleActive({ disabled_at: null, deleted_at: null })).toBe(true);
    });

    it('is false when disabled_at is set', () => {
        expect(isLifecycleActive({ disabled_at: new Date(), deleted_at: null })).toBe(false);
    });

    it('is false when deleted_at is set', () => {
        expect(isLifecycleActive({ disabled_at: null, deleted_at: new Date() })).toBe(false);
    });

    it('is false when both are set', () => {
        expect(isLifecycleActive({ disabled_at: new Date(), deleted_at: new Date() })).toBe(false);
    });
});
