// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Facets and catalog responses used by the web destination. */

import { z } from 'zod';
import { AudiobookPreviewSchema } from './api-audiobook-preview.js';
import { PageBlockSchema } from './pagination.js';

/** Sort orders the destination offers. */
export const AudiobookSortSchema = z
    .enum(['title_asc', 'title_desc', 'added_desc', 'year_desc', 'year_asc', 'series_sequence'])
    .describe('Sort order');

export type AudiobookSortValue = z.infer<typeof AudiobookSortSchema>;

/** One shelf tab — a library group holding audiobooks the viewer may see. */
export const AudiobookShelfSchema = z
    .object({
        id: z.string().describe('library_groups.id'),
        name: z.string().describe('Display name'),
        bookCount: z.number().int().describe('Books on this shelf'),
    })
    .meta({ id: 'AudiobookShelf', description: 'Audiobook shelf (library group)' });

export type AudiobookShelfInfo = z.infer<typeof AudiobookShelfSchema>;

/** One language chip, from `library_paths.language` — never inferred from a name. */
export const AudiobookLanguageFacetSchema = z
    .object({
        language: z.string().describe('BCP-47-ish language code as configured on the library path'),
        bookCount: z.number().int().describe('Books in this language'),
    })
    .meta({ id: 'AudiobookLanguageFacet', description: 'Audiobook language facet' });

export type AudiobookLanguageFacetInfo = z.infer<typeof AudiobookLanguageFacetSchema>;

/** One bucket of the A-Z jump rail. `#` collects non-Latin initials. */
export const AudiobookLetterCountSchema = z
    .object({
        letter: z.string().describe("'A'-'Z' or '#'"),
        count: z.number().int().describe('Entries in this bucket'),
    })
    .meta({ id: 'AudiobookLetterCount', description: 'Audiobook letter bucket count' });

export type AudiobookLetterCountInfo = z.infer<typeof AudiobookLetterCountSchema>;

/** A book the viewer is part-way through. */
export const AudiobookProgressEntrySchema = z
    .object({
        item: AudiobookPreviewSchema.describe('The book, as a card'),
        positionMs: z.number().int().describe('Resume position in milliseconds'),
        durationMs: z.number().int().optional().describe('Total length in milliseconds'),
    })
    .meta({ id: 'AudiobookProgressEntry', description: 'In-progress audiobook' });

export type AudiobookProgressEntry = z.infer<typeof AudiobookProgressEntrySchema>;

export const AudiobookFacetsSchema = z.object({
    shelves: z.array(AudiobookShelfSchema),
    languages: z.array(AudiobookLanguageFacetSchema),
    letterCounts: z.array(AudiobookLetterCountSchema),
});

/** Catalog collections use offset pagination; facets have a separate endpoint. */
export const AudiobookBrowseResponseSchema = z
    .object({
        items: z.array(AudiobookPreviewSchema),
        page: PageBlockSchema,
    })
    .meta({ id: 'AudiobookBrowseResponse', description: 'Audiobook catalog page' });
export type AudiobookBrowseResponse = z.infer<typeof AudiobookBrowseResponseSchema>;
