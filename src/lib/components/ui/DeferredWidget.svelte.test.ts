// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import Fixture from './deferred-widget-fixture.svelte';

let reveal: () => void;
beforeEach(() => {
    vi.stubGlobal(
        'IntersectionObserver',
        class {
            constructor(callback: ConstructorParameters<typeof IntersectionObserver>[0]) {
                reveal = () =>
                    callback(
                        [{ isIntersecting: true } as IntersectionObserverEntry],
                        this as unknown as IntersectionObserver,
                    );
            }
            observe(): void {}
            disconnect(): void {}
        },
    );
});
afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

it('requests no module offscreen, reserves space during import, and mounts it once', async () => {
    let resolve!: (value: { text: string }) => void;
    const load = vi.fn(
        () =>
            new Promise<{ text: string }>((ready) => {
                resolve = ready;
            }),
    );
    const onclose = vi.fn();
    const { container } = render(Fixture, { load, onclose });
    await tick();
    expect(load).not.toHaveBeenCalled();
    reveal();
    await waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    expect((container.querySelector('[aria-busy="true"]') as HTMLElement).style.minHeight).toBe(
        '520px',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(onclose).toHaveBeenCalledOnce();
    resolve({ text: 'Loaded widget content' });
    await screen.findByText('Loaded widget content');
    reveal();
    await tick();
    expect(load).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[aria-busy]')).toBeNull();
});

it('bounds failed imports and reloads to recover cached module failures', async () => {
    const reload = vi.spyOn(window.location, 'reload').mockImplementation(() => {});
    vi.useFakeTimers();
    const load = vi
        .fn<() => Promise<{ text: string }>>()
        .mockRejectedValue(new Error('temporary failure'));
    render(Fixture, { load });
    reveal();
    await tick();
    await vi.advanceTimersByTimeAsync(3000);
    expect(load).toHaveBeenCalledTimes(3);
    const retry = screen.getByRole('button', { name: 'Retry' });
    await fireEvent.click(retry);
    expect(reload).toHaveBeenCalledOnce();
    expect(load).toHaveBeenCalledTimes(3);
    reload.mockRestore();
});

it('does not start another import after its host unmounts', async () => {
    vi.useFakeTimers();
    let reject!: (reason: Error) => void;
    const load = vi.fn(
        () =>
            new Promise<{ text: string }>((_ready, fail) => {
                reject = fail;
            }),
    );
    const view = render(Fixture, { load });
    reveal();
    await tick();
    view.unmount();
    reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(4000);
    expect(load).toHaveBeenCalledTimes(1);
});
