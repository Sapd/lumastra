// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * embedding-reset native task — manifest tests. Importing the module also
 * exercises defineTask's manifest validation (an invalid manifest — e.g.
 * exclusiveWith.ttl < timeout.hard — throws at import, failing these tests).
 */

import { describe, it, expect } from 'vitest';
import { embeddingResetTask } from './embedding-reset.js';

describe('embedding-reset task manifest', () => {
    it('has the correct id and maintenance resource class', () => {
        expect(embeddingResetTask.id).toBe('embedding-reset');
        expect(embeddingResetTask.resourceClass).toBe('maintenance');
    });

    it('is one-shot (no schedule) with global scope', () => {
        expect(embeddingResetTask.schedule).toBeUndefined();
        expect(embeddingResetTask.scope).toBe('global');
    });

    it('declares exclusiveWith so a double-click cannot race two deletes', () => {
        expect(embeddingResetTask.exclusiveWith).toMatchObject({ scope: 'global', ttl: '50m' });
    });

    it('derives a per-source identity so resets of different sources do not collide', () => {
        expect(embeddingResetTask.identityFor({ source: 'library' })).toBe(
            'embedding-reset-library',
        );
        expect(embeddingResetTask.identityFor({ source: 'discovery' })).toBe(
            'embedding-reset-discovery',
        );
        expect(embeddingResetTask.identityFor({ source: 'all' })).toBe('embedding-reset-all');
    });

    it('accepts the four reset sources and rejects others', () => {
        for (const source of ['library', 'discovery', 'music', 'all']) {
            expect(embeddingResetTask.inputSchema.safeParse({ source }).success).toBe(true);
        }
        expect(embeddingResetTask.inputSchema.safeParse({ source: 'tmdb' }).success).toBe(false);
        expect(embeddingResetTask.inputSchema.safeParse({}).success).toBe(false);
    });
});
