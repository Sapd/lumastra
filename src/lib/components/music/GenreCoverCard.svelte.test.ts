// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The card degrades by TILE COUNT. A 3-cover collage in a 2x2 grid leaves a
 * visible hole, so anything short of four falls back to a single cover rather
 * than rendering a gap.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, it } from 'vitest';
import GenreCoverCard from './GenreCoverCard.svelte';

afterEach(cleanup);

const ids = (n: number): string[] =>
    Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-00000000000${i}`);

describe('GenreCoverCard', () => {
    it('renders a 2x2 collage when four covers are available', () => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Trance', albumIds: ids(4) },
        });
        expect(container.querySelectorAll('img')).toHaveLength(4);
    });

    it('uses at most four covers even when more are supplied', () => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Trance', albumIds: ids(9) },
        });
        expect(container.querySelectorAll('img')).toHaveLength(4);
    });

    it.each([1, 2, 3])('falls back to a single cover for %i available', (n) => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Hardstyle', albumIds: ids(n) },
        });
        expect(container.querySelectorAll('img')).toHaveLength(1);
    });

    it('renders the placeholder glyph, not a broken image, with no covers', () => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Obscure', albumIds: [] },
        });
        expect(container.querySelectorAll('img')).toHaveLength(0);
        expect(container.textContent).toContain('♪');
    });

    it('links to the genre page with the name URL-encoded', () => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Drum & Bass', albumIds: ids(4) },
        });
        const href = container.querySelector('a')?.getAttribute('href');
        expect(href).toContain('Drum%20%26%20Bass');
    });

    it('shows the genre name and track count', () => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Techno', albumIds: ids(4), trackCount: 412 },
        });
        expect(container.textContent).toContain('Techno');
        expect(container.textContent).toContain('412');
    });

    it('omits the count line when none is given', () => {
        const { container } = render(GenreCoverCard, {
            props: { genre: 'Techno', albumIds: ids(4) },
        });
        expect(container.querySelectorAll('p')).toHaveLength(1);
    });
});
