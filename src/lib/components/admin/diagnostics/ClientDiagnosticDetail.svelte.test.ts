// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, within } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ClientDiagnosticDetail as Detail } from '$lib/schemas/client-diagnostics.js';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/client', () => ({ apiGet: vi.fn() }));

import ClientDiagnosticDetail from './ClientDiagnosticDetail.svelte';

afterEach(() => {
    cleanup();
});

function diagnostic(over: Partial<Detail>): Detail {
    return {
        id: 1,
        eventId: '6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11',
        shortId: '6F1C-1E0A',
        kind: 'js_error',
        platform: 'web',
        userId: null,
        username: 'denis',
        deviceId: null,
        deviceName: null,
        appVersion: '2026.10.21',
        osVersion: null,
        deviceModel: null,
        playSessionId: null,
        mediaId: null,
        mediaTitle: null,
        occurredAt: '2026-10-21T10:00:00.000Z',
        receivedAt: '2026-10-21T10:00:01.000Z',
        fingerprint: 'abc',
        occurrences: 3,
        summary: null,
        resolvedAt: null,
        hasBlob: false,
        appBuild: null,
        attemptId: null,
        payload: {},
        blob: null,
        ...over,
    };
}

describe('ClientDiagnosticDetail', () => {
    it('shows a failure the user saw with its message key, page and the failed call', () => {
        render(ClientDiagnosticDetail, {
            diagnostic: diagnostic({
                payload: {
                    origin: 'error_toast',
                    toastKey: 'audiobook_session_failed',
                    route: '/(app)/+page',
                    name: 'AudiobookSessionError',
                    message: 'Could not open the audiobook session',
                    stack: 'AudiobookSessionError: x\n    at openSession (/_app/chunk.js:1:2)',
                    cause: {
                        method: 'POST',
                        route: '/api/v1/play-sessions',
                        outcome: 'status_5xx',
                        status: 502,
                        problemCode: 'bad_gateway',
                    },
                },
            }),
        });
        const summary = within(screen.getByTestId('js-error-summary'));
        expect(summary.getByText('Failure shown to the user')).toBeTruthy();
        expect(summary.getByText('audiobook_session_failed')).toBeTruthy();
        expect(summary.getByText('/(app)/+page')).toBeTruthy();
        expect(summary.getByText('POST /api/v1/play-sessions → 502 (bad_gateway)')).toBeTruthy();
        expect(
            summary.getByText(/AudiobookSessionError: Could not open the audiobook session/),
        ).toBeTruthy();
        expect(summary.getByText(/at openSession/)).toBeTruthy();
        expect(screen.queryByTestId('api-failure-summary')).toBeNull();
    });

    it('flags a chunk-load error from a stale tab', () => {
        render(ClientDiagnosticDetail, {
            diagnostic: diagnostic({
                payload: {
                    origin: 'unhandled_rejection',
                    tag: 'chunk_load',
                    name: 'TypeError',
                    message: 'Failed to fetch dynamically imported module',
                },
            }),
        });
        const summary = within(screen.getByTestId('js-error-summary'));
        expect(summary.getByText('Unhandled promise rejection')).toBeTruthy();
        expect(summary.getByText(/chunk load/)).toBeTruthy();
    });

    it('shows an API failure with outcome, status, problem code and request id', () => {
        render(ClientDiagnosticDetail, {
            diagnostic: diagnostic({
                kind: 'api_failures',
                payload: {
                    windowStart: 1_761_040_800_000,
                    windowEnd: 1_761_040_860_000,
                    method: 'GET',
                    route: '/api/media/:id',
                    outcome: 'status_5xx',
                    status: 500,
                    problemCode: 'internal_error',
                    requestId: 'req-42',
                },
            }),
        });
        const summary = within(screen.getByTestId('api-failure-summary'));
        expect(summary.getByText(/GET\s+\/api\/media\/:id/)).toBeTruthy();
        expect(summary.getByText(/Server error \(5xx\) · HTTP 500/)).toBeTruthy();
        expect(summary.getByText('internal_error')).toBeTruthy();
        expect(summary.getByText('req-42')).toBeTruthy();
        expect(screen.getByText('Occurrences').nextElementSibling?.textContent).toBe('3');
        expect(screen.queryByTestId('js-error-summary')).toBeNull();
    });

    it('renders other kinds with the raw payload only', () => {
        render(ClientDiagnosticDetail, {
            diagnostic: diagnostic({ kind: 'crash', payload: { source: 'metrickit' } }),
        });
        expect(screen.queryByTestId('js-error-summary')).toBeNull();
        expect(screen.queryByTestId('api-failure-summary')).toBeNull();
        expect(screen.getByText(/"source": "metrickit"/)).toBeTruthy();
    });
});
