// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Mutable per-test page-data stub so the override tests can inject a
// $page.data.branding.ratingLogo* without re-mocking the module. Built via
// vi.hoisted() because vi.mock() factories are hoisted above regular
// top-level declarations — a plain `let` here would be in the temporal
// dead zone when the factory below first runs.
const { getPageDataStub, setPageDataStub } = vi.hoisted(() => {
    type PageDataStub = { data: Record<string, unknown>; url: URL };
    let stub: PageDataStub = { data: {}, url: new URL('http://localhost/') };
    return {
        getPageDataStub: () => stub,
        setPageDataStub: (next: PageDataStub) => {
            stub = next;
        },
    };
});
vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (value: ReturnType<typeof getPageDataStub>) => void) => {
            run(getPageDataStub());
            return () => {};
        },
    },
}));
vi.mock('$lib/components/sections', () => ({ SectionRenderer: vi.fn() }));
vi.mock('$lib/components/modal', () => ({ ActorChip: vi.fn() }));
vi.mock('./SocialReviewSection.svelte', () => ({ default: vi.fn() }));
vi.mock('$lib/utils/modal-utils', () => ({ openActorModal: vi.fn() }));

import ModalBody from './ModalBody.svelte';

describe('ModalBody rating badges — IMDb/Rotten Tomatoes ship as text by default (L9)', () => {
    test('omits facts already shown in the header while retaining ratings and studio', () => {
        const { queryByText, getByText } = render(ModalBody, {
            hidePrimaryMetadata: true,
            year: '2016',
            duration: 6960,
            genres: ['Science Fiction'],
            rating: 8,
            studio: 'A studio',
        });
        expect(queryByText('2016')).toBeNull();
        expect(queryByText('Science Fiction')).toBeNull();
        expect(getByText('IMDb')).toBeTruthy();
        expect(getByText('A studio')).toBeTruthy();
    });
    afterEach(() => {
        cleanup();
        setPageDataStub({ data: {}, url: new URL('http://localhost/') });
    });

    test('IMDb rating renders the "IMDb" text label, no logo image', () => {
        const { container, getByText } = render(ModalBody, { rating: 8 });
        expect(container.querySelector('img[alt="IMDb Rating"]')).toBeNull();
        expect(getByText('IMDb')).toBeTruthy();
    });

    test('Rotten Tomatoes critics score renders the "RT" text label, no logo image', () => {
        const { container, getAllByText } = render(ModalBody, { criticRating: 85 });
        expect(container.querySelector('img[alt="RT Critics"]')).toBeNull();
        expect(getAllByText('RT').length).toBeGreaterThan(0);
    });

    test('Rotten Tomatoes audience score renders the "RT" text label, no inline tomato SVG mark', () => {
        const { container, getAllByText } = render(ModalBody, { rtAudience: 90 });
        expect(container.querySelector('img[alt="Rotten Tomatoes Audience"]')).toBeNull();
        // The component used to inline a full Rotten Tomatoes tomato mark as raw
        // SVG (fill="#fa3106"); assert that specific mark is gone rather than
        // "no svg anywhere", since unrelated icons elsewhere in the modal are
        // legitimate SVGs.
        expect(container.querySelector('svg path[fill="#fa3106"]')).toBeNull();
        expect(getAllByText('RT').length).toBeGreaterThan(0);
    });
});

describe('ModalBody rating badges — operator-supplied RATING_LOGO_* override (L9)', () => {
    afterEach(() => {
        cleanup();
        setPageDataStub({ data: {}, url: new URL('http://localhost/') });
    });

    test('a configured RATING_LOGO_IMDB renders the logo instead of the text label', () => {
        setPageDataStub({
            data: { branding: { ratingLogoImdb: '/custom/imdb-logo.svg' } },
            url: new URL('http://localhost/'),
        });
        const { container, queryByText } = render(ModalBody, { rating: 8 });
        const img = container.querySelector('img[alt="IMDb Rating"]') as HTMLImageElement;
        expect(img).toBeTruthy();
        expect(img.src).toContain('/custom/imdb-logo.svg');
        expect(queryByText('IMDb')).toBeNull();
    });

    test('a configured RATING_LOGO_ROTTEN_TOMATOES renders the logo instead of the text label', () => {
        setPageDataStub({
            data: { branding: { ratingLogoRottenTomatoes: '/custom/rt-logo.svg' } },
            url: new URL('http://localhost/'),
        });
        const { container } = render(ModalBody, { criticRating: 85 });
        const img = container.querySelector('img[alt="RT Critics"]') as HTMLImageElement;
        expect(img).toBeTruthy();
        expect(img.src).toContain('/custom/rt-logo.svg');
    });
});
