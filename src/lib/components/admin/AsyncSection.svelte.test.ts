// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Admin IA redesign, spec §6/§7/§8: AsyncSection wraps the three mandatory
 * states (loading/empty/error) and turns a loading that overruns its
 * timeout into a retryable error — killing the "eternal Loading…" bug class.
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import AsyncSectionFixture from './async-section-fixture.svelte';

describe('AsyncSection', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    it('renders children when not loading/empty/error', () => {
        render(AsyncSectionFixture, { loading: false, error: null, empty: false });
        expect(screen.getByText('the content')).toBeTruthy();
    });

    it('renders the loading state while loading', () => {
        render(AsyncSectionFixture, { loading: true, error: null, empty: false });
        expect(screen.queryByText('the content')).toBeNull();
        expect(screen.getByText('Loading...')).toBeTruthy();
    });

    it('renders a passed-in ClassifiedError with its message and a retry button', async () => {
        const onretry = vi.fn();
        render(AsyncSectionFixture, {
            loading: false,
            error: { class: 'network', message: 'Could not reach the server', retryable: true },
            empty: false,
            onretry,
        });
        expect(screen.getByText('Could not reach the server')).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(onretry).toHaveBeenCalledTimes(1);
    });

    it('does not render a retry button for a non-retryable error', () => {
        render(AsyncSectionFixture, {
            loading: false,
            error: { class: 'auth', message: 'Your session has expired', retryable: false },
            empty: false,
        });
        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });

    it('loading that exceeds the timeout flips to a retryable error (kills eternal Loading…)', async () => {
        render(AsyncSectionFixture, {
            loading: true,
            error: null,
            empty: false,
            timeoutMs: 1000,
            onretry: vi.fn(),
        });
        expect(screen.getByText('Loading...')).toBeTruthy();

        await vi.advanceTimersByTimeAsync(1001);

        expect(screen.queryByText('Loading...')).toBeNull();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    });

    it('loading that resolves before the timeout never shows an error', async () => {
        const { rerender } = render(AsyncSectionFixture, {
            loading: true,
            error: null,
            empty: false,
            timeoutMs: 1000,
        });

        await vi.advanceTimersByTimeAsync(500);
        await rerender({ loading: false, error: null, empty: false, timeoutMs: 1000 });

        expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
        expect(screen.getByText('the content')).toBeTruthy();
    });

    it('renders the empty state when empty and not loading/error', () => {
        render(AsyncSectionFixture, { loading: false, error: null, empty: true });
        expect(screen.queryByText('the content')).toBeNull();
        expect(screen.getByText('Nothing here yet.')).toBeTruthy();
    });
});
