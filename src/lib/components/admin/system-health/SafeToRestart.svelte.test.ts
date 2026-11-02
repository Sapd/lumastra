// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import SafeToRestart from './SafeToRestart.svelte';
import type { RestartSafetyResponse } from '$lib/schemas/admin-restart-safety.schema.js';

vi.mock('$lib/api/client', () => ({
    apiGet: vi.fn(),
}));

import { apiGet } from '$lib/api/client';

function resolve(response: RestartSafetyResponse): void {
    vi.mocked(apiGet).mockResolvedValue({ data: response, error: null, status: 200 });
}

function baseResponse(overrides: Partial<RestartSafetyResponse> = {}): RestartSafetyResponse {
    return {
        generatedAt: new Date().toISOString(),
        status: 'safe',
        pendingWrites: 0,
        items: [],
        ...overrides,
    };
}

describe('SafeToRestart', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
    });

    test('shows the safe message when nothing is in progress', async () => {
        resolve(baseResponse());

        render(SafeToRestart);

        await waitFor(() => {
            expect(screen.getByText(/Safe to restart/)).toBeTruthy();
        });
    });

    test('shows the unknown message when the task database is unreachable', async () => {
        resolve(baseResponse({ status: 'unknown' }));

        render(SafeToRestart);

        await waitFor(() => {
            expect(screen.getByText(/Can't tell/)).toBeTruthy();
        });
    });

    test('names the task and an ETA when a resumable job is draining a backlog', async () => {
        resolve(
            baseResponse({
                status: 'wait',
                items: [
                    {
                        taskId: 'artwork-sync',
                        taskName: 'Artwork Sync',
                        resourceClass: 'io',
                        activeCount: 1,
                        elapsedMs: 60_000,
                        resumable: true,
                        backlogRemaining: 12,
                        unitLabel: 'items',
                        etaMs: 4 * 60_000,
                    },
                ],
            }),
        );

        render(SafeToRestart);

        await waitFor(() => {
            expect(screen.getByText(/Wait about/)).toBeTruthy();
        });
        expect(screen.getByText(/Artwork Sync/)).toBeTruthy();
        expect(screen.getByText(/12/)).toBeTruthy();
    });

    test('warns about lost work for a non-resumable job and does not claim it resumes', async () => {
        resolve(
            baseResponse({
                status: 'lossy',
                items: [
                    {
                        taskId: 'preview-generate',
                        taskName: 'Preview Generation',
                        resourceClass: 'analysis',
                        activeCount: 1,
                        elapsedMs: 40 * 60_000,
                        resumable: false,
                        etaMs: null,
                    },
                ],
            }),
        );

        render(SafeToRestart);

        await waitFor(() => {
            expect(screen.getByText(/would lose about/)).toBeTruthy();
        });
        expect(screen.getByText(/Preview Generation/)).toBeTruthy();
        expect(screen.queryByText(/resumes automatically/)).toBeNull();
    });

    test('reassures that other work resumes when a lossy job is not the only one in progress', async () => {
        resolve(
            baseResponse({
                status: 'lossy',
                items: [
                    {
                        taskId: 'preview-generate',
                        taskName: 'Preview Generation',
                        resourceClass: 'analysis',
                        activeCount: 1,
                        elapsedMs: 40 * 60_000,
                        resumable: false,
                        etaMs: null,
                    },
                    {
                        taskId: 'artwork-sync',
                        taskName: 'Artwork Sync',
                        resourceClass: 'io',
                        activeCount: 1,
                        elapsedMs: 60_000,
                        resumable: true,
                        backlogRemaining: 3,
                        unitLabel: 'items',
                        etaMs: 60_000,
                    },
                ],
            }),
        );

        render(SafeToRestart);

        await waitFor(() => {
            expect(screen.getByText(/resumes automatically/)).toBeTruthy();
        });
    });
});
