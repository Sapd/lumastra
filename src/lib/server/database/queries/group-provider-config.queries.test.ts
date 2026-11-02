// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    resolveFieldPrioritiesForGroup,
    resolveProviderChainForGroup,
} from './group-provider-config.queries.js';
import { FIELD_PRIORITY_DEFAULT } from './metadata-aggregation.queries.js';

describe('resolveProviderChainForGroup', () => {
    it('returns global chain when group chain is null', () => {
        const result = resolveProviderChainForGroup(null, ['aggregated', 'tmdb', 'mdblist']);
        expect(result).toEqual(['aggregated', 'tmdb', 'mdblist']);
    });

    it('prepends aggregated to group chain', () => {
        const result = resolveProviderChainForGroup(
            ['anidb', 'tmdb'],
            ['aggregated', 'tmdb', 'mdblist'],
        );
        expect(result).toEqual(['aggregated', 'anidb', 'tmdb']);
    });

    it('does not duplicate aggregated if already in group chain', () => {
        const result = resolveProviderChainForGroup(
            ['aggregated', 'anidb', 'tmdb'],
            ['aggregated', 'tmdb'],
        );
        expect(result).toEqual(['aggregated', 'anidb', 'tmdb']);
    });

    it('returns global chain when group chain is empty array', () => {
        const result = resolveProviderChainForGroup([], ['aggregated', 'tmdb', 'mdblist']);
        expect(result).toEqual(['aggregated', 'tmdb', 'mdblist']);
    });
});

describe('resolveFieldPrioritiesForGroup', () => {
    it('returns global defaults when group overrides is null', () => {
        const result = resolveFieldPrioritiesForGroup(null);
        expect(result('overview')).toEqual(FIELD_PRIORITY_DEFAULT.overview);
    });

    it('returns group override for overridden field', () => {
        const overrides = {
            overview: ['anidb', 'tmdb'],
            genres: ['anidb', 'tmdb'],
        };
        const result = resolveFieldPrioritiesForGroup(overrides);
        expect(result('overview')).toEqual(['anidb', 'tmdb']);
        expect(result('genres')).toEqual(['anidb', 'tmdb']);
    });

    it('falls through to global default for non-overridden field', () => {
        const overrides = { overview: ['anidb', 'tmdb'] };
        const result = resolveFieldPrioritiesForGroup(overrides);
        expect(result('vote_average')).toEqual(FIELD_PRIORITY_DEFAULT.vote_average);
    });

    it('returns undefined for unknown field', () => {
        const result = resolveFieldPrioritiesForGroup(null);
        expect(result('nonexistent_field_xyz')).toBeUndefined();
    });

    it('treats empty object same as null', () => {
        const result = resolveFieldPrioritiesForGroup({});
        expect(result('overview')).toEqual(FIELD_PRIORITY_DEFAULT.overview);
    });
});
