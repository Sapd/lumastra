// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { describe, expect, test, vi } from 'vitest';
import { readable } from 'svelte/store';
vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin/settings/livetv') }),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }));

import LiveTvFailuresTab from './LiveTvFailuresTab.svelte';

const base = {
    id: 'e1',
    channelId: 'ch-1',
    channelName: 'News One',
    occurredAt: '2026-10-20T10:00:00.000Z',
    source: 'ingest',
    outcome: 'failed',
    exitCode: 1,
    signal: null,
    rungId: null,
    stderrTail: 'Server returned 403 Forbidden',
    probe: null,
    decision: null,
};

function renderTab(incident: Record<string, unknown>): void {
    render(LiveTvFailuresTab, {
        data: {
            incidents: [{ ...base, ...incident }],
            roots: { libraryRoots: [], transcodeRoot: '/tmp/x' },
        },
    } as never);
}

describe('LiveTvFailuresTab typed reason', () => {
    test('shows the reason label, upstream status and feed next to the stderr details', () => {
        renderTab({ reason: 'provider_auth_failed', upstreamStatus: 403, feedName: 'News One HD' });
        expect(screen.getByTestId('failure-reason').textContent).toBe('Login refused');
        expect(screen.getByText('HTTP 403')).toBeTruthy();
        expect(screen.getByTestId('failure-feed').textContent).toContain('News One HD');
        expect(screen.getByText('Server returned 403 Forbidden', { selector: 'p' })).toBeTruthy();
    });

    test('older rows without a reason render as before', () => {
        renderTab({ reason: null });
        expect(screen.queryByTestId('failure-reason')).toBeNull();
        expect(screen.queryByTestId('failure-feed')).toBeNull();
    });
});
