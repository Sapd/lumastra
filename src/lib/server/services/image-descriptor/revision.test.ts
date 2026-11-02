// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { IMAGE_ALGO_VERSION, imageRevision, type ImageRevisionInput } from './revision.js';

const input: ImageRevisionInput = {
    ownerId: 'owner', role: 'poster', localPath: '/poster.jpg',
    localUpdatedAt: '2026-10-16T10:00:00Z', providerPath: '/provider.jpg',
    customUrl: 'https://example.com/cover.jpg', preferredProvider: 'tmdb',
};
describe('image revisions', () => {
    it('is deterministic, with twelve hex characters and stable field ordering', () => {
        expect(imageRevision(input)).toMatch(/^[0-9a-f]{12}$/);
        expect(imageRevision({ ...input })).toBe(imageRevision(input));
        expect(imageRevision({ ...Object.fromEntries(Object.entries(input).reverse()), ownerId: input.ownerId, role: input.role })).toBe(imageRevision(input));
    });
    it.each(Object.keys(input) as (keyof ImageRevisionInput)[])('changes with %s', (key) => {
        expect(imageRevision({ ...input, [key]: `${input[key]}-changed` })).not.toBe(imageRevision(input));
        if (key !== 'ownerId' && key !== 'role') {
            expect(imageRevision({ ...input, [key]: null })).not.toBe(imageRevision(input));
        }
    });
    it('changes with the algorithm version', () => {
        expect(imageRevision(input, `${IMAGE_ALGO_VERSION}-next`)).not.toBe(imageRevision(input));
    });
    it('uses structured ingredients without delimiter collisions', () => {
        expect(imageRevision({ ownerId: 'a|b', role: 'c' })).not.toBe(imageRevision({ ownerId: 'a', role: 'b|c' }));
    });
});
