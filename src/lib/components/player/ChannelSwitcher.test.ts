// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import ChannelSwitcher from './ChannelSwitcher.svelte';

const { getChannels, getPrograms, setFavorite } = vi.hoisted(() => ({
    getChannels: vi.fn(),
    getPrograms: vi.fn(),
    setFavorite: vi.fn(),
}));
vi.mock('$lib/api/playback', () => ({ getLiveTvChannels: getChannels }));
vi.mock('$lib/api/livetv-playback', () => ({ getChannelPrograms: getPrograms }));
vi.mock('$lib/api/livetv-favorites', () => ({
    getLiveTvFavorites: vi.fn(async () => ({ data: { stationIds: [] } })),
    setLiveTvFavorite: setFavorite,
}));

function lineup(): object[] {
    return Array.from({ length: 5000 }, (_, index) => ({
        id: `station-${index}`,
        name: `Station ${index}`,
        channelNumber: index + 1,
        nowNext: {
            current: {
                id: `program-${index}`,
                title: `Show ${index}`,
                startTime: new Date(Date.now() - 60_000).toISOString(),
                endTime: new Date(Date.now() + 3600_000).toISOString(),
            },
            next: null,
        },
    }));
}

beforeEach(() => {
    vi.clearAllMocks();
    getChannels.mockResolvedValue({ data: { items: lineup() } });
    setFavorite.mockResolvedValue({ error: null });
    getPrograms.mockResolvedValue({ data: { airings: [] } });
});
afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
});

describe('channel sidebar window', () => {
    it('mounts bounded rows, reveals current, searches names/numbers/programs and reuses the lineup', async () => {
        const onselectchannel = vi.fn();
        const view = render(ChannelSwitcher, {
            isOpen: true,
            currentChannelId: 'station-4500',
            onselectchannel,
        });
        await waitFor(() =>
            expect(view.container.querySelector('[data-channel-id="station-4500"]')).toBeTruthy(),
        );
        expect(view.container.querySelectorAll('[data-channel-id]').length).toBeLessThan(40);
        const input = view.getByPlaceholderText('Search channels...');
        for (const search of ['Station 4999', '5000', 'Show 4999']) {
            await fireEvent.input(input, { target: { value: ` ${search} ` } });
            await waitFor(() =>
                expect(
                    view.container.querySelector('[data-channel-id="station-4999"]'),
                ).toBeTruthy(),
            );
            expect(view.container.querySelectorAll('[data-channel-id]').length).toBe(1);
        }
        const row = view.container.querySelector('[data-channel-id="station-4999"]')!;
        await fireEvent.click(row.querySelectorAll('button')[1]);
        expect(onselectchannel).toHaveBeenCalledWith({ channelId: 'station-4999' });
        await view.rerender({ isOpen: false, currentChannelId: 'station-4500', onselectchannel });
        await view.rerender({ isOpen: true, currentChannelId: 'station-4500', onselectchannel });
        await waitFor(() =>
            expect(view.container.querySelector('[data-channel-id="station-4500"]')).toBeTruthy(),
        );
        expect(getChannels).toHaveBeenCalledTimes(1);
    });

    it('keeps later rows reachable when scrolling and tabbing across the mounted window', async () => {
        const view = render(ChannelSwitcher, { isOpen: true });
        await waitFor(() => expect(view.container.querySelector('[data-channel-id]')).toBeTruthy());
        const list = view.container.querySelector('.channel-list') as HTMLDivElement;
        list.scrollTop = 300_000;
        await fireEvent.scroll(list);
        expect(view.container.querySelector('[data-channel-id="station-3000"]')).toBeTruthy();
        expect(view.container.querySelectorAll('[data-channel-id]').length).toBeLessThan(40);
        const rows = view.container.querySelectorAll('[data-channel-id]');
        const last = rows[rows.length - 1];
        const buttons = last.querySelectorAll('button');
        buttons[buttons.length - 1].focus();
        const nextId = `station-${Number((last as HTMLElement).dataset.channelId?.split('-')[1]) + 1}`;
        await fireEvent.keyDown(buttons[buttons.length - 1], { key: 'Tab' });
        await waitFor(() =>
            expect(
                (document.activeElement?.closest('[data-channel-id]') as HTMLElement)?.dataset
                    .channelId,
            ).toBe(nextId),
        );
    });

    it('retries an initial failure', async () => {
        getChannels.mockResolvedValueOnce({ error: 'unavailable' });
        const view = render(ChannelSwitcher, { isOpen: true });
        await fireEvent.click(await view.findByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(view.container.querySelector('[data-channel-id]')).toBeTruthy());
        expect(getChannels).toHaveBeenCalledTimes(2);
    });

    it('preserves favorites and ignores a superseded schedule response', async () => {
        let resolveFirst!: (value: unknown) => void;
        let resolveSecond!: (value: unknown) => void;
        getPrograms.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveFirst = resolve;
            }),
        );
        getPrograms.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveSecond = resolve;
            }),
        );
        const view = render(ChannelSwitcher, { isOpen: true });
        await waitFor(() => expect(view.container.querySelector('[data-channel-id]')).toBeTruthy());
        const first = view.container.querySelector('[data-channel-id="station-0"]')!;
        await fireEvent.click(first.querySelectorAll('button')[0]);
        expect(setFavorite).toHaveBeenCalledWith('station-0', true);
        await fireEvent.click(first.querySelectorAll('button')[2]);
        const second = view.container.querySelector('[data-channel-id="station-1"]')!;
        await fireEvent.click(second.querySelectorAll('button')[2]);
        const airing = {
            id: 'second-program',
            title: 'Second schedule',
            startTime: new Date(Date.now() - 60_000).toISOString(),
            endTime: new Date(Date.now() + 3600_000).toISOString(),
        };
        resolveSecond({ data: { airings: [airing] } });
        await view.findByText('Second schedule');
        resolveFirst({
            data: { airings: [{ ...airing, id: 'old-program', title: 'Stale schedule' }] },
        });
        await waitFor(() => expect(view.queryByText('Stale schedule')).toBeNull());
        expect(view.getByText('Second schedule')).toBeTruthy();
    });
});

