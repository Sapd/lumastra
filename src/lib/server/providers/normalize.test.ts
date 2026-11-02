// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the external normalizer registry in providers/normalize.ts.
 *
 * Covers: register/unregister round-trip, external-over-builtin precedence,
 * fallback to builtin after unregister, unknown-provider null return.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mocks (hoisted — must be declared before imports)
// ============================================================================

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

// Stub the builtin normalizer modules so tests don't pull in real HTTP clients.
vi.mock('./implementations/tmdb/normalize.js', () => ({
    searchResultToCandidate: vi.fn(() => ({
        provider: 'tmdb',
        title: 'TMDB result',
    })),
    detailToMetadata: vi.fn(() => ({ title: 'TMDB detail' })),
}));
vi.mock('./implementations/jellyfin/normalize.js', () => ({}));
vi.mock('./implementations/anidb/normalize.js', () => ({}));
vi.mock('./implementations/mdblist/normalize.js', () => ({}));
vi.mock('./implementations/musicbrainz/normalize.js', () => ({}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import {
    normalizeSearchResult,
    normalizeDetail,
    registerProviderNormalizer,
    unregisterProviderNormalizer,
    type NormalizerModule,
} from './normalize.js';

// ============================================================================
// Helpers
// ============================================================================

const EXT_ID = 'my-external-provider';

const extCandidate = { provider: EXT_ID, title: 'External result' };
const extDetail = { title: 'External detail' };

// Test-only NormalizerModule shape — the partial mock objects don't satisfy
// the full MetadataCandidate / MediaMetadata return types, but the dispatcher
// only forwards them through unchanged so the missing fields are immaterial.
const extNormalizer = {
    searchResultToCandidate: vi.fn(() => extCandidate),
    detailToMetadata: vi.fn(() => extDetail),
} as unknown as NormalizerModule;

beforeEach(() => {
    vi.clearAllMocks();
    // Clean up any leftover registration from a previous test.
    unregisterProviderNormalizer(EXT_ID);
});

// ============================================================================
// Tests
// ============================================================================

describe('registerProviderNormalizer / unregisterProviderNormalizer', () => {
    it('returns null for an unknown provider before registration', () => {
        expect(normalizeSearchResult(EXT_ID, {}, 'movie')).toBeNull();
        expect(normalizeDetail(EXT_ID, {}, 'movie')).toBeNull();
    });

    it('dispatches to the external normalizer after registration', () => {
        registerProviderNormalizer(EXT_ID, extNormalizer);

        const candidate = normalizeSearchResult(EXT_ID, { raw: true }, 'movie', 2024);
        expect(candidate).toBe(extCandidate);
        expect(extNormalizer.searchResultToCandidate).toHaveBeenCalledWith(
            { raw: true },
            'movie',
            2024,
        );

        const detail = normalizeDetail(EXT_ID, { raw: true }, 'tv');
        expect(detail).toBe(extDetail);
        expect(extNormalizer.detailToMetadata).toHaveBeenCalledWith({ raw: true }, 'tv');
    });

    it('returns null again after unregistration', () => {
        registerProviderNormalizer(EXT_ID, extNormalizer);
        unregisterProviderNormalizer(EXT_ID);

        expect(normalizeSearchResult(EXT_ID, {}, 'movie')).toBeNull();
        expect(normalizeDetail(EXT_ID, {}, 'movie')).toBeNull();
    });

    it('external normalizer takes precedence over builtin', () => {
        const overrideCandidate = {
            provider: 'tmdb-override',
            title: 'Override result',
        };
        const overrideNormalizer = {
            searchResultToCandidate: vi.fn(() => overrideCandidate),
        } as unknown as NormalizerModule;

        registerProviderNormalizer('tmdb-metadata-provider', overrideNormalizer);

        const result = normalizeSearchResult('tmdb-metadata-provider', {}, 'movie');
        expect(result).toBe(overrideCandidate);
        expect(overrideNormalizer.searchResultToCandidate).toHaveBeenCalled();

        // Clean up override so other tests see the real builtin.
        unregisterProviderNormalizer('tmdb-metadata-provider');
    });

    it('restores builtin after external override is unregistered', () => {
        const overrideNormalizer = {
            searchResultToCandidate: vi.fn(() => null),
        };

        registerProviderNormalizer('tmdb-metadata-provider', overrideNormalizer);
        unregisterProviderNormalizer('tmdb-metadata-provider');

        // After unregistering the override the builtin should fire again.
        const result = normalizeSearchResult('tmdb-metadata-provider', {}, 'movie');
        // The builtin mock returns a non-null candidate.
        expect(result).not.toBeNull();
        expect(overrideNormalizer.searchResultToCandidate).not.toHaveBeenCalled();
    });

    it('returns null when external normalizer has no matching method', () => {
        registerProviderNormalizer(EXT_ID, {
            // Only detailToMetadata — no searchResultToCandidate.
            detailToMetadata: vi.fn(() => extDetail),
        });

        expect(normalizeSearchResult(EXT_ID, {}, 'movie')).toBeNull();
        const detail = normalizeDetail(EXT_ID, {}, 'movie');
        expect(detail).toBe(extDetail);
    });
});
