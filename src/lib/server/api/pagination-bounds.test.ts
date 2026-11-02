// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * G10 — pagination clamp invariant.
 *
 * Guards that Zod query schemas enforce their documented limit/offset bounds.
 * If a future edit drops `.max()` or `.min()` from a list endpoint's schema,
 * this test suite will fail and surface the regression.
 *
 * All assertions are verified against the actual schema behavior (safeParse).
 * No live DB or server is required — pure Zod parse tests.
 *
 * Schemas covered:
 *   - azQuerySchema        (/api/browse/az)         limit: 1–100, offset: ≥0
 *   - keywordsQuerySchema  (/api/browse/keywords)   limit: 1–20,  offset: ≥0
 *   - searchQuerySchema    (/api/search)             limit: 1–100, offset: ≥0
 *   - searchSuggestQuerySchema (/api/search/suggest) limit: 1–20  (no offset)
 *   - browseQuerySchema    (/api/browse)             genreLimit: 1–50, genreOffset: ≥0
 *
 * Also guards that MAX_SEARCH_OFFSET from search.service.ts is a positive integer.
 */

import { describe, it, expect, vi } from 'vitest';

// The real endpoint schemas/constants below import cache invalidation listeners.
// This pure parse suite needs no pub/sub connection: a pending subscription can
// otherwise log after Vitest has torn down the worker's RPC channel.
vi.mock('$lib/server/cache/valkey.js', async (original) => ({
    ...(await original<typeof import('$lib/server/cache/valkey.js')>()),
    subscribeToChannel: vi.fn(async () => null),
}));
import {
    azQuerySchema,
    keywordsQuerySchema,
    searchQuerySchema,
    searchSuggestQuerySchema,
    browseQuerySchema,
} from '$lib/schemas/browse.js';
import { MAX_SEARCH_OFFSET } from '$lib/server/services/search.service.js';
import {
    QuerySchema as musicDownloadsCandidatesQuerySchema,
    MAX_WANT,
} from '$lib/server/api/defs/music/downloads/candidates.js';

// ---------------------------------------------------------------------------
// G10-A: azQuerySchema — /api/browse/az
// limit: min 1, max 100  |  offset: min 0
// ---------------------------------------------------------------------------