it('keeps the viewport anchored when measured rows above it change height', async () => {
    const callbacks = new Map<Element, () => void>();
    const original = globalThis.ResizeObserver;
    class ControlledObserver {
        node?: Element;
        constructor(private callback: (...args: unknown[]) => void) {}
        observe(node: Element) {
            this.node = node;
            callbacks.set(node, () => this.callback([], this as unknown as ResizeObserver));
        }
        unobserve() {}
        disconnect() {
            if (this.node) callbacks.delete(this.node);
        }
    }
    globalThis.ResizeObserver = ControlledObserver as unknown as typeof ResizeObserver;
    try {
        const heights: Record<string, number> = {};
        vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
            this: HTMLElement,
        ) {
            return {
                height: this.dataset.channelId ? (heights[this.dataset.channelId] ?? 100) : 0,
            } as DOMRect;
        });
        const view = render(ChannelSwitcher, { isOpen: true });
        await waitFor(() => expect(view.container.querySelector('[data-channel-id]')).toBeTruthy());
        const list = view.container.querySelector('.channel-list') as HTMLDivElement;
        list.scrollTop = 10000;
        await fireEvent.scroll(list);
        const above = view.container.querySelector('[data-channel-id="station-98"]')!;
        heights['station-98'] = 300;
        callbacks.get(above)!();
        await tick();
        expect(list.scrollTop).toBe(10200);
        expect(view.container.querySelector('[data-channel-id="station-100"]')).toBeTruthy();
        heights['station-98'] = 100;
        callbacks.get(above)!();
        await tick();
        expect(list.scrollTop).toBe(10000);
    } finally {
        cleanup();
        globalThis.ResizeObserver = original;
    }
});

it('refreshes an expired lineup without replacing cached channels with a spinner', async () => {
    const date = vi.spyOn(Date, 'now');
    const initial = Date.now();
    date.mockReturnValue(initial);
    const view = render(ChannelSwitcher, { isOpen: true });
    await waitFor(() => expect(view.container.querySelector('[data-channel-id]')).toBeTruthy());
    await view.rerender({ isOpen: false });
    date.mockReturnValue(initial + 61000);
    let finish: (value: unknown) => void = () => {};
    getChannels.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    await view.rerender({ isOpen: true });
    expect(getChannels).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector('[data-channel-id]')).toBeTruthy();
    finish({ error: 'offline' });
    await tick();
    expect(view.container.querySelector('[data-channel-id]')).toBeTruthy();
    expect(view.queryByText('Failed to load channels')).toBeNull();
});
