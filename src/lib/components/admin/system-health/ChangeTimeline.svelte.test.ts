// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import ChangeTimeline from './ChangeTimeline.svelte';
import type { ChangeTimelineResponse } from '$lib/schemas/admin-change-timeline.schema.js';
import type { FailurePatternsResponse } from '$lib/schemas/task-system-failure-detection.schema.js';

vi.mock('$lib/api/client', () => ({
    apiGet: vi.fn(),
}));

import { apiGet } from '$lib/api/client';

function baseChanges(overrides: Partial<ChangeTimelineResponse> = {}): ChangeTimelineResponse {
    return {
        generatedAt: new Date().toISOString(),
        window: { sinceHours: 168 },
        events: [],
        versionTrackingAvailable: false,
        ...overrides,
    };
}

function basePatterns(overrides: Partial<FailurePatternsResponse> = {}): FailurePatternsResponse {
    return {
        patterns: [],
        window: { sinceHours: 24 },
        ...overrides,
    };
}

function mockRoutes(changes: ChangeTimelineResponse, patterns: FailurePatternsResponse): void {
    vi.mocked(apiGet).mockImplementation(async (url: string) => {
        if (url.includes('/change-timeline')) {
            return { data: changes, error: null, status: 200 };
        }
        if (url.includes('/failures/patterns')) {
            return { data: patterns, error: null, status: 200 };
        }
        return { data: null, error: 'unexpected url', status: 500 };
    });
}

describe('ChangeTimeline', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
    });

    test('shows the empty state and the version-tracking gap note when nothing changed', async () => {
        mockRoutes(baseChanges(), basePatterns());

        render(ChangeTimeline);

        await waitFor(() => {
            expect(screen.getByText(/No config, task or license changes/)).toBeTruthy();
        });
        expect(screen.getByText(/version changes aren't tracked yet/i)).toBeTruthy();
    });

    test('falls back to a no-failures heading when there are no recent failure patterns', async () => {
        mockRoutes(
            baseChanges({
                events: [
                    {
                        id: 1,
                        ts: new Date().toISOString(),
                        actor: 'admin',
                        action: 'task.pause',
                        target: 'intro-detection',
                        kind: 'task-pause',
                        taskName: 'Intro Detection',
                    },
                ],
            }),
            basePatterns(),
        );

        render(ChangeTimeline);

        await waitFor(() => {
            expect(screen.getByText(/No recent failures detected/)).toBeTruthy();
        });
        expect(screen.getByText('Intro Detection')).toBeTruthy();
    });

    test('anchors on the earliest failure and labels a settings change with its friendly keys', async () => {
        const firstSeen = '2026-08-24T19:12:00.000Z';
        mockRoutes(
            baseChanges({
                events: [
                    {
                        id: 2,
                        ts: '2026-08-24T19:07:00.000Z',
                        actor: 'admin',
                        action: 'settings.save',
                        target: 'config',
                        kind: 'settings',
                        changedLabels: ['TMDB API Key'],
                        changedLabelsTruncated: false,
                    },
                ],
            }),
            basePatterns({
                patterns: [
                    {
                        fingerprint: 'fp-1',
                        normalizedMessage: 'x',
                        sampleMessage: 'x',
                        count: 3,
                        firstSeen,
                        lastSeen: firstSeen,
                        affectedTasks: ['metadata-sync'],
                        affectedTasksOverflow: 0,
                        source: 'run',
                    },
                ],
            }),
        );

        render(ChangeTimeline);

        await waitFor(() => {
            expect(screen.getByText('TMDB API Key')).toBeTruthy();
        });
        expect(screen.getByText(/before the first failure/)).toBeTruthy();
    });

    test('shows a load-failure message when the change-timeline request fails', async () => {
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.includes('/change-timeline')) {
                return { data: null, error: 'boom', status: 500 };
            }
            return { data: basePatterns(), error: null, status: 200 };
        });

        render(ChangeTimeline);

        await waitFor(() => {
            expect(screen.getByText('boom')).toBeTruthy();
        });
    });

    test('a failed failure lookup is not reported as "no recent failures"', async () => {
        vi.mocked(apiGet).mockImplementation(async (url: string) => {
            if (url.includes('/change-timeline')) {
                return { data: baseChanges(), error: null, status: 200 };
            }
            return { data: null, error: 'forbidden', status: 403 };
        });

        render(ChangeTimeline);

        await waitFor(() => {
            expect(screen.getByText(/Could not check for recent failures/)).toBeTruthy();
        });
        expect(screen.queryByText(/No recent failures detected/)).toBeNull();
    });
});
