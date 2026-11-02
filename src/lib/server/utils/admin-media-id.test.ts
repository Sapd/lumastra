// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { adminMediaId } from './admin-media-id.js';

describe('adminMediaId', () => {
    it('passes a UUID through', () => {
        const id = '0b9a1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d';
        expect(adminMediaId({ params: { id } })).toBe(id);
    });

    it.each(['tmdb:550:movie', 'abc-123', '', undefined])('refuses %s', (id) => {
        expect(adminMediaId({ params: { id } })).toBeNull();
    });
});
