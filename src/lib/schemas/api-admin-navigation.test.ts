// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { AddNavGroupBodySchema, AddNavGroupResponseSchema } from './api-admin-navigation.js';

describe('AddNavGroupBodySchema', () => {
    it('accepts a normal group name', () => {
        expect(AddNavGroupBodySchema.parse({ group: 'Librarians' })).toEqual({
            group: 'Librarians',
        });
    });

    it('rejects an empty group', () => {
        expect(AddNavGroupBodySchema.safeParse({ group: '' }).success).toBe(false);
    });

    it('rejects a group longer than 128 chars', () => {
        expect(AddNavGroupBodySchema.safeParse({ group: 'a'.repeat(129) }).success).toBe(false);
    });

    it('rejects a missing group field', () => {
        expect(AddNavGroupBodySchema.safeParse({}).success).toBe(false);
    });
});

describe('AddNavGroupResponseSchema', () => {
    it('accepts a valid bare response (no success wrapper)', () => {
        const ok = AddNavGroupResponseSchema.parse({
            availableGroups: ['admin', 'Librarians'],
            persisted: true,
        });
        expect(ok.availableGroups).toEqual(['admin', 'Librarians']);
        expect(ok.persisted).toBe(true);
    });

    it('rejects a response missing availableGroups', () => {
        expect(AddNavGroupResponseSchema.safeParse({ persisted: true }).success).toBe(false);
    });
});
