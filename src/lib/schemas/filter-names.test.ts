// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { azQuerySchema, browseGenresQuerySchema, tagsQuerySchema, recentQuerySchema } from './browse.js';
import { bookQuery, facetQuery, resourceBooksQuery } from '$lib/server/api/defs/audiobooks/catalog-input.js';

const id = '11111111-1111-4111-8111-111111111111';
describe('library filter names', () => {
    it.each([azQuerySchema, browseGenresQuerySchema, tagsQuerySchema, bookQuery, facetQuery, resourceBooksQuery])(
        'accepts libraryGroupId and rejects retired groupId', (schema) => {
            expect(schema.safeParse({ libraryGroupId: id }).success).toBe(true);
            expect(schema.safeParse({ groupId: id }).success).toBe(false);
        },
    );
    it('rejects the retired recent group filter', () => {
        expect(recentQuerySchema.parse({ libraryGroupId: id }).libraryGroupId).toBe(id);
        expect(recentQuerySchema.safeParse({ group: id }).success).toBe(false);
    });
});
