// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/svelte';

// SectionSkeleton imports the `$lib/components/ui` barrel, which transitively
// reads `$env/dynamic/public` — a virtual module with no runtime backing under
// vitest. Mock it (repo-wide pattern) so the module graph evaluates.
vi.mock('$env/dynamic/public', () => ({ env: {} }));

vi.mock('$lib/components/sections', async () => {
    const module = await import('./SectionRendererStub.svelte');
    return { SectionRenderer: module.default };
});

import LazySectionGroup from './LazySectionGroup.svelte';

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

/**
 * LazySectionGroup no longer calls `fetch` directly — it goes through
 * `fetchSectionCached`, whose cache (in-memory Map + sessionStorage) is
 * module-global and keyed by URL. A payload cached by one test is therefore
 * served to every later test using the same URL, which silently turned the
 * error-path tests into assertions about a cached *success*. Give each test its
 * own URL so the cache can never bridge them.
 */
let urlSeq = 0;
const nextUrl = (): string => `/api/music/sections/smart-mixes-${++urlSeq}`;

describe('LazySectionGroup', () => {
    beforeEach(() => {
        MockIntersectionObserver.reset();
        vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    });

    test('renders skeleton before intersection', () => {
        const { container } = render(LazySectionGroup, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        expect(container.querySelectorAll('[data-testid="skeleton-card"]').length).toBeGreaterThan(
            0,
        );
    });

    test('renders all returned sections on resolve', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({
                    sections: [
                        {
                            id: 'music-mix-rock',
                            type: 'carousel',
                            title: 'Rock Mix',
                            items: [],
                            meta: {},
                        },
                        {
                            id: 'music-mix-pop',
                            type: 'carousel',
                            title: 'Pop Mix',
                            items: [],
                            meta: {},
                        },
                    ],
                }),
            }),
        );
        const { container } = render(LazySectionGroup, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        await waitFor(() => {
            const stubs = container.querySelectorAll('[data-testid="section-renderer-stub"]');
            expect(stubs.length).toBe(2);
            const ids = Array.from(stubs).map((s) => s.getAttribute('data-section-id'));
            expect(ids).toContain('music-mix-rock');
            expect(ids).toContain('music-mix-pop');
        });
    });

    test('renders error placeholder on fetch failure', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));
        const { findByText } = render(LazySectionGroup, {
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
        const { findByText } = render(LazySectionGroup, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        const msg = await findByText(/couldn't load/i);
        expect(msg).toBeTruthy();
    });

    test('renders nothing when sections array is empty', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn().mockResolvedValue({
                ok: true,
                json: async () => ({ sections: [] }),
            }),
        );
        const { container } = render(LazySectionGroup, {
            props: {
                url: nextUrl(),
                skeletonVariant: 'track-carousel',
            },
        });
        MockIntersectionObserver.triggerIntersect();
        await waitFor(() => {
            const skeleton = container.querySelector('[data-testid="skeleton-card"]');
            expect(skeleton).toBeFalsy();
            const stubs = container.querySelectorAll('[data-testid="section-renderer-stub"]');
            expect(stubs.length).toBe(0);
        });
    });
});
