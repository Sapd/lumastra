// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * SectionRenderer is fully static again (see SectionRenderer.svelte and its
 * git history): a Task 10 attempt to move FeaturedPickSection behind
 * `{#await import(...)}` was reverted by a later edge-case fix round — the
 * `{#await}` had no pending branch, so RecommendationFeed's homepage "For
 * You" widget (which mounts SectionRenderer with real `type: 'featured-pick'`
 * content, not just synthetic test data — see `RecommendationFeed.svelte`)
 * popped the section in with a layout shift the moment the chunk finished
 * loading. FeaturedPickSection is back to a static import, so it now
 * server-renders like every other section type.
 *
 * This pins SectionRenderer's SSR contract for its three representative
 * section families: StandardSection (carousel/grid/continue-watching/
 * next-up), ListSection (list/watchlist — the home page's Watchlist widget
 * SSRs a `type: 'list'` loading skeleton unconditionally; see
 * `$lib/stores/watchlist.ts`), and featured-pick, which must now render
 * server-side too.
 *
 * This file lives under src/routes/browse/ rather than next to
 * SectionRenderer.svelte: `svelte/server`'s `render()` needs Svelte resolved
 * under the server/node condition, but `src/lib/components/**` tests run
 * under vitest.config.components.ts, which forces the BROWSER resolve
 * condition via `svelteTesting()` — `render` from 'svelte/server' does not
 * work there. A `*.test.ts` file under src/routes/browse/ matches the MAIN
 * (node-environment) vitest config's include glob instead, which is where
 * the SSR export SvelteKit itself uses in production actually runs.
 */
import { describe, test, expect } from 'vitest';
import { render } from 'svelte/server';
import SectionRenderer from '$lib/components/sections/SectionRenderer.svelte';
import type { PageSection } from '$lib/types/server-driven-ui';

function ssrBody(section: PageSection): string {
    return render(SectionRenderer, { props: { section } }).body;
}

describe('SectionRenderer SSR renders carousel/list/featured-pick content', () => {
    test('StandardSection (carousel) content is server-rendered', () => {
        const body = ssrBody({
            id: 'row1',
            type: 'carousel',
            title: 'Carousel SSR Title',
            items: [
                { externalIds: { internal: 'i1' }, title: 'Card One', mediaType: 'movie' },
            ] as unknown as PageSection['items'],
        });
        expect(body).toContain('Carousel SSR Title');
    });

    test('ListSection (watchlist loading skeleton) content is server-rendered', () => {
        const body = ssrBody({
            id: 'watchlist',
            type: 'list',
            title: 'Watchlist SSR Title',
            items: [],
            meta: { loading: true },
        });
        expect(body).toContain('Watchlist SSR Title');
    });

    test('FeaturedPickSection content is server-rendered', () => {
        const body = ssrBody({
            id: 'featured-pick-1',
            type: 'featured-pick',
            title: 'Featured Pick SSR Title',
            items: [
                {
                    externalIds: { internal: 'fp-item-1' },
                    title: 'Featured Pick SSR Title',
                    mediaType: 'movie',
                },
            ] as unknown as PageSection['items'],
        });
        expect(body).toContain('Featured Pick SSR Title');
    });
});
