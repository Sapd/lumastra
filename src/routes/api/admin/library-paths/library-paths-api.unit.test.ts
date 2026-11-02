// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit Tests for Library Paths API Validation
 *
 * Tests the Zod schemas used by the API endpoints.
 * Imports schemas directly from production files to prevent drift.
 * Does not require a database connection.
 */

import { describe, it, expect } from 'vitest';
import {
    // The REFINED schema, because that is what `defs/admin/library-paths.ts`
    // validates against. `path` is optional on the base object so remote
    // providers need not invent one; the refinement is what restores "a
    // filesystem library must have a path". Asserting against the base object
    // would pass while the endpoint's real contract regressed.
    libraryPathCreateBodyRefined as CreateBody,
    libraryPathPatchBodySchema as PatchBody,
} from '$lib/schemas/admin';

// -------------------------------------------------------------------------
// CreateBody
// -------------------------------------------------------------------------

describe('CreateBody schema', () => {
    it('accepts minimal valid input (only required fields)', () => {
        const result = CreateBody.safeParse({
            path: '/mnt/media/movies',
            media_type: 'movie',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            // Provider-specific defaults are applied after source resolution.
            expect(result.data.language).toBeUndefined();
            // No schema default: an omitted provider is decided server-side
            // (see libraryPathCreateBodySchema).
            expect(result.data.provider).toBeUndefined();
        }
    });

    it('accepts all fields explicitly', () => {
        const result = CreateBody.safeParse({
            path: '/anime',
            media_type: 'anime',
            language: 'ja',
            provider: 'anidb',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.language).toBe('ja');
            expect(result.data.provider).toBe('anidb');
        }
    });

    it('rejects missing path', () => {
        const result = CreateBody.safeParse({ media_type: 'movie' });
        expect(result.success).toBe(false);
    });

    it('rejects empty path', () => {
        const result = CreateBody.safeParse({ path: '', media_type: 'movie' });
        expect(result.success).toBe(false);
    });

    it('rejects missing media_type', () => {
        const result = CreateBody.safeParse({ path: '/movies' });
        expect(result.success).toBe(false);
    });

    it('rejects invalid media_type', () => {
        const result = CreateBody.safeParse({
            path: '/movies',
            media_type: 'games',
        });
        expect(result.success).toBe(false);
    });

    it('rejects invalid provider', () => {
        const result = CreateBody.safeParse({
            path: '/movies',
            media_type: 'movie',
            provider: 'netflix',
        });
        expect(result.success).toBe(false);
    });

    it('accepts all valid media_types', () => {
        const validTypes = ['movie', 'tv', 'anime', 'music', 'audiobook'] as const;
        for (const media_type of validTypes) {
            const result = CreateBody.safeParse({
                path: '/test',
                media_type,
            });
            expect(result.success).toBe(true);
        }
    });

    it('accepts all valid providers', () => {
        const validProviders = ['tmdb', 'jellyfin', 'anidb', 'tvdb', 'musicbrainz'] as const;
        for (const provider of validProviders) {
            const result = CreateBody.safeParse({
                path: '/test',
                media_type: 'movie',
                provider,
            });
            expect(result.success).toBe(true);
        }
    });

    it('accepts library_group_id as valid UUID', () => {
        const result = CreateBody.safeParse({
            path: '/movies/4k',
            media_type: 'movie',
            library_group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.library_group_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        }
    });

    it('rejects library_group_id that is not a UUID', () => {
        const result = CreateBody.safeParse({
            path: '/movies/4k',
            media_type: 'movie',
            library_group_id: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
    });

    it('accepts without library_group_id (optional)', () => {
        const result = CreateBody.safeParse({
            path: '/movies',
            media_type: 'movie',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.library_group_id).toBeUndefined();
        }
    });

    it('accepts edition_label as non-empty string', () => {
        const result = CreateBody.safeParse({
            path: '/movies/4k',
            media_type: 'movie',
            edition_label: '4k',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.edition_label).toBe('4k');
        }
    });

    it('accepts edition_label as null', () => {
        const result = CreateBody.safeParse({
            path: '/movies',
            media_type: 'movie',
            edition_label: null,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.edition_label).toBeNull();
        }
    });

    it('rejects edition_label as empty string', () => {
        const result = CreateBody.safeParse({
            path: '/movies',
            media_type: 'movie',
            edition_label: '',
        });
        expect(result.success).toBe(false);
    });

    it('accepts without edition_label (optional)', () => {
        const result = CreateBody.safeParse({
            path: '/movies',
            media_type: 'movie',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.edition_label).toBeUndefined();
        }
    });

    it('accepts both library_group_id and edition_label together', () => {
        const result = CreateBody.safeParse({
            path: '/movies/4k',
            media_type: 'movie',
            library_group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            edition_label: '4k',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.library_group_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
            expect(result.data.edition_label).toBe('4k');
        }
    });

    // ---------------------------------------------------------------------
    // Remote providers: the caller sends an upstream library id, NEVER a path
    // ---------------------------------------------------------------------

    describe('remote providers', () => {
        const absId = '2231b38d-b79d-439d-aca1-3c3753e31dad';

        it('accepts a remote provider with remote_library_id and no path', () => {
            const result = CreateBody.safeParse({
                media_type: 'audiobook',
                provider: 'audiobookshelf',
                remote_library_id: absId,
                language: 'de',
            });
            expect(result.success).toBe(true);
        });

        it('rejects a remote provider with no remote_library_id', () => {
            // Without this, the row inserts with an empty `provider_path` — which
            // is the field the connector resolves libraries from — and the sweep
            // skips it forever while the library looks configured.
            const result = CreateBody.safeParse({
                media_type: 'audiobook',
                provider: 'audiobookshelf',
            });
            expect(result.success).toBe(false);
        });

        it('rejects a caller-supplied path on a remote provider', () => {
            // The sentinel is derived server-side. Accepting one here is how a
            // mistyped `abs:/…` (single slash) reaches the database.
            const result = CreateBody.safeParse({
                media_type: 'audiobook',
                provider: 'audiobookshelf',
                remote_library_id: absId,
                path: `abs://${absId}`,
            });
            expect(result.success).toBe(false);
        });

        it('rejects remote_library_id on a filesystem provider', () => {
            const result = CreateBody.safeParse({
                path: '/media/movies',
                media_type: 'movie',
                provider: 'tmdb',
                remote_library_id: absId,
            });
            expect(result.success).toBe(false);
        });
    });
});

// -------------------------------------------------------------------------
// PatchBody
// -------------------------------------------------------------------------

describe('PatchBody schema', () => {
    it('accepts empty object (all fields optional)', () => {
        const result = PatchBody.safeParse({});
        expect(result.success).toBe(true);
    });

    it('accepts partial update with only enabled', () => {
        const result = PatchBody.safeParse({ enabled: false });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.enabled).toBe(false);
        }
    });

    it('accepts partial update with only path', () => {
        const result = PatchBody.safeParse({ path: '/new/path' });
        expect(result.success).toBe(true);
    });

    it('rejects empty path string', () => {
        const result = PatchBody.safeParse({ path: '' });
        expect(result.success).toBe(false);
    });

    it('rejects non-boolean enabled', () => {
        const result = PatchBody.safeParse({ enabled: 'yes' });
        expect(result.success).toBe(false);
    });

    it('rejects invalid media_type in patch', () => {
        const result = PatchBody.safeParse({ media_type: 'games' });
        expect(result.success).toBe(false);
    });

    it('accepts all fields set simultaneously', () => {
        const result = PatchBody.safeParse({
            path: '/updated',
            media_type: 'tv',
            language: 'fr',
            provider: 'tvdb',
            enabled: true,
        });
        expect(result.success).toBe(true);
    });

    it('accepts library_group_id as valid UUID', () => {
        const result = PatchBody.safeParse({
            library_group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.library_group_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
        }
    });

    it('rejects library_group_id that is not a UUID', () => {
        const result = PatchBody.safeParse({
            library_group_id: 'not-a-uuid',
        });
        expect(result.success).toBe(false);
    });

    it('accepts edition_label as non-empty string', () => {
        const result = PatchBody.safeParse({
            edition_label: 'extended',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.edition_label).toBe('extended');
        }
    });

    it('accepts edition_label as null (to clear it)', () => {
        const result = PatchBody.safeParse({
            edition_label: null,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.edition_label).toBeNull();
        }
    });

    it('rejects edition_label as empty string', () => {
        const result = PatchBody.safeParse({
            edition_label: '',
        });
        expect(result.success).toBe(false);
    });

    it('accepts library_group_id and edition_label together in patch', () => {
        const result = PatchBody.safeParse({
            library_group_id: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
            edition_label: '4k',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.library_group_id).toBe('a1b2c3d4-e5f6-7890-abcd-ef1234567890');
            expect(result.data.edition_label).toBe('4k');
        }
    });
});
