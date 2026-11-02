// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for the external encoder registry in providers/encode-id.ts.
 *
 * Covers: register/unregister round-trip, external-over-builtin precedence,
 * fallback to builtin switch after unregister, unknown-provider passthrough.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { encodeDetailId, registerProviderEncoder, unregisterProviderEncoder } from './encode-id.js';

// ============================================================================
// Helpers
// ============================================================================

const EXT_ID = 'my-external-provider';

beforeEach(() => {
    // Clean up any leftover registration from a previous test.
    unregisterProviderEncoder(EXT_ID);
    unregisterProviderEncoder('tmdb-metadata-provider');
});

// ============================================================================
// Tests
// ============================================================================

describe('registerProviderEncoder / unregisterProviderEncoder', () => {
    it('passes raw ID through for unknown provider before registration', () => {
        expect(encodeDetailId(EXT_ID, 'movie', 'abc123')).toBe('abc123');
    });

    it('dispatches to the external encoder after registration', () => {
        registerProviderEncoder(EXT_ID, (mediaType, rawId) => `ext:${mediaType}:${rawId}`);

        expect(encodeDetailId(EXT_ID, 'movie', '42')).toBe('ext:movie:42');
        expect(encodeDetailId(EXT_ID, 'tv', '99')).toBe('ext:tv:99');
        expect(encodeDetailId(EXT_ID, 'series', '7')).toBe('ext:series:7');
    });

    it('falls back to pass-through after unregistration', () => {
        registerProviderEncoder(EXT_ID, () => 'encoded');
        unregisterProviderEncoder(EXT_ID);

        expect(encodeDetailId(EXT_ID, 'movie', 'raw')).toBe('raw');
    });

    it('external encoder takes precedence over builtin for tmdb', () => {
        registerProviderEncoder(
            'tmdb-metadata-provider',
            (_mediaType, rawId) => `OVERRIDE:${rawId}`,
        );

        expect(encodeDetailId('tmdb-metadata-provider', 'movie', '550')).toBe('OVERRIDE:550');

        unregisterProviderEncoder('tmdb-metadata-provider');
    });

    it('restores builtin tmdb encoding after external override is unregistered', () => {
        registerProviderEncoder('tmdb-metadata-provider', () => 'OVERRIDE');
        unregisterProviderEncoder('tmdb-metadata-provider');

        expect(encodeDetailId('tmdb-metadata-provider', 'movie', '550')).toBe('movie:550');
        expect(encodeDetailId('tmdb-metadata-provider', 'tv', '1399')).toBe('tv:1399');
        expect(encodeDetailId('tmdb-metadata-provider', 'series', '1399')).toBe('tv:1399');
    });

    it('builtin tmdb skips double-prefix when id is already encoded', () => {
        expect(encodeDetailId('tmdb-metadata-provider', 'movie', 'movie:550')).toBe('movie:550');
        expect(encodeDetailId('tmdb-metadata-provider', 'tv', 'tv:1399')).toBe('tv:1399');
    });

    it('builtin mdblist uses IMDB passthrough for tt-prefixed ids', () => {
        expect(encodeDetailId('mdblist-metadata-provider', 'movie', 'tt0137523')).toBe('tt0137523');
    });

    it('builtin mdblist encodes tmdb composite for non-IMDB ids', () => {
        expect(encodeDetailId('mdblist-metadata-provider', 'movie', '550')).toBe('tmdb:550:movie');
        expect(encodeDetailId('mdblist-metadata-provider', 'series', '1399')).toBe('tmdb:1399:tv');
    });

    it('builtin jellyfin and anidb pass raw id through', () => {
        const uuid = 'a1b2c3d4-1234-5678-abcd-ef0123456789';
        expect(encodeDetailId('jellyfin-metadata-provider', 'movie', uuid)).toBe(uuid);
        expect(encodeDetailId('anidb-metadata-provider', 'tv', '12345')).toBe('12345');
    });
});

// ============================================================================
// Regression: enrichment call sites must pass the resolved plugin id
// ============================================================================

describe('encodeDetailId — regression: resolve-before-call approach', () => {
    it('encodes movie id correctly when called with the plugin id (not the ExternalIdProvider key)', () => {
        // Call sites must resolve 'tmdb' → 'tmdb-metadata-provider' via
        // externalIdToPluginId() BEFORE calling encodeDetailId. Passing the
        // raw ExternalIdProvider key 'tmdb' falls through to the default
        // pass-through and produces a bare '550' which parseId rejects.
        expect(encodeDetailId('tmdb-metadata-provider', 'movie', '550')).toBe('movie:550');
        expect(encodeDetailId('tmdb-metadata-provider', 'tv', '1399')).toBe('tv:1399');
        expect(encodeDetailId('tmdb-metadata-provider', 'series', '1399')).toBe('tv:1399');
    });

    it('bare ExternalIdProvider key tmdb passes through unchanged (no alias added)', () => {
        // Confirms we chose resolve-before-call over alias-in-encodeDetailId.
        // 'tmdb' is not a registered provider id — it falls through to pass-through.
        // Callers must never pass 'tmdb' here; they must use externalIdToPluginId first.
        expect(encodeDetailId('tmdb', 'movie', '550')).toBe('550');
    });
});
