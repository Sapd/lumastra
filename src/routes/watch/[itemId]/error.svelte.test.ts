// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';

interface MockPage {
    status: number;
    error: { message: string; errorId?: string } | null;
    data?: { branding?: { appName?: string } };
    params: { itemId?: string };
}

let mockPage: MockPage = {
    status: 404,
    error: { message: 'Item not found' },
    data: {},
    params: { itemId: 'abcd1234-ef56-7890-abcd-ef1234567890' },
};

vi.mock('$app/stores', () => ({
    page: {
        subscribe: (run: (v: MockPage) => void) => {
            return readable(mockPage).subscribe(run);
        },
    },
}));

vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
}));

vi.mock('$lib/paths', () => ({
    resolve: (p: string) => p,
}));

import WatchErrorPage from './+error.svelte';

describe('watch/[itemId]/+error.svelte — static error boundary', () => {
    afterEach(() => {
        cleanup();
        mockPage = {
            status: 404,
            error: { message: 'Item not found' },
            data: {},
            params: { itemId: 'abcd1234-ef56-7890-abcd-ef1234567890' },
        };
    });

    test('renders the error page for a generic not-found status', () => {
        render(WatchErrorPage);
        expect(screen.getByRole('button', { name: /Browse/i })).toBeTruthy();
    });

    test('shows a server-provided specific reason instead of the generic subtitle', () => {
        mockPage = {
            status: 403,
            error: { message: 'not in your library — nothing to play' },
            data: {},
            params: { itemId: 'abcd1234-ef56-7890-abcd-ef1234567890' },
        };
        render(WatchErrorPage);
        expect(screen.getByText('not in your library — nothing to play')).toBeTruthy();
    });

    test('falls back to the themed subtitle for SvelteKit generic error messages', () => {
        mockPage = {
            status: 404,
            error: { message: 'Not Found' },
            data: {},
            params: { itemId: 'abcd1234-ef56-7890-abcd-ef1234567890' },
        };
        render(WatchErrorPage);
        // The generic "Not Found" string itself must not appear as the subtitle.
        expect(screen.queryByText('Not Found')).toBeNull();
    });

    // This page suppresses generic messages by design (the test above), so on
    // exactly those failures the errorId is the only diagnostic left on screen.
    test('renders the errorId when handleError supplied one', () => {
        mockPage = {
            status: 500,
            error: { message: 'Internal Error', errorId: '7c1d5a90-1111-4bbb-8ccc-0987654321fe' },
            data: {},
            params: { itemId: 'abcd1234-ef56-7890-abcd-ef1234567890' },
        };
        render(WatchErrorPage);
        expect(screen.getByText('7c1d5a90-1111-4bbb-8ccc-0987654321fe')).toBeTruthy();
    });

    test('omits the reference row when no errorId is present', () => {
        mockPage = {
            status: 404,
            error: { message: 'Item not found' },
            data: {},
            params: { itemId: 'abcd1234-ef56-7890-abcd-ef1234567890' },
        };
        render(WatchErrorPage);
        expect(screen.queryByText(/^[0-9a-f-]{36}$/)).toBeNull();
    });
});
