// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LiveTvStation } from '$lib/schemas/livetv.js';
import SearchChannelResults from './SearchChannelResults.svelte';

type ObserverCallback = ConstructorParameters<typeof IntersectionObserver>[0];

const stations = (count: number): LiveTvStation[] =>
    Array.from({ length: count }, (_, index) => ({
        id: `aurora-${index}`,
        feedId: `aurora-${index}`,
        name: `Aurora ${index}`,
        images: {},
        sourceId: 'fixture',
        isVisible: true,
        sortOrder: index,
        nowNext: { current: null, next: null },
    }));

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('large channel search results', () => {
    it('bounds initial cards, preserves every result and click, and resets on new results', async () => {
        const observers: {
            callback: ObserverCallback;
            observer: IntersectionObserver;
        }[] = [];
        const disconnect = vi.fn();
        vi.stubGlobal(
            'IntersectionObserver',
            class {
                constructor(callback: ObserverCallback) {
                    observers.push({ callback, observer: this as unknown as IntersectionObserver });
                }
                observe = vi.fn();
                disconnect = disconnect;
            },
        );
        const channels = stations(1679);
        const onclick = vi.fn();
        const view = render(SearchChannelResults, { channels, now: Date.now(), onclick });
        await tick();
        expect(screen.getAllByRole('button')).toHaveLength(24);
        expect(screen.queryByRole('button', { name: 'Aurora 24' })).toBeNull();

        for (const { callback, observer } of observers) {
            callback([{ isIntersecting: true } as IntersectionObserverEntry], observer);
        }
        await tick();
        expect(
            screen.getAllByRole('button').map((button) => button.getAttribute('aria-label')),
        ).toEqual(channels.map((station) => station.name));
        await fireEvent.click(screen.getByRole('button', { name: 'Aurora 1678' }));
        expect(onclick).toHaveBeenCalledWith(channels[1678]);

        await view.rerender({ channels: channels.slice(100, 150) });
        await tick();
        expect(screen.getAllByRole('button')).toHaveLength(24);
        expect(screen.getAllByRole('button')[0].getAttribute('aria-label')).toBe('Aurora 100');
        expect(disconnect).toHaveBeenCalled();
    });

    it('keeps all results available without IntersectionObserver', async () => {
        vi.stubGlobal('IntersectionObserver', undefined);
        render(SearchChannelResults, { channels: stations(49), now: Date.now(), onclick: vi.fn() });
        await tick();
        expect(screen.getAllByRole('button')).toHaveLength(49);
    });
});
