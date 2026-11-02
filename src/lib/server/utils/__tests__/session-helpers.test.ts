// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for session helper utilities
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({
    config: {
        JWT_SECRET: 'test-secret-key-for-unit-tests',
    },
}));

import { buildSubtitle, buildImageUrl } from '../session-helpers';

describe('buildSubtitle', () => {
    describe('episodes', () => {
        it('formats S01E03 - Episode Title for episodes with title', () => {
            expect(
                buildSubtitle({
                    mediaType: 'episode',
                    seasonNumber: 1,
                    episodeNumber: 3,
                    seriesName: 'Voyage to Orion',
                    title: 'A Dim Light Amid Despair',
                }),
            ).toBe('S1E3 - A Dim Light Amid Despair');
        });

        it('formats S01E03 when episode has no title', () => {
            expect(
                buildSubtitle({
                    mediaType: 'episode',
                    seasonNumber: 1,
                    episodeNumber: 3,
                    seriesName: 'Voyage to Orion',
                }),
            ).toBe('S1E3');
        });

        it('formats S01E03 when episode has no seriesName', () => {
            expect(
                buildSubtitle({
                    mediaType: 'episode',
                    seasonNumber: 1,
                    episodeNumber: 3,
                    title: 'Some Title',
                }),
            ).toBe('S1E3');
        });

        it('defaults season and episode to 0 when missing', () => {
            expect(
                buildSubtitle({
                    mediaType: 'episode',
                }),
            ).toBe('S0E0');
        });

        it('handles EPISODE uppercase (case-insensitive)', () => {
            expect(
                buildSubtitle({
                    mediaType: 'EPISODE',
                    seasonNumber: 2,
                    episodeNumber: 5,
                    seriesName: 'Show',
                    title: 'Ep Title',
                }),
            ).toBe('S2E5 - Ep Title');
        });
    });

    describe('music', () => {
        it('returns artist name from seriesName', () => {
            expect(
                buildSubtitle({
                    mediaType: 'music',
                    seriesName: 'Dusk Harbor',
                }),
            ).toBe('Dusk Harbor');
        });

        it('returns undefined when no seriesName', () => {
            expect(
                buildSubtitle({
                    mediaType: 'music',
                }),
            ).toBeUndefined();
        });
    });

    describe('audiobook', () => {
        it('returns chapter name', () => {
            expect(
                buildSubtitle({
                    mediaType: 'audiobook',
                    chapter: 'Chapter 5: The Return',
                }),
            ).toBe('Chapter 5: The Return');
        });

        it('returns undefined when no chapter', () => {
            expect(
                buildSubtitle({
                    mediaType: 'audiobook',
                }),
            ).toBeUndefined();
        });
    });

    describe('other media types', () => {
        it('returns undefined for movies', () => {
            expect(
                buildSubtitle({
                    mediaType: 'movie',
                    title: 'Daydream',
                }),
            ).toBeUndefined();
        });

        it('returns undefined for tv', () => {
            expect(
                buildSubtitle({
                    mediaType: 'tv',
                    seriesName: 'Drifting Clouds',
                }),
            ).toBeUndefined();
        });

        it('returns undefined when mediaType is undefined', () => {
            expect(buildSubtitle({})).toBeUndefined();
        });
    });
});

describe('buildImageUrl', () => {
    it('generates a signed catalog URL when internal ID is present', () => {
        const result = buildImageUrl({
            externalIds: { internal: 'uuid-123' },
            jellyfinId: 'jf-456',
        });

        expect(result).toContain('/api/v1/media/uuid-123/images/poster');
        expect(result).toContain('purpose=image');
        expect(result).toContain('sig=');
        expect(result).toContain('expires=');
    });

    it('prefers internal ID over jellyfinId', () => {
        const result = buildImageUrl({
            externalIds: { internal: 'uuid-123' },
            jellyfinId: 'jf-456',
        });

        expect(result).toContain('media/uuid-123/images/poster');
        expect(result).not.toContain('jellyfin/jf-456');
    });

    it('falls back to jellyfin URL when no internal ID', () => {
        const result = buildImageUrl({
            externalIds: { tmdb: '550' },
            jellyfinId: 'jf-456',
        });

        expect(result).toContain('/api/v1/media/');
        expect(result).toContain('images/primary');
    });

    it('returns undefined when no image source available', () => {
        expect(buildImageUrl({})).toBeUndefined();
        expect(buildImageUrl({ externalIds: {} })).toBeUndefined();
        expect(buildImageUrl({ externalIds: { tmdb: '550' } })).toBeUndefined();
    });

    it('returns undefined when externalIds is undefined', () => {
        expect(buildImageUrl({ externalIds: undefined, jellyfinId: undefined })).toBeUndefined();
    });

    it('generates a URL with 10-minute expiry', () => {
        const result = buildImageUrl({
            externalIds: { internal: 'uuid-123' },
        });

        const url = new URL(result!, 'http://localhost');
        const expires = parseInt(url.searchParams.get('expires')!, 10);
        const now = Math.floor(Date.now() / 1000);

        // Should be ~600 seconds from now
        expect(expires - now).toBeGreaterThanOrEqual(598);
        expect(expires - now).toBeLessThanOrEqual(602);
    });
});
