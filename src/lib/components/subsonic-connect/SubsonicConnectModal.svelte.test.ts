// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, expect, it, vi } from 'vitest';
import { writable } from 'svelte/store';
vi.mock('$app/environment', () => ({ browser: true }));
vi.mock('$app/stores', () => ({
    page: writable({ data: { publicBaseUrl: 'https://public.example/media/' } }),
}));
vi.mock('$lib/api/user', () => ({
    getSubsonicTokenStatus: async () => ({ data: { hasToken: false } }),
    generateSubsonicToken: vi.fn(),
    deleteSubsonicToken: vi.fn(),
    revealSubsonicToken: vi.fn(),
}));
import Modal from './SubsonicConnectModal.svelte';
afterEach(cleanup);
it('advertises the public URL including the install path', () => {
    render(Modal, { open: true, onclose: () => {} });
    expect(screen.getAllByText('https://public.example/media/subsonic').length).toBeGreaterThan(0);
});
