// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The lifecycle of one third-party widget mount, extracted from the component
 * so the cases that matter are reachable from a test — chiefly the one the
 * component could not express: a module that resolves AFTER its slot has
 * already been released.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { mountPluginWidget, type PluginWidgetMountOptions } from './plugin-widget-mount.js';

let el: HTMLElement;
type Mod = { mount?: (el: HTMLElement, ctx: unknown) => unknown };
let settle: ReturnType<typeof vi.fn<(didFail: boolean) => void>>;

beforeEach(() => {
    vi.useFakeTimers();
    el = document.createElement('div');
    settle = vi.fn<(didFail: boolean) => void>();
    vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

const opts = (over: Partial<PluginWidgetMountOptions> = {}): PluginWidgetMountOptions => ({
    el,
    ctx: () => ({}),
    timeoutMs: 15_000,
    label: 'demo:w',
    onSettle: settle,
    load: async () => ({ mount: vi.fn() }),
    ...over,
});

describe('the happy path', () => {
    it('mounts and settles as a success', async () => {
        const mount = vi.fn(() => vi.fn());
        mountPluginWidget(opts({ load: async () => ({ mount }) }));
        await vi.advanceTimersByTimeAsync(0);
        expect(mount).toHaveBeenCalledWith(el, expect.anything());
        expect(settle).toHaveBeenCalledWith(false);
    });

    it('runs the cleanup a plugin returned, on dispose', async () => {
        const cleanup = vi.fn();
        const dispose = mountPluginWidget(opts({ load: async () => ({ mount: () => cleanup }) }));
        await vi.advanceTimersByTimeAsync(0);
        dispose();
        expect(cleanup).toHaveBeenCalled();
    });

    it('accepts a { destroy() } handle as well as a bare function', async () => {
        const destroy = vi.fn();
        const dispose = mountPluginWidget(
            opts({ load: async () => ({ mount: () => ({ destroy }) }) }),
        );
        await vi.advanceTimersByTimeAsync(0);
        dispose();
        expect(destroy).toHaveBeenCalled();
    });
});

describe('the timeout', () => {
    it('releases the slot when the module never settles', async () => {
        mountPluginWidget(opts({ load: () => new Promise(() => {}) }));
        await vi.advanceTimersByTimeAsync(15_000);
        expect(settle).toHaveBeenCalledWith(true);
    });

    it('does NOT mount a module that arrives after the timeout', async () => {
        // Releasing the slot is a decision that this widget does not get to
        // run. Mounting it a second later means it runs invisibly — inside
        // chrome that is already hidden — polling, timing and possibly playing
        // audio, with the viewer given no sign it is there.
        let resolve!: (v: Mod) => void;
        const mount = vi.fn();
        mountPluginWidget(
            opts({
                load: () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            }),
        );
        await vi.advanceTimersByTimeAsync(15_000);
        resolve({ mount });
        await vi.advanceTimersByTimeAsync(0);
        expect(mount).not.toHaveBeenCalled();
    });

    it('does not settle twice when the module arrives late', async () => {
        let resolve!: (v: Mod) => void;
        mountPluginWidget(
            opts({
                load: () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            }),
        );
        await vi.advanceTimersByTimeAsync(15_000);
        resolve({ mount: vi.fn() });
        await vi.advanceTimersByTimeAsync(0);
        expect(settle).toHaveBeenCalledTimes(1);
    });

    it('does not fire once the module has already mounted', async () => {
        mountPluginWidget(opts());
        await vi.advanceTimersByTimeAsync(0);
        settle.mockClear();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(settle).not.toHaveBeenCalled();
    });
});

describe('a misbehaving plugin', () => {
    it('a failed import settles as a failure rather than throwing', async () => {
        mountPluginWidget(
            opts({
                load: async () => {
                    throw new Error('404');
                },
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(settle).toHaveBeenCalledWith(true);
    });

    it('a mount() that throws settles as a failure', async () => {
        mountPluginWidget(
            opts({
                load: async () => ({
                    mount: () => {
                        throw new Error('boom');
                    },
                }),
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(settle).toHaveBeenCalledWith(true);
    });

    it('a cleanup() that throws does not take the host down', async () => {
        const dispose = mountPluginWidget(
            opts({
                load: async () => ({
                    mount: () => () => {
                        throw new Error('boom');
                    },
                }),
            }),
        );
        await vi.advanceTimersByTimeAsync(0);
        expect(() => dispose()).not.toThrow();
    });

    it('a module with no mount() export still settles', async () => {
        mountPluginWidget(opts({ load: async () => ({}) }));
        await vi.advanceTimersByTimeAsync(0);
        expect(settle).toHaveBeenCalledWith(false);
    });
});

describe('dispose', () => {
    it('stops a module that resolves after teardown', async () => {
        let resolve!: (v: Mod) => void;
        const mount = vi.fn();
        const dispose = mountPluginWidget(
            opts({
                load: () =>
                    new Promise((r) => {
                        resolve = r;
                    }),
            }),
        );
        dispose();
        resolve({ mount });
        await vi.advanceTimersByTimeAsync(0);
        expect(mount).not.toHaveBeenCalled();
        expect(settle).not.toHaveBeenCalled();
    });

    it('clears the timeout, so a torn-down slot never settles later', async () => {
        const dispose = mountPluginWidget(opts({ load: () => new Promise(() => {}) }));
        dispose();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(settle).not.toHaveBeenCalled();
    });
});
