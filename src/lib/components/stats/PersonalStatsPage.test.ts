// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { flushSync } from 'svelte';
import StatsRoute from '../../../routes/stats/[username]/+page.svelte';
import PersonalStatsPage from './PersonalStatsPage.svelte';
import { apiGet } from '$lib/api/client';
import * as m from '$lib/paraglide/messages';
import type { ApiResult } from '$lib/api/types';
import type { AllStatsResponse } from '$lib/schemas/api-stats-responses';

const pageStore = vi.hoisted(() => {
    let value = { params: { username: 'alice' }, data: { user: { username: 'viewer' } } };
    const subscribers = new Set<(next: typeof value) => void>();
    return {
        subscribe(fn: (next: typeof value) => void): () => void {
            fn(value);
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
        set(username: string): void {
            value = { ...value, params: { username } };
            subscribers.forEach((fn) => fn(value));
        },
    };
});

vi.mock('$app/stores', () => ({ page: pageStore }));
vi.mock('$lib/paths', () => ({ resolve: (path: string) => path }));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/api/client', () => ({ apiGet: vi.fn() }));

const emptyStats: ApiResult<AllStatsResponse> = {
    data: { period: 'all', insufficientData: true, sessionCount: 0, stats: {} },
    error: null,
    status: 200,
};

describe('personal stats identity and recovery', () => {
    beforeEach(() => {
        pageStore.set('alice');
        vi.mocked(apiGet).mockResolvedValue(emptyStats);
    });
    afterEach(() => {
        cleanup();
        vi.resetAllMocks();
    });

    test('changing the route username fetches the new user instead of relabeling old stats', async () => {
        render(StatsRoute);
        await waitFor(() =>
            expect(apiGet).toHaveBeenCalledWith(
                '/api/stats/alice/all?period=all',
                expect.anything(),
            ),
        );
        pageStore.set('bob');
        flushSync();
        await waitFor(() =>
            expect(apiGet).toHaveBeenCalledWith('/api/stats/bob/all?period=all', expect.anything()),
        );
    });

    test('an old user request settling after navigation cannot overwrite the new user view', async () => {
        let finishOld!: (value: typeof emptyStats) => void;
        vi.mocked(apiGet).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finishOld = resolve;
                }),
        );
        const view = render(StatsRoute);
        await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));
        pageStore.set('bob');
        flushSync();
        await waitFor(() => expect(view.container.textContent).toContain(m.stats_empty_title()));
        finishOld({ ...emptyStats, error: 'old user failed' });
        await Promise.resolve();
        flushSync();
        expect(view.container.textContent).not.toContain(m.stats_error_load_failed());
        expect(view.container.textContent).toContain(m.stats_user_statistics({ username: 'bob' }));
    });

    test('failed period changes from empty stats expose a working Retry', async () => {
        const view = render(PersonalStatsPage, { username: 'alice', isOwnStats: true });
        await waitFor(() => expect(view.container.textContent).toContain(m.stats_empty_title()));
        vi.mocked(apiGet).mockResolvedValueOnce({ data: null, error: 'offline', status: 503 });
        await fireEvent.click(view.getByRole('button', { name: m.stats_period_7d() }));
        const retry = await view.findByRole('button', { name: m.stats_retry() });
        expect(view.container.textContent).toContain(m.stats_error_load_failed());
        await fireEvent.click(retry);
        await waitFor(() =>
            expect(view.queryByRole('button', { name: m.stats_retry() })).toBeNull(),
        );
        expect(apiGet).toHaveBeenLastCalledWith('/api/my-stats/all?period=7d', expect.anything());
    });
});
