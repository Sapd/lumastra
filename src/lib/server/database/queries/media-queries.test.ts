// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for media query helper functions
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Use vi.hoisted to create the mock before vi.mock hoisting
const mockGetMetadataProviderChain = vi.hoisted(() => vi.fn(() => ['aggregated', 'tmdb']));

// Mock the provider-config module
vi.mock('../../utils/provider-config.js', () => ({
    getMetadataProviderChain: mockGetMetadataProviderChain,
}));

// Now import the module under test
import {
    getProviderArray,
    resetProviderArrayCache,
    buildProviderFilterUnsafe,
    buildProviderOrderUnsafe,
    buildMetadataProviderOrder,
} from './media-queries';

describe('media-queries helper functions', () => {
    beforeEach(() => {
        // Reset provider cache before each test
        resetProviderArrayCache();
        // Clear mock call history but keep the default implementation
        vi.clearAllMocks();
        // Reset to default return value
        mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);
    });

    afterEach(() => {
        resetProviderArrayCache();
    });

    describe('buildProviderFilterUnsafe', () => {
        it('returns filter with default providers from config', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result = buildProviderFilterUnsafe();

            expect(result).toBe(`provider = ANY(ARRAY['aggregated', 'tmdb']::text[])`);
        });

        it('works with custom providers array', () => {
            const result = buildProviderFilterUnsafe(['tmdb', 'mdblist', 'trakt']);

            expect(result).toBe(`provider = ANY(ARRAY['tmdb', 'mdblist', 'trakt']::text[])`);
        });

        it('returns safe default for empty array', () => {
            const result = buildProviderFilterUnsafe([]);

            expect(result).toBe(`provider = ANY(ARRAY['aggregated', 'tmdb']::text[])`);
        });

        it('handles single provider', () => {
            const result = buildProviderFilterUnsafe(['aggregated']);

            expect(result).toBe(`provider = ANY(ARRAY['aggregated']::text[])`);
        });

        it('handles many providers', () => {
            const result = buildProviderFilterUnsafe([
                'aggregated',
                'tmdb',
                'mdblist',
                'trakt',
                'imdb',
            ]);

            expect(result).toBe(
                `provider = ANY(ARRAY['aggregated', 'tmdb', 'mdblist', 'trakt', 'imdb']::text[])`,
            );
        });
    });

    describe('buildProviderOrderUnsafe', () => {
        it('returns ordering with default providers from config', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result = buildProviderOrderUnsafe();

            expect(result).toBe(`array_position(ARRAY['aggregated', 'tmdb']::text[], provider)`);
        });

        it('returns ordering with alias prefix', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result = buildProviderOrderUnsafe(undefined, 'pm');

            expect(result).toBe(`array_position(ARRAY['aggregated', 'tmdb']::text[], pm.provider)`);
        });

        it('works with custom providers array', () => {
            const result = buildProviderOrderUnsafe(['tmdb', 'mdblist', 'trakt']);

            expect(result).toBe(
                `array_position(ARRAY['tmdb', 'mdblist', 'trakt']::text[], provider)`,
            );
        });

        it('works with custom providers and alias', () => {
            const result = buildProviderOrderUnsafe(['aggregated', 'mdblist'], 'metadata');

            expect(result).toBe(
                `array_position(ARRAY['aggregated', 'mdblist']::text[], metadata.provider)`,
            );
        });

        it('returns 0 for empty array', () => {
            const result = buildProviderOrderUnsafe([]);

            expect(result).toBe('0');
        });

        it('handles single provider', () => {
            const result = buildProviderOrderUnsafe(['tmdb']);

            expect(result).toBe(`array_position(ARRAY['tmdb']::text[], provider)`);
        });

        it('empty alias string produces no prefix', () => {
            const result = buildProviderOrderUnsafe(['tmdb'], '');

            expect(result).toBe(`array_position(ARRAY['tmdb']::text[], provider)`);
        });
    });

    describe('buildMetadataProviderOrder', () => {
        it('returns CASE statement with default providers from config', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result = buildMetadataProviderOrder();

            expect(result).toBe(
                `CASE WHEN provider = 'aggregated' THEN 0 WHEN provider = 'tmdb' THEN 1 ELSE 999 END`,
            );
        });

        it('returns CASE statement with alias prefix', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result = buildMetadataProviderOrder(undefined, 'pm');

            expect(result).toBe(
                `CASE WHEN pm.provider = 'aggregated' THEN 0 WHEN pm.provider = 'tmdb' THEN 1 ELSE 999 END`,
            );
        });

        it('works with custom providers array', () => {
            const result = buildMetadataProviderOrder(['tmdb', 'mdblist', 'trakt']);

            expect(result).toBe(
                `CASE WHEN provider = 'tmdb' THEN 0 WHEN provider = 'mdblist' THEN 1 WHEN provider = 'trakt' THEN 2 ELSE 999 END`,
            );
        });

        it('works with custom providers and alias', () => {
            const result = buildMetadataProviderOrder(['aggregated', 'mdblist', 'imdb'], 'meta');

            expect(result).toBe(
                `CASE WHEN meta.provider = 'aggregated' THEN 0 WHEN meta.provider = 'mdblist' THEN 1 WHEN meta.provider = 'imdb' THEN 2 ELSE 999 END`,
            );
        });

        it('handles single provider', () => {
            const result = buildMetadataProviderOrder(['aggregated']);

            expect(result).toBe(`CASE WHEN provider = 'aggregated' THEN 0 ELSE 999 END`);
        });

        it('empty alias string produces no prefix', () => {
            const result = buildMetadataProviderOrder(['tmdb'], '');

            expect(result).toBe(`CASE WHEN provider = 'tmdb' THEN 0 ELSE 999 END`);
        });

        it('assigns correct indices based on array order', () => {
            const result = buildMetadataProviderOrder(['first', 'second', 'third', 'fourth']);

            expect(result).toContain(`WHEN provider = 'first' THEN 0`);
            expect(result).toContain(`WHEN provider = 'second' THEN 1`);
            expect(result).toContain(`WHEN provider = 'third' THEN 2`);
            expect(result).toContain(`WHEN provider = 'fourth' THEN 3`);
            expect(result).toContain('ELSE 999 END');
        });
    });

    describe('getProviderArray', () => {
        it('returns array of providers from config', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb', 'mdblist']);

            const result = getProviderArray();

            expect(result).toEqual(['aggregated', 'tmdb', 'mdblist']);
        });

        it('returns the same array reference while the chain is unchanged', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result1 = getProviderArray();
            const result2 = getProviderArray();

            expect(result1).toBe(result2);
        });

        it('follows a changed chain without a restart', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);
            expect(getProviderArray()).toEqual(['aggregated', 'tmdb']);

            // A saved METADATA_PROVIDERS change surfaces through the chain getter.
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'mdblist', 'tmdb']);

            expect(getProviderArray()).toEqual(['aggregated', 'mdblist', 'tmdb']);
        });
    });

    describe('resetProviderArrayCache', () => {
        it('clears the cache so next call regenerates', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const result1 = getProviderArray();
            expect(result1).toEqual(['aggregated', 'tmdb']);

            // Reset the cache
            resetProviderArrayCache();

            // Change the mock return value
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'mdblist', 'trakt']);

            const result2 = getProviderArray();

            // After reset, should get new value
            expect(result2).toEqual(['aggregated', 'mdblist', 'trakt']);
            // Should not be the same reference
            expect(result1).not.toBe(result2);
        });

        it('allows getMetadataProviderChain to be called again after reset', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated']);

            getProviderArray();
            expect(mockGetMetadataProviderChain).toHaveBeenCalledTimes(1);

            resetProviderArrayCache();
            getProviderArray();
            expect(mockGetMetadataProviderChain).toHaveBeenCalledTimes(2);
        });

        it('can be called multiple times safely', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated']);

            // Reset multiple times in a row
            resetProviderArrayCache();
            resetProviderArrayCache();
            resetProviderArrayCache();

            // Should still work normally
            const result = getProviderArray();
            expect(result).toEqual(['aggregated']);
        });
    });

    describe('integration between functions', () => {
        it('buildProviderFilterUnsafe uses cached getProviderArray', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb', 'mdblist']);

            // Call without explicit providers - should use cache
            const filter1 = buildProviderFilterUnsafe();
            const filter2 = buildProviderFilterUnsafe();

            expect(filter1).toBe(filter2);
            expect(filter1).toBe(`provider = ANY(ARRAY['aggregated', 'tmdb', 'mdblist']::text[])`);
        });

        it('buildProviderOrderUnsafe uses cached getProviderArray', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            const order1 = buildProviderOrderUnsafe();
            const order2 = buildProviderOrderUnsafe();

            expect(order1).toBe(order2);
            expect(order1).toBe(`array_position(ARRAY['aggregated', 'tmdb']::text[], provider)`);
        });

        it('explicit providers bypass the cache', () => {
            mockGetMetadataProviderChain.mockReturnValue(['aggregated', 'tmdb']);

            // First call populates cache
            getProviderArray();

            // These should use explicit providers, not cache
            const filter = buildProviderFilterUnsafe(['custom', 'providers']);
            const order = buildProviderOrderUnsafe(['custom', 'providers']);
            const caseOrder = buildMetadataProviderOrder(['custom', 'providers']);

            expect(filter).toBe(`provider = ANY(ARRAY['custom', 'providers']::text[])`);
            expect(order).toBe(`array_position(ARRAY['custom', 'providers']::text[], provider)`);
            expect(caseOrder).toBe(
                `CASE WHEN provider = 'custom' THEN 0 WHEN provider = 'providers' THEN 1 ELSE 999 END`,
            );
        });
    });
});
