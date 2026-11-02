// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { z } from 'zod';
export const bookQuery = z.strictObject({
    q: z.string().min(1).max(200).optional(),
    letter: z
        .string()
        .regex(/^[A-Za-z#]$/)
        .optional(),
    authorId: z.string().uuid().optional(),
    narratorId: z.string().uuid().optional(),
    seriesId: z.string().uuid().optional(),
    libraryGroupId: z.string().uuid().optional(),
    lang: z.string().min(1).max(32).optional(),
    sort: z.enum(['title', 'added', 'year', 'series']).default('title'),
    order: z.enum(['asc', 'desc']).default('asc'),
    collapse: z.literal('series').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(60),
    offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const resourceQuery = bookQuery
    .pick({ q: true, order: true, limit: true, offset: true })
    .extend({ sort: z.enum(['name', 'books']).default('name') });
export const resourceParams = z.object({ id: z.string().uuid() });

export const resourceDetailQuery = z.object({});
export const resourceBooksQuery = bookQuery.omit({
    seriesId: true,
    authorId: true,
    narratorId: true,
});

export const facetQuery = bookQuery.pick({
    q: true,
    authorId: true,
    narratorId: true,
    seriesId: true,
    libraryGroupId: true,
    lang: true,
    collapse: true,
});
