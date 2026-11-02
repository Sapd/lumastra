// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach } from 'vitest';
import HealthInvariantsPanel from './HealthInvariantsPanel.svelte';
import type {
    HealthInvariantsResponse,
    InvariantDetailLink,
} from '$lib/schemas/health-invariants.schema.js';

vi.mock('$lib/api/client', () => ({
    apiGet: vi.fn(),
}));

import { apiGet } from '$lib/api/client';

function makeResponse(overrides: Partial<HealthInvariantsResponse> = {}): HealthInvariantsResponse {
    const last = new Date(Date.now() - 5 * 60_000).toISOString();
    return {
        findings: [],
        lastFullRunAt: last,
        lastSuccessfulRunAt: last,
        erroredCount: 0,
        ...overrides,
    };
}

function makeFinding(
    id: string,
    status: 'green' | 'amber' | 'red' | 'unknown',
    label: string,
    remediation: string | null = null,
    details?: InvariantDetailLink[],
) {
    return {
        id,
        label,
        status,
        value: 3,
        description: `Checks ${label} invariant.`,
        remediation,
        thresholdAmber: 1,
        thresholdRed: 10,
        lastRunAt: new Date(Date.now() - 2 * 60_000).toISOString(),
        lastChangeAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        error: null,
        details,
    };
}

function resolve(response: HealthInvariantsResponse): void {
    vi.mocked(apiGet).mockResolvedValue({
        data: response,
        error: null,
        status: 200,
    });
}

describe('HealthInvariantsPanel', () => {
    beforeEach(() => {
        vi.mocked(apiGet).mockReset();
    });

    test('renders red findings before amber and green', async () => {
        resolve(
            makeResponse({
                findings: [
                    makeFinding('inv-green', 'green', 'Green Check'),
                    makeFinding('inv-amber', 'amber', 'Amber Check', 'Fix amber'),
                    makeFinding('inv-red', 'red', 'Red Check', 'Fix red'),
                ],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText('Red Check')).toBeTruthy();
        });

        const labels = screen.getAllByText(/Check$/).map((el) => el.textContent?.trim());

        expect(labels[0]).toBe('Red Check');
        expect(labels[1]).toBe('Amber Check');
        expect(labels[2]).toBe('Green Check');
    });

    test('shows remediation only for amber and red findings', async () => {
        resolve(
            makeResponse({
                findings: [
                    makeFinding('inv-green', 'green', 'All Good', null),
                    makeFinding('inv-amber', 'amber', 'Amber Thing', 'Resolve amber issue'),
                    makeFinding('inv-red', 'red', 'Red Thing', 'Resolve red issue'),
                ],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText('Resolve red issue')).toBeTruthy();
        });

        expect(screen.getByText('Resolve amber issue')).toBeTruthy();
        expect(screen.queryByText(/All Good remediation/)).toBeNull();
    });

    test('renders an /admin path in remediation as a clickable link', async () => {
        resolve(
            makeResponse({
                findings: [
                    makeFinding(
                        'inv-red',
                        'red',
                        'Linky Check',
                        'Open Tasks (/admin/tasks) to investigate.',
                    ),
                ],
            }),
        );

        render(HealthInvariantsPanel);

        const link = await waitFor(() => screen.getByRole('link', { name: '/admin/tasks' }));
        expect(link.getAttribute('href')).toBe('/admin/tasks');
    });

    test('shows "Last clean check N minutes ago" when every finding ran cleanly', async () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
        resolve(
            makeResponse({
                lastFullRunAt: fiveMinutesAgo,
                lastSuccessfulRunAt: fiveMinutesAgo,
                erroredCount: 0,
                findings: [makeFinding('inv-red', 'red', 'Some Check', 'Fix it')],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText(/Last clean check \d+ minutes ago/)).toBeTruthy();
        });
    });

    test('shows "Last attempt" label + errored badge when any invariant query failed', async () => {
        const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
        resolve(
            makeResponse({
                lastFullRunAt: fiveMinutesAgo,
                lastSuccessfulRunAt: null,
                erroredCount: 2,
                findings: [makeFinding('inv-red', 'red', 'Some Check', 'Fix it')],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText(/Last attempt \d+ minutes ago/)).toBeTruthy();
        });
        expect(screen.getByText(/2 couldn't run/)).toBeTruthy();
    });

    test('shows empty-state guidance when no findings have been recorded yet', async () => {
        resolve(makeResponse({ findings: [] }));

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText(/No results yet/)).toBeTruthy();
        });
        // The empty-state mention should point the operator at where the check
        // is scheduled if the empty state persists.
        expect(screen.getByText(/Operations -> Jobs/)).toBeTruthy();
    });

    test('shows error banner when fetch returns non-2xx', async () => {
        vi.mocked(apiGet).mockResolvedValue({
            data: null,
            error: 'Service unavailable',
            status: 503,
        });

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText('Service unavailable')).toBeTruthy();
        });

        const alert = screen.getByRole('alert');
        expect(alert).toBeTruthy();
    });

    test('shows all-green collapsed summary when all findings are green', async () => {
        resolve(
            makeResponse({
                findings: [
                    makeFinding('inv-1', 'green', 'Check One'),
                    makeFinding('inv-2', 'green', 'Check Two'),
                ],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText(/All 2 checks healthy/)).toBeTruthy();
        });
    });

    test('shows loading state initially', () => {
        vi.mocked(apiGet).mockReturnValue(new Promise(() => {}));

        render(HealthInvariantsPanel);

        expect(screen.getByText('Loading checks…')).toBeTruthy();
    });

    test('renders a detail link with count + label, pointing at the given href', async () => {
        resolve(
            makeResponse({
                findings: [
                    makeFinding('inv-dormant', 'red', 'Stalled Check', 'Fix it', [
                        {
                            label: 'Media Probe',
                            sublabel: 'file.probed',
                            count: 1234,
                            href: '/admin/tasks/media-probe?tab=failures',
                        },
                    ]),
                ],
            }),
        );

        render(HealthInvariantsPanel);

        const link = await waitFor(() => screen.getByRole('link', { name: /Media Probe/ }));
        expect(link.getAttribute('href')).toBe('/admin/tasks/media-probe?tab=failures');
        expect(link.textContent).toContain('1,234');
        expect(link.textContent).toContain('file.probed');
    });

    test('renders a detail entry with no href as plain (non-clickable) text', async () => {
        resolve(
            makeResponse({
                findings: [
                    makeFinding('inv-dormant', 'red', 'Orphan Stage Check', 'Fix it', [
                        { label: 'unregistered-stage-id', count: 5 },
                    ]),
                ],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText('unregistered-stage-id')).toBeTruthy();
        });
        expect(screen.queryByRole('link', { name: /unregistered-stage-id/ })).toBeNull();
    });

    test('shows honest threshold copy with thousands separators instead of "problem level"', async () => {
        resolve(
            makeResponse({
                findings: [
                    {
                        ...makeFinding('inv-red', 'red', 'Big Number Check', 'Fix it'),
                        value: 2604,
                        thresholdAmber: 1000,
                        thresholdRed: 10000,
                    },
                ],
            }),
        );

        render(HealthInvariantsPanel);

        await waitFor(() => {
            expect(screen.getByText(/2,604/)).toBeTruthy();
        });
        expect(screen.queryByText(/problem level/)).toBeNull();
        expect(screen.getByText(/warning above 1,000/)).toBeTruthy();
        expect(screen.getByText(/problem above 10,000/)).toBeTruthy();
    });
});
