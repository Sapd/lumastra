// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The admin shell mounts its own ToastContainer, which also carries the download queue card:
 * it must sit bottom-left there (the right side belongs to the slide-in DetailPanel).
 */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin'), data: {}, route: { id: '/admin' } }),
    navigating: readable(null),
}));
vi.mock('$app/paths', async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    base: '',
    resolve: (p: string) => p,
}));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    afterNavigate: vi.fn(),
    beforeNavigate: vi.fn(),
    invalidate: vi.fn(),
    invalidateAll: vi.fn(),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/stores/admin-status.store.svelte.js', () => ({
    adminStatus: {
        payload: null,
        loading: false,
        start: vi.fn(),
        stop: vi.fn(),
        refresh: vi.fn(),
        ack: vi.fn(),
    },
}));

const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
const err = vi.spyOn(console, 'error').mockImplementation(() => {});

import AdminLayout from './+layout.svelte';
import { downloadQueue } from '$lib/downloads/download-queue.svelte';

afterEach(() => {
    cleanup();
    downloadQueue.state = 'idle';
    downloadQueue.reset();
});

test('the download queue card of the admin shell sits bottom-left', async () => {
    downloadQueue.state = 'running';
    render(AdminLayout, {
        data: {
            isAdmin: true,
            user: { username: 'root', userGroups: [] },
            features: {},
        } as never,
    });
    const card = await screen.findByTestId('download-queue-panel');
    const stack = card.closest('.fixed') as HTMLElement;
    expect(stack.className).toContain('left-4');
    expect(stack.className).not.toContain('right-4');
});

test('mounting and unmounting the admin shell raises no state-proxy equality warning', () => {
    const { unmount } = render(AdminLayout, {
        data: { isAdmin: true, user: { username: 'root', userGroups: [] }, features: {} } as never,
    });
    unmount();
    const seen = [...warn.mock.calls, ...err.mock.calls].flat().join(' ');
    expect(seen).not.toContain('state_proxy_equality_mismatch');
});
