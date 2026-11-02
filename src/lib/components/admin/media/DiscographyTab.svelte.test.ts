// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/** A failed load is not an empty discography. */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const getAdminAlbums = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ getAdminAlbums }));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { error: vi.fn(), success: vi.fn() } }));

import DiscographyTab from './DiscographyTab.svelte';

afterEach(() => {
    cleanup();
    vi.clearAllMocks();
});

describe('DiscographyTab', () => {
    it('shows a thrown load as an error with retry, not as "No albums found."', async () => {
        getAdminAlbums.mockRejectedValue(new Error('network down'));
        render(DiscographyTab, { props: { artistId: 'artist-1' } });

        expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
        expect(screen.queryByText('No albums found.')).toBeNull();
    });
});
