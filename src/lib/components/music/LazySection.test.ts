// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';
import LazySection from './LazySection.svelte';

// SectionSkeleton imports the `$lib/components/ui` barrel, which transitively
// pulls in a component that reads `$env/dynamic/public`. That virtual module
// has no runtime backing under vitest and throws at load. Mock it (matching the
// repo-wide pattern) so the module graph evaluates.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

// Mock SectionRenderer to avoid pulling in the deep SvelteKit env dependency
// tree. The tests only care that LazySection calls fetch and swaps states.
vi.mock('$lib/components/sections', async () => {
    const { default: SectionRenderer } = await import('./SectionRendererStub.svelte');
    return { SectionRenderer };
});

type IOCallback = (entries: IntersectionObserverEntry[]) => void;

class MockIntersectionObserver {
    static callbacks: IOCallback[] = [];
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    takeRecords = vi.fn();
    root = null;
    rootMargin = '';
    thresholds: ReadonlyArray<number> = [];

    constructor(cb: IOCallback) {
        MockIntersectionObserver.callbacks.push(cb);
    }

    static triggerIntersect(): void {
        for (const cb of MockIntersectionObserver.callbacks) {
            cb([{ isIntersecting: true } as IntersectionObserverEntry]);
        }
    }

    static reset(): void {
        MockIntersectionObserver.callbacks = [];
    }
}

const fakeSection = {
    id: 'test-section',
    type: 'carousel',
    title: 'Test',
    items: [],
    meta: {},
};

/**
 * LazySection no longer calls `fetch` directly — it goes through
 * `fetchSectionCached`, whose cache (in-memory Map + sessionStorage) is
 * module-global and keyed by URL. A payload cached by one test is therefore
 * served to every later test using the same URL, which silently turned the
 * error-path tests into assertions about a cached *success*. Give each test its
 * own URL so the cache can never bridge them.
 */
let urlSeq = 0;
const nextUrl = (): string => `/api/music/sections/genre/rock-${++urlSeq}`;

describe('LazySection', () => {
    beforeEach(() => {
        MockIntersectionObserver.reset();
        vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    });

    test('renders skeleton before intersection', () => {
        const { container } = render(LazySection, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        const skeleton = container.querySelector('[data-testid="skeleton-card"]');
        expect(skeleton).toBeTruthy();
    });

    test('fetches url on intersection and renders resolved section', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => fakeSection,
            }),
        );
        const url = nextUrl();
        render(LazySection, {
            props: {
                url,
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        await waitFor(() => {
            expect(vi.mocked(fetch)).toHaveBeenCalledWith(
                url,
                expect.objectContaining({
                    signal: expect.any(AbortSignal),
                }),
            );
        });
    });

    test('does not fetch twice on repeated intersection events', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => fakeSection,
            }),
        );
        render(LazySection, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        MockIntersectionObserver.triggerIntersect();
        MockIntersectionObserver.triggerIntersect();
        await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1));
    });

    test('renders error placeholder on fetch failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: false,
                status: 500,
                json: async () => ({}),
            }),
        );
        const { findByText } = render(LazySection, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        const msg = await findByText(/couldn't load/i);
        expect(msg).toBeTruthy();
    });

    test('shows error placeholder when fetch is aborted (timeout)', async () => {
        // Simulate the AbortController-triggered DOMException that fetch
        // throws when the 15s timeout fires on a hung request.
        vi.stubGlobal(
            'fetch',
            vi.fn().mockRejectedValue(new DOMException('aborted', 'AbortError')),
        );
        const { findByText } = render(LazySection, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        const msg = await findByText(/couldn't load/i);
        expect(msg).toBeTruthy();
    });

    test('renders nothing when endpoint returns null', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => null,
            }),
        );
        const { container } = render(LazySection, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        await waitFor(() => {
            const skeleton = container.querySelector('[data-testid="skeleton-card"]');
            expect(skeleton).toBeFalsy();
        });
    });
});