describe('azQuerySchema pagination bounds', () => {
    it('accepts a valid limit and offset', () => {
        const result = azQuerySchema.safeParse({ limit: '50', offset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(50);
            expect(result.data.offset).toBe(0);
        }
    });

    it('rejects limit above 100', () => {
        const result = azQuerySchema.safeParse({ limit: '101', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects limit of 0', () => {
        const result = azQuerySchema.safeParse({ limit: '0', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects negative limit', () => {
        const result = azQuerySchema.safeParse({ limit: '-1', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects offset of -1', () => {
        const result = azQuerySchema.safeParse({ limit: '10', offset: '-1' });
        expect(result.success).toBe(false);
    });

    it('accepts offset of 0', () => {
        const result = azQuerySchema.safeParse({ limit: '10', offset: '0' });
        expect(result.success).toBe(true);
    });

    it('accepts limit of exactly 100', () => {
        const result = azQuerySchema.safeParse({ limit: '100', offset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(100);
        }
    });
});

// ---------------------------------------------------------------------------
// G10-B: keywordsQuerySchema — /api/browse/keywords
// limit: min 1, max 20  |  offset: min 0
// ---------------------------------------------------------------------------

describe('keywordsQuerySchema pagination bounds', () => {
    it('accepts a valid limit and offset', () => {
        const result = keywordsQuerySchema.safeParse({ limit: '10', offset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(10);
            expect(result.data.offset).toBe(0);
        }
    });

    it('rejects limit above 20', () => {
        const result = keywordsQuerySchema.safeParse({ limit: '21', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects limit of 0', () => {
        const result = keywordsQuerySchema.safeParse({ limit: '0', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects offset of -1', () => {
        const result = keywordsQuerySchema.safeParse({ limit: '5', offset: '-1' });
        expect(result.success).toBe(false);
    });

    it('accepts limit of exactly 20', () => {
        const result = keywordsQuerySchema.safeParse({ limit: '20', offset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(20);
        }
    });
});

// ---------------------------------------------------------------------------
// G10-C: searchQuerySchema — /api/search
// limit: min 1, max 100  |  offset: min 0
// ---------------------------------------------------------------------------

describe('searchQuerySchema pagination bounds', () => {
    it('accepts a valid limit and offset', () => {
        const result = searchQuerySchema.safeParse({ limit: '20', offset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(20);
            expect(result.data.offset).toBe(0);
        }
    });

    it('rejects limit above 100', () => {
        const result = searchQuerySchema.safeParse({ limit: '101', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects limit of 0', () => {
        const result = searchQuerySchema.safeParse({ limit: '0', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects negative limit', () => {
        const result = searchQuerySchema.safeParse({ limit: '-5', offset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects offset of -1', () => {
        const result = searchQuerySchema.safeParse({ limit: '20', offset: '-1' });
        expect(result.success).toBe(false);
    });

    it('accepts offset of 0', () => {
        const result = searchQuerySchema.safeParse({ limit: '20', offset: '0' });
        expect(result.success).toBe(true);
    });

    it('accepts limit of exactly 100', () => {
        const result = searchQuerySchema.safeParse({ limit: '100', offset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(100);
        }
    });

    it('applies default limit of 20 when omitted', () => {
        const result = searchQuerySchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(20);
            expect(result.data.offset).toBe(0);
        }
    });
});

// ---------------------------------------------------------------------------
// G10-D: searchSuggestQuerySchema — /api/search/suggest
// limit: min 1, max 20  (no offset field)
// ---------------------------------------------------------------------------

describe('searchSuggestQuerySchema pagination bounds', () => {
    it('accepts a valid limit', () => {
        const result = searchSuggestQuerySchema.safeParse({ limit: '8' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(8);
        }
    });

    it('rejects limit above 20', () => {
        const result = searchSuggestQuerySchema.safeParse({ limit: '21' });
        expect(result.success).toBe(false);
    });

    it('rejects limit of 0', () => {
        const result = searchSuggestQuerySchema.safeParse({ limit: '0' });
        expect(result.success).toBe(false);
    });

    it('accepts limit of exactly 20', () => {
        const result = searchSuggestQuerySchema.safeParse({ limit: '20' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(20);
        }
    });

    it('applies default limit of 8 when omitted', () => {
        const result = searchSuggestQuerySchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.limit).toBe(8);
        }
    });
});

// ---------------------------------------------------------------------------
// G10-E: browseQuerySchema — /api/browse
// genreLimit: min 1, max 50  |  genreOffset: min 0
// ---------------------------------------------------------------------------

describe('browseQuerySchema pagination bounds', () => {
    it('accepts a valid genreLimit and genreOffset', () => {
        const result = browseQuerySchema.safeParse({ genreLimit: '12', genreOffset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.genreLimit).toBe(12);
            expect(result.data.genreOffset).toBe(0);
        }
    });

    it('rejects genreLimit above 50', () => {
        const result = browseQuerySchema.safeParse({ genreLimit: '51', genreOffset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects genreLimit of 0', () => {
        const result = browseQuerySchema.safeParse({ genreLimit: '0', genreOffset: '0' });
        expect(result.success).toBe(false);
    });

    it('rejects genreOffset of -1', () => {
        const result = browseQuerySchema.safeParse({ genreLimit: '12', genreOffset: '-1' });
        expect(result.success).toBe(false);
    });

    it('accepts genreLimit of exactly 50', () => {
        const result = browseQuerySchema.safeParse({ genreLimit: '50', genreOffset: '0' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.genreLimit).toBe(50);
        }
    });

    it('applies defaults when all params omitted', () => {
        const result = browseQuerySchema.safeParse({});
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.genreLimit).toBe(12);
            expect(result.data.genreOffset).toBe(0);
        }
    });
});

// ---------------------------------------------------------------------------
// G10-F: MAX_SEARCH_OFFSET constant — search.service.ts
// Guards that the runtime clamp constant is a positive integer (value: 1000).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// G10-G: music downloads candidates QuerySchema —
// GET /api/v1/music/downloads/candidates
// want: min 1, max MAX_WANT (no cursor — want is the lane's only depth
// control, so dropping this cap would make the underlying LIMIT unbounded)
// ---------------------------------------------------------------------------

describe('music downloads candidates QuerySchema pagination bounds', () => {
    it('accepts a valid want', () => {
        const result = musicDownloadsCandidatesQuerySchema.safeParse({
            lane: 'rotation',
            want: '100',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.want).toBe(100);
        }
    });

    it(`rejects want above ${MAX_WANT}`, () => {
        const result = musicDownloadsCandidatesQuerySchema.safeParse({
            lane: 'rotation',
            want: String(MAX_WANT + 1),
        });
        expect(result.success).toBe(false);
    });

    it('rejects want of 0', () => {
        const result = musicDownloadsCandidatesQuerySchema.safeParse({
            lane: 'rotation',
            want: '0',
        });
        expect(result.success).toBe(false);
    });

    it('rejects negative want', () => {
        const result = musicDownloadsCandidatesQuerySchema.safeParse({
            lane: 'rotation',
            want: '-1',
        });
        expect(result.success).toBe(false);
    });

    it(`accepts want of exactly ${MAX_WANT}`, () => {
        const result = musicDownloadsCandidatesQuerySchema.safeParse({
            lane: 'rotation',
            want: String(MAX_WANT),
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.want).toBe(MAX_WANT);
        }
    });

    it('applies a default want of 100 when omitted', () => {
        const result = musicDownloadsCandidatesQuerySchema.safeParse({ lane: 'rotation' });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.want).toBe(100);
        }
    });
});

describe('MAX_SEARCH_OFFSET constant', () => {
    it('is a positive integer', () => {
        expect(typeof MAX_SEARCH_OFFSET).toBe('number');
        expect(Number.isInteger(MAX_SEARCH_OFFSET)).toBe(true);
        expect(MAX_SEARCH_OFFSET).toBeGreaterThan(0);
    });

    it('equals 1000 (the documented deep-pagination ceiling)', () => {
        expect(MAX_SEARCH_OFFSET).toBe(1000);
    });
});
