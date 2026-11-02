// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { buildHeroSection, capHeroItems, mergeSsrFirstSlide } from './hero-builder';
import { getExternalIdFor } from '$lib/utils/external-ids';
import type { HeroFirstSlide } from '$lib/schemas/hero';

describe('hero item helpers', () => {
    it('caps the hero item list to maxSlides', () => {
        const items = Array.from({ length: 9 }, (_, i) => ({
            externalIds: { internal: `id-${i}` },
        }));
        expect(capHeroItems(items, 5)).toHaveLength(5);
    });

    it('promotes the full built item to front and discards the thin SSR placeholder', () => {
        type TestItem = {
            externalIds?: { internal?: string };
            title?: string;
            backdrop?: string;
            isPlaying?: boolean;
        };
        const ssr: TestItem = { externalIds: { internal: 'ep-1' }, title: 'SSR thin' };
        const built: TestItem[] = [
            { externalIds: { internal: 'ep-1' }, title: 'full', backdrop: '/real-backdrop.jpg' },
            { externalIds: { internal: 'ep-2' }, title: 'other' },
        ];
        const merged = mergeSsrFirstSlide(ssr, built);
        expect(merged[0].externalIds?.internal).toBe('ep-1');
        // Must be the rich built item, not the thin SSR placeholder
        expect((merged[0] as TestItem).backdrop).toBe('/real-backdrop.jpg');
        expect(merged.filter((i) => i.externalIds?.internal === 'ep-1')).toHaveLength(1);
    });

    it('prepends the thin SSR slide when built has no matching item', () => {
        type TestItem = {
            externalIds?: { internal?: string };
            title?: string;
            isPlaying?: boolean;
        };
        const ssr: TestItem = { externalIds: { internal: 'ep-X' }, title: 'SSR' };
        const built: TestItem[] = [
            { externalIds: { internal: 'ep-2' } },
            { externalIds: { internal: 'ep-3' } },
        ];
        const merged = mergeSsrFirstSlide(ssr, built);
        expect(merged[0].externalIds?.internal).toBe('ep-X');
        expect(merged).toHaveLength(3);
    });

    it('carries the SSR seed live-playing flag onto the promoted built item', () => {
        // The client-built item comes from the raw /continue endpoint (no live
        // overlay), so it lacks isPlaying. The SSR seed HAS the overlay state —
        // it must survive the promotion, else "Playing now" flashes then vanishes.
        type TestItem = {
            externalIds?: { internal?: string };
            backdrop?: string;
            isPlaying?: boolean;
        };
        const ssr: TestItem = { externalIds: { internal: 'ep-1' }, isPlaying: true };
        const built: TestItem[] = [
            { externalIds: { internal: 'ep-1' }, backdrop: '/real.jpg' },
            { externalIds: { internal: 'ep-2' } },
        ];
        const merged = mergeSsrFirstSlide(ssr, built);
        expect((merged[0] as TestItem).isPlaying).toBe(true);
        // Still the rich built item (backdrop preserved), not the thin seed.
        expect((merged[0] as TestItem).backdrop).toBe('/real.jpg');
    });

    it('does not fabricate a playing flag when the SSR seed is not playing', () => {
        type TestItem = {
            externalIds?: { internal?: string };
            backdrop?: string;
            isPlaying?: boolean;
        };
        const ssr: TestItem = { externalIds: { internal: 'ep-1' } };
        const built: TestItem[] = [{ externalIds: { internal: 'ep-1' }, backdrop: '/real.jpg' }];
        const merged = mergeSsrFirstSlide(ssr, built);
        expect((merged[0] as TestItem).isPlaying).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// Refresh-build contract
// ---------------------------------------------------------------------------
//
// `refresh: true` is the option set used by the homepage's SWR revalidation and
// its afterNavigate rebuild. Those call sites used to pass ONLY `refresh`, so
// the rebuild dropped `ssrFirstSlide` and `maxSlides`: the daypart-rotated SSR
// lead lost its slot-0 pin (nothing else in this builder rotates — the watching
// pool is consumed in raw Continue-then-NextUp order and sliced to
// MAX_WATCHING_SLIDES), so a lead sitting past that slice disappeared from the
// carousel a second after it painted, and the list also grew past the cap.
//
// These pin that `refresh` is orthogonal to the merge and the cap, so a build
// made for a refresh yields the same slot 0 and the same length as the initial
// build.

vi.mock('$lib/api/for-you', () => ({
    getTasteRail: vi.fn(async () => ({ data: { items: [] } })),
    getRandomPicks: vi.fn(async () => ({ data: { items: [] } })),
}));

describe('buildHeroSection refresh build', () => {
    /** Minimal /api/recommendations rows the next-up transformer accepts. */
    function watchingRow(id: string, title: string) {
        return { id, title, mediaType: 'movie' as const, externalIds: { internal: id } };
    }

    function mockFetch(rows: { continue: unknown[]; nextup: unknown[]; movies: unknown[] }) {
        return vi.fn(async (url: string, init?: RequestInit) => {
            const type =
                typeof init?.body === 'string'
                    ? (JSON.parse(init.body) as { type?: string }).type
                    : new URL(url, 'http://localhost').searchParams.get('type');
            const body =
                type === 'continue'
                    ? { items: rows.continue }
                    : type === 'nextup'
                      ? { items: rows.nextup }
                      : { items: rows.movies };
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as unknown as typeof globalThis.fetch;
    }

    // The SSR lead is deliberately the THIRD watching row: the daypart rotation
    // that picked it server-side does not exist client-side, so only
    // mergeSsrFirstSlide can put it at slot 0 — and MAX_WATCHING_SLIDES (2)
    // means it is otherwise dropped from the carousel entirely.
    const ssrLead = {
        externalIds: { internal: 'lead-3' },
        title: 'Star Harbor: The Next Generation',
        mediaType: 'tv',
    } as unknown as HeroFirstSlide;

    const rows = {
        continue: [watchingRow('lead-1', 'An Audiobook'), watchingRow('lead-2', 'Another Show')],
        nextup: [watchingRow('lead-3', 'Star Harbor: The Next Generation')],
        movies: [watchingRow('mov-1', 'Movie 1'), watchingRow('mov-2', 'Movie 2')],
    };

    it('pins the SSR lead at slot 0 on a refresh build', async () => {
        const result = await buildHeroSection({
            fetch: mockFetch(rows),
            ssrFirstSlide: ssrLead,
            maxSlides: 5,
            refresh: true,
        });
        expect(getExternalIdFor(result.section.items[0].externalIds, 'internal')).toBe('lead-3');
    });

    it('honours maxSlides on a refresh build', async () => {
        const result = await buildHeroSection({
            fetch: mockFetch(rows),
            ssrFirstSlide: ssrLead,
            maxSlides: 2,
            refresh: true,
        });
        expect(result.section.items).toHaveLength(2);
    });

    it('drops the lead entirely when the refresh build omits ssrFirstSlide', async () => {
        // Documents the regression this pair guards: without the SSR slide the
        // rotated lead is not merely demoted, it is absent — slot 0 becomes the
        // first Continue-Watching row instead.
        const result = await buildHeroSection({
            fetch: mockFetch(rows),
            maxSlides: 5,
            refresh: true,
        });
        const ids = result.section.items.map((i) => getExternalIdFor(i.externalIds, 'internal'));
        expect(ids[0]).toBe('lead-1');
        expect(ids).not.toContain('lead-3');
    });
});
