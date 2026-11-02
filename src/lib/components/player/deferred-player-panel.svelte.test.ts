// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import { DeferredPlayerPanel } from './deferred-player-panel.svelte';

it('does not load closed panels', () => {
    const loader = vi.fn(async () => () => undefined);
    const panel = new DeferredPlayerPanel(loader);
    expect(loader).not.toHaveBeenCalled();
    expect(panel.component).toBeNull();
});

it('shares in-flight work and retains the constructor for later opens', async () => {
    const component = () => undefined;
    let finish!: (value: typeof component) => void;
    const loader = vi.fn(
        () =>
            new Promise<typeof component>((resolve) => {
                finish = resolve;
            }),
    );
    const panel = new DeferredPlayerPanel(loader);
    const first = panel.load();
    const second = panel.load();
    expect(second).toBe(first);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    finish(component);
    await first;
    expect(panel.component).toBe(component);
    await panel.load();
    expect(loader).toHaveBeenCalledTimes(1);
});

it('allows retry after a failed chunk request', async () => {
    const component = () => undefined;
    const loader = vi
        .fn<() => Promise<typeof component>>()
        .mockRejectedValueOnce(new Error('unavailable'))
        .mockResolvedValueOnce(component);
    const panel = new DeferredPlayerPanel(loader);
    await expect(panel.load()).rejects.toThrow('unavailable');
    expect(panel.component).toBeNull();
    await panel.load();
    expect(panel.component).toBe(component);
    expect(loader).toHaveBeenCalledTimes(2);
});

it('keeps independently requested panels separate', async () => {
    const first = () => undefined;
    const second = () => undefined;
    const a = new DeferredPlayerPanel(async () => first);
    const b = new DeferredPlayerPanel(async () => second);
    await a.load();
    expect(a.component).toBe(first);
    expect(b.component).toBeNull();
    await b.load();
    expect(b.component).toBe(second);
});
