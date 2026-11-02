// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/database/queries/topshelf-overlay.queries.js', () => ({
    getMediaItemOverlayFields: vi.fn(),
}));
vi.mock('$lib/server/database/queries/catalog-operations.queries.js', () => ({
    getImageMetadata: vi.fn(),
}));

import { getMediaItemOverlayFields } from '$lib/server/database/queries/topshelf-overlay.queries.js';
import { getImageMetadata } from '$lib/server/database/queries/catalog-operations.queries.js';
import { resolveOverlay } from './topshelf-overlay-resolver.js';

const sql = {} as never;
const style = { pos: 'tl', scrim: true, scale: 0.4 } as const;

beforeEach(() => vi.clearAllMocks());

describe('resolveOverlay', () => {
    it('episode WITH an inherited series logo → logo + S01E02 badge (no burned title text)', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: 'The Pilot',
            seasonNumber: 1,
            episodeNumber: 2,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        // getImageMetadata walks the parent chain, so this IS the series logo.
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: '/series-logo.png' } as never);

        const r = await resolveOverlay(sql, 'ep-1', style, 'en');

        expect(r.mode).toBe('logo');
        expect(r.badge).toBe('S01E02');
        expect(r.text).toBeUndefined();
        expect(getImageMetadata).toHaveBeenCalledWith(sql, 'ep-1', 'logo');
    });

    it('episode badge omits a null segment and disappears when both are null', async () => {
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: '/series-logo.png' } as never);

        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: 'Special',
            seasonNumber: null,
            episodeNumber: 7,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        expect((await resolveOverlay(sql, 'ep-a', style, 'en')).badge).toBe('E07');

        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: 'Special',
            seasonNumber: 3,
            episodeNumber: null,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        expect((await resolveOverlay(sql, 'ep-b', style, 'en')).badge).toBe('S03');

        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: 'Special',
            seasonNumber: null,
            episodeNumber: null,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        const noNumbers = await resolveOverlay(sql, 'ep-c', style, 'en');
        expect(noNumbers.mode).toBe('logo');
        expect(noNumbers.badge).toBeUndefined();
    });

    it('the badge participates in the logo content hash (a renumber rotates the artifact)', async () => {
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: '/series-logo.png' } as never);
        const fields = {
            mediaType: 'episode',
            title: 'The Pilot',
            seasonNumber: 1,
            episodeNumber: 2,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        };
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue(fields);
        const first = await resolveOverlay(sql, 'ep-1', style, 'en');

        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({ ...fields, episodeNumber: 3 });
        const renumbered = await resolveOverlay(sql, 'ep-1', style, 'en');

        expect(renumbered.badge).toBe('S01E03');
        expect(renumbered.contentHash).not.toBe(first.contentHash);
    });

    it('episode WITHOUT any logo → text SxEx · Name (the fixed fallback rendering)', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: 'The Pilot',
            seasonNumber: 1,
            episodeNumber: 2,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: null } as never);

        const r = await resolveOverlay(sql, 'ep-1', style, 'en');

        expect(r.mode).toBe('text');
        expect(r.text).toBe('S01E02 · The Pilot');
        expect(r.badge).toBeUndefined();
    });

    it('movie with a logo → logo with NO badge (movies are unchanged)', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'movie',
            title: 'Cloud Runner',
            seasonNumber: null,
            episodeNumber: null,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: '/abc.png' } as never);
        const r = await resolveOverlay(sql, 'mv-1', style, 'en');
        expect(r.mode).toBe('logo');
        expect(r.badge).toBeUndefined();
        expect(r.contentHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('movie without a logo → text title', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'movie',
            title: 'Obscure Film',
            seasonNumber: null,
            episodeNumber: null,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: null } as never);
        const r = await resolveOverlay(sql, 'mv-2', style, 'en');
        expect(r.mode).toBe('text');
        expect(r.text).toBe('Obscure Film');
    });

    it('no title and no logo → none', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'movie',
            title: null,
            seasonNumber: null,
            episodeNumber: null,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: null } as never);
        const r = await resolveOverlay(sql, 'mv-3', style, 'en');
        expect(r.mode).toBe('none');
    });

    it('whitespace-only title and no logo → none (FIX 5, does not render a blank overlay)', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'movie',
            title: '   ',
            seasonNumber: null,
            episodeNumber: null,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: null } as never);
        const r = await resolveOverlay(sql, 'mv-4', style, 'en');
        expect(r.mode).toBe('none');
    });

    it('logo-less episode with a whitespace-only title omits the name segment (SxEx-only)', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: '   ',
            seasonNumber: 1,
            episodeNumber: 2,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockResolvedValue({ logo_path: null } as never);
        const r = await resolveOverlay(sql, 'ep-2', style, 'en');
        expect(r.mode).toBe('text');
        expect(r.text).toBe('S01E02');
    });

    it('a logo-metadata lookup FAILURE degrades an episode to text, never to a broken logo', async () => {
        vi.mocked(getMediaItemOverlayFields).mockResolvedValue({
            mediaType: 'episode',
            title: 'The Pilot',
            seasonNumber: 1,
            episodeNumber: 2,
            customLogoUrl: null,
            updatedAt: '2026-01-01T00:00:00Z',
        });
        vi.mocked(getImageMetadata).mockRejectedValue(new Error('db down'));
        const r = await resolveOverlay(sql, 'ep-3', style, 'en');
        expect(r.mode).toBe('text');
        expect(r.text).toBe('S01E02 · The Pilot');
    });
});
