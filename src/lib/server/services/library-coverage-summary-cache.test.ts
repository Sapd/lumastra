// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { coverageSummaryCacheKey } from './library-coverage-summary-cache.js';

describe('coverageSummaryCacheKey', () => {
    it('ignores media-type order and treats an empty list as no filter', () => {
        expect(coverageSummaryCacheKey({ mediaTypes: ['tv', 'movie'] })).toBe(
            coverageSummaryCacheKey({ mediaTypes: ['movie', 'tv'] }),
        );
        expect(coverageSummaryCacheKey({ mediaTypes: [] })).toBe(coverageSummaryCacheKey({}));
    });

    it('separates every filter dimension', () => {
        const keys = new Set([
            coverageSummaryCacheKey({}),
            coverageSummaryCacheKey({ mediaTypes: ['movie'] }),
            coverageSummaryCacheKey({ incompleteOnly: true }),
            coverageSummaryCacheKey({ missingStage: 'image-sync' }),
            coverageSummaryCacheKey({ search: 'avatar' }),
        ]);
        expect(keys.size).toBe(5);
    });

    it('hashes the search so a reserved character never reaches the key', () => {
        const key = coverageSummaryCacheKey({ search: 'a|b:c' });
        expect(key).toMatch(/^v1:admin:library-coverage:summary:[0-9a-f]{32}$/);
    });
});
