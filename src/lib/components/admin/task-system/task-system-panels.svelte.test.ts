// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Health-page task-system panels: a slow response for a filter or window the
 * operator already left must not replace the newer one, and a failed
 * "load more" must not hide the rows already on screen.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const apiGet = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet }));

import AuditFeed from './AuditFeed.svelte';
import FailurePatternsPanel from './FailurePatternsPanel.svelte';

type Resolver = (value: unknown) => void;
const tick = () => new Promise((r) => setTimeout(r, 0));

function event(id: number, summary: string) {
    return {
        id,
        ts: '2026-10-06T10:00:00.000Z',
        instanceId: 'i1',
        category: 'reconciler',
        action: `action-${id}`,
        severity: 'info',
        summary,
        detail: {},
    };
}

function pattern(message: string) {
    return {
        fingerprint: message,
        normalizedMessage: message,
        sampleMessage: message,
        count: 2,
        firstSeen: '2026-10-06T10:00:00.000Z',
        lastSeen: '2026-10-06T11:00:00.000Z',
        affectedTasks: [],
        affectedTasksOverflow: 0,
        source: 'run',
    };
}

afterEach(() => {
    cleanup();
    apiGet.mockReset();
});

describe('AuditFeed', () => {
    it('a slow unfiltered page does not replace the filtered one requested after it', async () => {
        let resolveFirst: Resolver = () => {};
        apiGet.mockImplementation((url: string) => {
            if (url.includes('category=leader')) {
                return Promise.resolve({
                    data: {
                        items: [event(2, 'leader moved')],
                        page: { limit: 50, hasMore: false },
                    },
                    error: null,
                });
            }
            return new Promise((r) => (resolveFirst = r));
        });
        render(AuditFeed);

        await fireEvent.click(screen.getByRole('button', { name: 'Coordination' }));
        await waitFor(() => expect(screen.getByText('leader moved')).toBeTruthy());

        resolveFirst({
            data: { items: [event(1, 'unfiltered row')], page: { limit: 50, hasMore: false } },
            error: null,
        });
        await tick();

        expect(screen.queryByText('unfiltered row')).toBeNull();
        expect(screen.getByText('leader moved')).toBeTruthy();
    });

    it('a failed load-more keeps the loaded rows and says what failed', async () => {
        apiGet.mockImplementation((url: string) =>
            Promise.resolve(
                url.includes('cursor=')
                    ? { data: null, error: 'Service unavailable' }
                    : {
                          data: {
                              items: [event(5, 'first page row')],
                              page: { limit: 50, hasMore: true, nextCursor: '5' },
                          },
                          error: null,
                      },
            ),
        );
        render(AuditFeed);

        await waitFor(() => expect(screen.getByText('first page row')).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

        await waitFor(() => expect(screen.getByText('Service unavailable')).toBeTruthy());
        expect(screen.getByText('first page row')).toBeTruthy();
    });
});

describe('FailurePatternsPanel', () => {
    it('the newest window wins even when an older request answers last', async () => {
        const pending: Record<string, Resolver> = {};
        apiGet.mockImplementation((url: string) => {
            const hours = new URL(url, 'http://x').searchParams.get('sinceHours')!;
            return new Promise((r) => (pending[hours] = r));
        });
        render(FailurePatternsPanel, { props: { defaultHours: 24 } });

        await fireEvent.click(screen.getByRole('button', { name: '1h' }));
        pending['1']({ data: { patterns: [pattern('one hour pattern')] }, error: null });
        await waitFor(() =>
            expect(screen.getByText('one hour pattern', { selector: 'code' })).toBeTruthy(),
        );

        pending['24']({ data: { patterns: [pattern('day pattern')] }, error: null });
        await tick();

        expect(screen.queryByText('day pattern', { selector: 'code' })).toBeNull();
        expect(screen.getByText('one hour pattern', { selector: 'code' })).toBeTruthy();
    });
});
