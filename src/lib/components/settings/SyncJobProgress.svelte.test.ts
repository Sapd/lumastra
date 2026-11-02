// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import SyncJobProgress from './SyncJobProgress.svelte';
import type { SyncStatus } from '$lib/schemas/api-integrations-responses';

describe('SyncJobProgress', () => {
    afterEach(() => cleanup());

    test('renders nothing when status is null', () => {
        render(SyncJobProgress, { status: null, onCancel: vi.fn() });
        expect(screen.queryByRole('progressbar')).toBeNull();
        expect(screen.queryByRole('button')).toBeNull();
    });

    test('renders nothing when state is null (no run has ever started)', () => {
        const status: SyncStatus = { state: null, processed: 0, recentActivity: [] };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        expect(screen.queryByRole('progressbar')).toBeNull();
    });

    test('renders a determinate progress bar with processed/total when total is known', () => {
        const status: SyncStatus = {
            state: 'active',
            phase: 'Importing',
            total: 100,
            processed: 40,
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('40');
        expect(screen.getByText(/40 \/ 100/)).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    });

    test('renders an indeterminate progress bar when total is unknown', () => {
        const status: SyncStatus = {
            state: 'active',
            phase: 'Importing',
            processed: 7,
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBeNull();
        expect(screen.getByText(/7 processed/)).toBeTruthy();
    });

    test('calls onCancel when the cancel button is clicked', async () => {
        const onCancel = vi.fn();
        const status: SyncStatus = { state: 'pending', processed: 0, recentActivity: [] };
        render(SyncJobProgress, { status, onCancel });
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    test('disables cancel and shows a distinct label while cancelling', () => {
        const status: SyncStatus = { state: 'cancelling', processed: 5, recentActivity: [] };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const button = screen.getByRole('button', { name: 'Cancelling…' });
        expect(button.hasAttribute('disabled')).toBe(true);
    });

    test('renders a persistent completed summary for a terminal state', () => {
        const status: SyncStatus = { state: 'completed', processed: 812, recentActivity: [] };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        expect(screen.getByText(/Done — 812 items transferred/)).toBeTruthy();
        expect(screen.queryByRole('button')).toBeNull();
    });

    // "Completed — 0 processed" read like a failure.
    test('says everything was already in sync when nothing was transferred', () => {
        const status: SyncStatus = { state: 'completed', processed: 0, recentActivity: [] };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        expect(screen.getByText(/everything was already in sync/)).toBeTruthy();
    });

    test('renders the terminal error message for a failed run', () => {
        const status: SyncStatus = {
            state: 'failed',
            processed: 3,
            error: 'Upstream rate limit exceeded',
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        expect(screen.getByText('Upstream rate limit exceeded')).toBeTruthy();
    });

    test('renders a cancelled summary for a cancelled run', () => {
        const status: SyncStatus = { state: 'cancelled', processed: 2, recentActivity: [] };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        expect(screen.getByText('Canceled')).toBeTruthy();
    });

    test('falls back to the indeterminate bar (no NaN aria-valuenow) when total is NaN', () => {
        const status: SyncStatus = {
            state: 'active',
            phase: 'Importing',
            total: NaN,
            processed: 5,
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBeNull();
    });

    test('falls back to the indeterminate bar when processed is negative', () => {
        const status: SyncStatus = {
            state: 'active',
            phase: 'Importing',
            total: 100,
            processed: -3,
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBeNull();
    });

    test('falls back to the indeterminate bar when processed is NaN', () => {
        const status: SyncStatus = {
            state: 'active',
            phase: 'Importing',
            total: 100,
            processed: NaN,
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBeNull();
    });

    test('clamps the displayed percentage to 100 when processed exceeds total', () => {
        const status: SyncStatus = {
            state: 'active',
            phase: 'Importing',
            total: 10,
            processed: 999,
            recentActivity: [],
        };
        render(SyncJobProgress, { status, onCancel: vi.fn() });
        const bar = screen.getByRole('progressbar');
        expect(bar.getAttribute('aria-valuenow')).toBe('100');
    });
});
