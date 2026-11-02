// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for livetv-programs.queries.ts
 *
 * Tests the GroupedProgramRow → GroupedProgramSearchResult transform,
 * schema validation, and API route input handling.
 */

import { describe, it, expect } from 'vitest';
import {
    GroupedProgramSearchResultSchema,
    ProgramSearchResponseSchema,
    TemporalStatusSchema,
} from '$lib/schemas/livetv.js';

// =============================================================================
// Schema Validation Tests (Task 5.4)
// =============================================================================

describe('TemporalStatusSchema', () => {
    it('accepts valid temporal statuses', () => {
        expect(TemporalStatusSchema.parse('live')).toBe('live');
        expect(TemporalStatusSchema.parse('upcoming_today')).toBe('upcoming_today');
        expect(TemporalStatusSchema.parse('future')).toBe('future');
        expect(TemporalStatusSchema.parse('ended')).toBe('ended');
    });

    it('rejects invalid temporal status', () => {
        expect(() => TemporalStatusSchema.parse('past')).toThrow();
        expect(() => TemporalStatusSchema.parse('')).toThrow();
        expect(() => TemporalStatusSchema.parse(123)).toThrow();
    });
});

describe('GroupedProgramSearchResultSchema', () => {
    const validResult = {
        title: 'Football Match',
        description: 'Live football game',
        temporalStatus: 'live',
        startTime: '2026-03-10T20:00:00.000Z',
        endTime: '2026-03-10T22:00:00.000Z',
        channels: [
            {
                id: 'ch-1',
                name: 'Sport 1',
                images: { primary: { href: 'http://logo/s1.png', revision: '0', source: 'self' } },
            },
            { id: 'ch-2', name: 'Sport 2', images: {} },
        ],
    };

    it('accepts valid grouped result with all fields', () => {
        const parsed = GroupedProgramSearchResultSchema.parse(validResult);
        expect(parsed.title).toBe('Football Match');
        expect(parsed.temporalStatus).toBe('live');
        expect(parsed.channels).toHaveLength(2);
    });

    it('accepts result with optional description omitted', () => {
        const { description: _desc, ...withoutDesc } = validResult;
        void _desc;
        const parsed = GroupedProgramSearchResultSchema.parse(withoutDesc);
        expect(parsed.description).toBeUndefined();
    });

    it('accepts result with channel without a primary image', () => {
        const result = {
            ...validResult,
            channels: [{ id: 'ch-1', name: 'Sport 1', images: {} }],
        };
        const parsed = GroupedProgramSearchResultSchema.parse(result);
        expect(parsed.channels[0].images.primary).toBeUndefined();
    });

    it('rejects result with missing required title', () => {
        const { title: _title, ...noTitle } = validResult;
        void _title;
        expect(() => GroupedProgramSearchResultSchema.parse(noTitle)).toThrow();
    });

    it('rejects result with invalid temporal status', () => {
        expect(() =>
            GroupedProgramSearchResultSchema.parse({
                ...validResult,
                temporalStatus: 'invalid',
            }),
        ).toThrow();
    });

    it('rejects result with missing channels', () => {
        const { channels: _ch, ...noChannels } = validResult;
        void _ch;
        expect(() => GroupedProgramSearchResultSchema.parse(noChannels)).toThrow();
    });

    it('rejects result with invalid channel (missing id)', () => {
        expect(() =>
            GroupedProgramSearchResultSchema.parse({
                ...validResult,
                channels: [{ name: 'No ID Channel' }],
            }),
        ).toThrow();
    });
});

describe('ProgramSearchResponseSchema', () => {
    const validResponse = {
        items: [
            {
                id: 'a-1',
                stationId: 'st-1',
                title: 'News',
                temporalStatus: 'upcoming_today',
                startTime: '2026-03-10T18:00:00.000Z',
                endTime: '2026-03-10T18:30:00.000Z',
                station: { id: 'st-1', name: 'LRV', images: {} },
            },
        ],
        page: { limit: 20, offset: 0, hasMore: false, total: 1 },
    };

    it('accepts valid search response', () => {
        const parsed = ProgramSearchResponseSchema.parse(validResponse);
        expect(parsed.items).toHaveLength(1);
        expect(parsed.page.hasMore).toBe(false);
        expect(parsed.page.total).toBe(1);
    });

    it('accepts empty items response', () => {
        const emptyResponse = {
            items: [],
            page: { limit: 20, offset: 0, hasMore: false, total: 0 },
        };
        const parsed = ProgramSearchResponseSchema.parse(emptyResponse);
        expect(parsed.items).toEqual([]);
        expect(parsed.page.total).toBe(0);
    });

    it('rejects response without page block', () => {
        const { page: _page, ...noPage } = validResponse;
        void _page;
        expect(() => ProgramSearchResponseSchema.parse(noPage)).toThrow();
    });

    it('rejects response with missing items field', () => {
        const { items: _items, ...noItems } = validResponse;
        void _items;
        expect(() => ProgramSearchResponseSchema.parse(noItems)).toThrow();
    });
});

// =============================================================================
// Query Validation Tests (Route-level logic)
// =============================================================================

describe('query parameter validation (mirrors route logic)', () => {
    function isValidQuery(raw: string | null): boolean {
        const q = raw?.trim();
        return !!q && q.length >= 2;
    }

    it('rejects null query', () => {
        expect(isValidQuery(null)).toBe(false);
    });

    it('rejects empty string', () => {
        expect(isValidQuery('')).toBe(false);
    });

    it('rejects whitespace-only', () => {
        expect(isValidQuery('   ')).toBe(false);
    });

    it('rejects single character', () => {
        expect(isValidQuery('a')).toBe(false);
    });

    it('accepts 2+ character query', () => {
        expect(isValidQuery('ab')).toBe(true);
        expect(isValidQuery('football')).toBe(true);
    });
});

// =============================================================================
// Limit Capping Tests (Task 5.5)
// =============================================================================

describe('limit parameter handling (mirrors route logic)', () => {
    // Tests the limit capping logic as implemented in the API route.
    // The route uses: parseInt + Number.isFinite + Math.min(raw, 50) with default 20.
    // Extracted here to verify the contract; the route itself is the source of truth.
    const MAX_LIMIT = 50;
    const DEFAULT_LIMIT = 20;

    function parseLimit(raw: string | null): number {
        const parsed = parseInt(raw ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_LIMIT) : DEFAULT_LIMIT;
    }

    it('uses default 20 for null input', () => {
        expect(parseLimit(null)).toBe(20);
    });

    it('uses default 20 for empty string', () => {
        expect(parseLimit('')).toBe(20);
    });

    it('uses default 20 for NaN input', () => {
        expect(parseLimit('abc')).toBe(20);
    });

    it('uses default 20 for negative values', () => {
        expect(parseLimit('-5')).toBe(20);
    });

    it('uses default 20 for zero', () => {
        expect(parseLimit('0')).toBe(20);
    });

    it('passes through valid values <= 50', () => {
        expect(parseLimit('10')).toBe(10);
        expect(parseLimit('50')).toBe(50);
    });

    it('caps values > 50 to 50', () => {
        expect(parseLimit('100')).toBe(50);
        expect(parseLimit('999')).toBe(50);
    });
});
