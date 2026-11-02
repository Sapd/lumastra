// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    patScopeSchema,
    patCreateBodySchema,
    serviceTokenScopeSchema,
    libraryGroupCreateBodySchema,
    librarySetupBodySchema,
} from './admin';

describe('patScopeSchema', () => {
    it('accepts jellyfin_compat', () => {
        expect(patScopeSchema.parse('jellyfin_compat')).toBe('jellyfin_compat');
    });

    it('accepts jellyfin_compat_read', () => {
        expect(patScopeSchema.parse('jellyfin_compat_read')).toBe('jellyfin_compat_read');
    });

    it('still accepts existing scopes', () => {
        expect(patScopeSchema.parse('read')).toBe('read');
        expect(patScopeSchema.parse('write')).toBe('write');
        expect(patScopeSchema.parse('admin')).toBe('admin');
    });

    it('rejects invalid scopes', () => {
        expect(() => patScopeSchema.parse('invalid')).toThrow();
    });
});

describe('patCreateBodySchema scope normalization and exclusivity', () => {
    it('normalizes whitespace and lowercase', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['  Jellyfin_Compat  '],
        });
        expect(result.scopes).toEqual(['jellyfin_compat']);
    });

    it('rejects jellyfin_compat mixed with admin', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['jellyfin_compat', 'admin'],
            }),
        ).toThrow(/exclusive/);
    });

    it('rejects whitespace-tricked jellyfin_compat mixed with admin', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['  jellyfin_compat  ', 'admin'],
            }),
        ).toThrow(/exclusive/);
    });

    it('rejects jellyfin_compat mixed with read', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['jellyfin_compat', 'read'],
            }),
        ).toThrow(/exclusive/);
    });

    it('rejects jellyfin_compat mixed with write', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['jellyfin_compat', 'write'],
            }),
        ).toThrow(/exclusive/);
    });

    it('accepts jellyfin_compat alone', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['jellyfin_compat'],
        });
        expect(result.scopes).toEqual(['jellyfin_compat']);
    });

    it('accepts jellyfin_compat_read alone', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['jellyfin_compat_read'],
        });
        expect(result.scopes).toEqual(['jellyfin_compat_read']);
    });

    it('rejects jellyfin_compat_read mixed with read', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['jellyfin_compat_read', 'read'],
            }),
        ).toThrow(/exclusive/);
    });

    it('rejects jellyfin_compat_read mixed with admin', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['jellyfin_compat_read', 'admin'],
            }),
        ).toThrow(/exclusive/);
    });

    it('rejects jellyfin_compat mixed with jellyfin_compat_read', () => {
        expect(() =>
            patCreateBodySchema.parse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                name: 'token',
                scopes: ['jellyfin_compat', 'jellyfin_compat_read'],
            }),
        ).toThrow(/exclusive/);
    });

    it('accepts read alone (default scopes still work)', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['read'],
        });
        expect(result.scopes).toEqual(['read']);
    });

    it('accepts write alone', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['write'],
        });
        expect(result.scopes).toEqual(['write']);
    });

    it('accepts admin alone', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['admin'],
        });
        expect(result.scopes).toEqual(['admin']);
    });

    it('accepts multiple non-exclusive scopes', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['read', 'write'],
        });
        expect(result.scopes).toEqual(['read', 'write']);
    });

    it('defaults to [read] when scopes omitted', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
        });
        expect(result.scopes).toEqual(['read']);
    });

    it('normalizes case in multi-scope array', () => {
        const result = patCreateBodySchema.parse({
            userId: '550e8400-e29b-41d4-a716-446655440000',
            name: 'token',
            scopes: ['READ', 'WRITE'],
        });
        expect(result.scopes).toEqual(['read', 'write']);
    });
});

describe('serviceTokenScopeSchema', () => {
    it('accepts read', () => {
        expect(serviceTokenScopeSchema.parse('read')).toBe('read');
    });

    it('accepts write', () => {
        expect(serviceTokenScopeSchema.parse('write')).toBe('write');
    });

    it('accepts admin', () => {
        expect(serviceTokenScopeSchema.parse('admin')).toBe('admin');
    });

    it('rejects jellyfin_compat (PAT-only scope)', () => {
        expect(() => serviceTokenScopeSchema.parse('jellyfin_compat')).toThrow();
    });

    it('rejects jellyfin_compat_read (PAT-only scope)', () => {
        expect(() => serviceTokenScopeSchema.parse('jellyfin_compat_read')).toThrow();
    });

    it('rejects unknown scope', () => {
        expect(() => serviceTokenScopeSchema.parse('moderator')).toThrow();
    });
});

describe('libraryGroupCreateBodySchema', () => {
    it('accepts a name-only body (all optional fields omitted)', () => {
        expect(() => libraryGroupCreateBodySchema.parse({ name: 'Series' })).not.toThrow();
    });

    // Regression: LibraryGroupModal.svelte always sends `null` (not omits) for
    // unset optional fields — the create form 422'd on every group with a blank
    // description/icon/max age rating because these were `.optional()` only,
    // not `.nullable()`, unlike the PATCH schema below it.
    it('accepts explicit null for description/icon/max_age_rating/metadata_provider_chain', () => {
        expect(() =>
            libraryGroupCreateBodySchema.parse({
                name: 'Series',
                description: null,
                icon: null,
                sort_order: 0,
                max_age_rating: null,
                metadata_provider_chain: null,
            }),
        ).not.toThrow();
    });

    it('still rejects a missing name', () => {
        expect(() => libraryGroupCreateBodySchema.parse({})).toThrow();
    });
});

describe('library setup language default', () => {
    it('leaves an omitted language to the server instead of inserting English', () => {
        const parsed = librarySetupBodySchema.parse({
            name: 'Movies',
            media_type: 'movie',
            paths: [{ path: '/media/movies' }],
        });
        expect(parsed.paths[0].language).toBeUndefined();
    });
});
