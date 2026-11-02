// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { publicAuthorSchema } from './public-author.js';

const author = {
    userId: '00000000-0000-4000-8000-000000000001',
    displayName: null,
    images: { primary: { href: '/api/v1/users/avatar', revision: '0', source: 'self' } },
};

describe('publicAuthorSchema', () => {
    it('accepts an explicit null display name and optional thumbnail', () => {
        expect(publicAuthorSchema.parse(author)).toEqual(author);
        const named = {
            ...author,
            displayName: 'Public name',
            images: { primary: { href: '/avatar', variants: { thumb: '/avatar?quality=50' }, revision: '0', source: 'self' } },
        };
        expect(publicAuthorSchema.parse(named)).toEqual(named);
    });

    it('requires a UUID, display name and avatar descriptor', () => {
        expect(publicAuthorSchema.safeParse({ ...author, userId: 'login' }).success).toBe(false);
        expect(
            publicAuthorSchema.safeParse({ ...author, displayName: undefined }).success,
        ).toBe(false);
        expect(
            publicAuthorSchema.safeParse({ ...author, images: { primary: {} } }).success,
        ).toBe(false);
    });
});
