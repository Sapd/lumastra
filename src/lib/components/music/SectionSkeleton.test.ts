// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi } from 'vitest';
import { render } from '@testing-library/svelte';

// SectionSkeleton imports the `$lib/components/ui` barrel, which transitively
// reads `$env/dynamic/public` — a virtual module with no runtime backing under
// vitest. Mock it (repo-wide pattern) so the module graph evaluates.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

import SectionSkeleton from './SectionSkeleton.svelte';

describe('SectionSkeleton', () => {
    test('renders the requested number of card placeholders', () => {
        const { container } = render(SectionSkeleton, {
            props: { variant: 'track-carousel', count: 6 },
        });
        const cards = container.querySelectorAll('[data-testid="skeleton-card"]');
        expect(cards.length).toBe(6);
    });

    test('each card contains a shimmer element', () => {
        const { container } = render(SectionSkeleton, {
            props: { variant: 'track-carousel', count: 3 },
        });
        // The shared <Skeleton> renders an animated `.shimmer` overlay; every
        // card uses at least one Skeleton, so each card must contain a shimmer.
        const cards = container.querySelectorAll('[data-testid="skeleton-card"]');
        expect(cards.length).toBe(3);
        for (const card of cards) {
            expect(card.querySelector('.shimmer')).toBeTruthy();
        }
    });

    test('renders a section title placeholder', () => {
        const { container } = render(SectionSkeleton, {
            props: { variant: 'track-carousel', count: 3 },
        });
        // The title is the leading <Skeleton width="w-40" /> rendered before the
        // card row — the only w-40 skeleton bar in the tree.
        expect(container.querySelector('.skeleton-bar.w-40')).toBeTruthy();
    });

    test('track-carousel variant reserves square aspect media region', () => {
        const { container } = render(SectionSkeleton, {
            props: { variant: 'track-carousel', count: 1 },
        });
        // The media region is the first child div of the card (holds the
        // aspect-ratio classes).
        const card = container.querySelector('[data-testid="skeleton-card"]');
        const media = card?.querySelector('div');
        expect(media).toBeTruthy();
        expect(media?.className).toMatch(/aspect-square/);
    });

    test('artist-row variant reserves circular aspect media region', () => {
        const { container } = render(SectionSkeleton, {
            props: { variant: 'artist-row', count: 1 },
        });
        const card = container.querySelector('[data-testid="skeleton-card"]');
        const media = card?.querySelector('div');
        expect(media?.className).toMatch(/rounded-full/);
    });

    test('defaults count to 6 when prop omitted', () => {
        const { container } = render(SectionSkeleton, {
            props: { variant: 'track-carousel' },
        });
        const cards = container.querySelectorAll('[data-testid="skeleton-card"]');
        expect(cards.length).toBe(6);
    });
});
