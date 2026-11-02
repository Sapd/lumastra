// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * `/browse` mounts up to ~280 cards; each used to call
 * `window.matchMedia('(hover: hover)')` and attach its own 'change' listener
 * (UniversalMediaCard.svelte, pre-fix). That's now a single module-level
 * `MediaQuery` (svelte/reactivity), shared by every card instance. This pins
 * the seam: rendering N cards must call `matchMedia('(hover: hover)')`
 * exactly once and attach exactly one 'change' listener on the returned
 * MediaQueryList, not N of each.
 */

import { render, cleanup } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { tick } from 'svelte';
import type { UniversalMediaItem } from '$lib/schemas/api-responses';
import UniversalMediaCard from './UniversalMediaCard.svelte';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

function makeItem(id: string): UniversalMediaItem {
    return {
        id,
        externalIds: { internal: id },
        mediaType: 'movie',
        title: `Movie ${id}`,
        image: `/api/image/catalog/${id}?size=poster`,
        isAvailable: true,
        canRequest: false,
    };
}

describe('UniversalMediaCard shared hover query', () => {
    let matchMediaSpy: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        matchMediaSpy = vi.fn().mockImplementation((query: string) => ({
            matches: true,
            media: query,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        }));
        vi.stubGlobal('matchMedia', matchMediaSpy);
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    // Both assertions live in one test deliberately: the shared `MediaQuery`
    // is memoized at module scope (see UniversalMediaCard.svelte), so once
    // the first card in this file constructs it, every later render (in this
    // test AND any later test in this file) reuses that same instance and
    // never calls `window.matchMedia` again. Splitting this into two tests
    // would make the second one observe zero calls against ITS OWN
    // `matchMediaSpy` — not a bug in the component, just an artifact of the
    // module-level singleton outliving a single `test()`.
    test('rendering 5 cards calls matchMedia("(hover: hover)") exactly once and attaches one listener', async () => {
        for (let i = 0; i < 5; i++) {
            render(UniversalMediaCard, { props: { item: makeItem(`m${i}`) } });
        }
        await tick();

        const hoverCalls = matchMediaSpy.mock.calls.filter(([query]) => query === '(hover: hover)');
        expect(hoverCalls).toHaveLength(1);

        const mql = matchMediaSpy.mock.results[0]?.value as {
            addEventListener: ReturnType<typeof vi.fn>;
        };
        expect(mql.addEventListener).toHaveBeenCalledTimes(1);
        // Svelte's `on()` helper also passes AddEventListenerOptions as a 3rd
        // arg — only the event name + handler type matter here.
        const [eventName, handler] = mql.addEventListener.mock.calls[0] ?? [];
        expect(eventName).toBe('change');
        expect(typeof handler).toBe('function');
    });
});
