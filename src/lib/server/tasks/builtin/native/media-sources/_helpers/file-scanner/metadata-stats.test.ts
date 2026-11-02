// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { noteMetadataUnavailable, type MetadataScanStats } from './shared.js';

describe('noteMetadataUnavailable (Windows e2e S5)', () => {
    it('counts files and lets a rejected key win over a missing provider', () => {
        const metadataStats: MetadataScanStats = { unavailable: 0 };
        const ctx = { metadataStats };

        noteMetadataUnavailable(ctx, 'unavailable', 'anidb-metadata-provider');
        noteMetadataUnavailable(ctx, 'auth', 'tmdb-metadata-provider');
        noteMetadataUnavailable(ctx, 'unavailable', 'anidb-metadata-provider');

        expect(metadataStats).toEqual({
            unavailable: 3,
            error: 'auth',
            providerId: 'tmdb-metadata-provider',
        });
    });

    it('is a no-op for a context without stats (watcher path)', () => {
        expect(() => noteMetadataUnavailable({}, 'auth')).not.toThrow();
    });
});
