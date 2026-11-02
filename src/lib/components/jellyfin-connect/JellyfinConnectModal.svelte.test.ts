// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
vi.mock('$app/environment', () => ({ browser: true, dev: true, building: false, version: 'test' }));
vi.mock('$app/stores', () => ({
    page: writable({ data: { publicBaseUrl: 'https://public.example/media/' } }),
}));
vi.mock('$lib/api/user', () => ({
    getJellyfinPasswordStatus: async () => ({ data: { hasPassword: false } }),
    generateJellyfinPassword: vi.fn(),
    deleteJellyfinPassword: vi.fn(),
    revealJellyfinPassword: vi.fn(),
    getJellyfinClientSessions: async () => ({ data: { items: [] } }),
    getTokens: async () => ({ data: { tokens: [] } }),
    createUserToken: vi.fn(),
    deleteToken: vi.fn(),
}));
vi.mock('$lib/api/client.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/api/client.js')>();
    return {
        ...actual,
        apiGet: vi.fn().mockResolvedValue({ data: { items: [] }, error: null, status: 200 }),
    };
});
import Modal from './JellyfinConnectModal.svelte';
afterEach(cleanup);
it('shows the public URL to copy into Jellyfin clients', () => {
    render(Modal, { username: 'joe', onclose: () => {} });
    expect(screen.getByText('https://public.example/media/j')).toBeTruthy();
});
