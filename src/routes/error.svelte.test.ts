// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
import * as m from '$lib/paraglide/messages.js';

interface MockPage {
    status: number;
    error: { message: string; errorId?: string } | null;
    data?: { branding?: { appName?: string } };
    url: URL;
}

let mockPage: MockPage = {
    status: 404,
    error: { message: 'Not Found' },
    data: {},
    url: new URL('http://localhost/some/path'),
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

import ErrorPage from './+error.svelte';

describe('+error.svelte — 5xx masking vs 4xx verbatim', () => {
    afterEach(() => {
        cleanup();
    });

    test('5xx errors mask the underlying message and show the generic error_page_unknown() text', () => {
        mockPage = {
            status: 503,
            error: { message: 'Database connection unavailable' },
            data: {},
            url: new URL('http://localhost/watch/abc'),
        };
        render(ErrorPage);

        // The specific backend detail must NOT be shown.
        expect(screen.queryByText(/Database connection unavailable/)).toBeNull();
        // The generic fallback message is shown instead.
        expect(screen.getByText(new RegExp(m.error_page_unknown()))).toBeTruthy();
    });

    test('4xx errors show the load-provided message verbatim', () => {
        mockPage = {
            status: 404,
            error: { message: 'Content not available' },
            data: {},
            url: new URL('http://localhost/watch/abc'),
        };
        render(ErrorPage);

        expect(screen.getByText(/Content not available/)).toBeTruthy();
    });
});

describe('+error.svelte — the errorId is the only diagnostic a masked 5xx leaves', () => {
    afterEach(() => {
        cleanup();
    });

    test('renders the errorId from handleError so it can be quoted in a report', () => {
        mockPage = {
            status: 500,
            error: { message: 'Internal Error', errorId: '3f2b1c8e-0000-4aaa-9bbb-1234567890ab' },
            data: {},
            url: new URL('http://localhost/watch/abc'),
        };
        render(ErrorPage);

        expect(screen.getByText('3f2b1c8e-0000-4aaa-9bbb-1234567890ab')).toBeTruthy();
        expect(screen.getByText(new RegExp(m.error_page_reference()))).toBeTruthy();
        expect(screen.getByText(m.error_page_reference_hint())).toBeTruthy();
    });

    test('omits the reference row entirely when no errorId was supplied', () => {
        // A 404 from a plain `error(404)` never reaches handleError, so there is
        // no id — the row must not render as an empty label.
        mockPage = {
            status: 404,
            error: { message: 'Not Found' },
            data: {},
            url: new URL('http://localhost/some/path'),
        };
        render(ErrorPage);

        expect(screen.queryByText(new RegExp(m.error_page_reference()))).toBeNull();
        expect(screen.queryByText(m.error_page_reference_hint())).toBeNull();
    });
});
