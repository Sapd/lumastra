// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * "No missing episodes found" is a claim about the series that were compared.
 * It is not made when none could be, and is narrowed when only some could.
 */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('$lib/api/client.js', () => api);
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return {
        page: readable({ data: {}, url: new URL('http://localhost/admin/fix/missing-episodes') }),
    };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import Page from './+page.svelte';

function check(over: Record<string, unknown>): unknown {
    return {
        generatedAt: '2026-10-06T10:00:00.000Z',
        seriesWithFiles: 10,
        unmeasuredSeries: 0,
        conflictedSeries: 0,
        seriesWithGaps: 0,
        missingTotal: 0,
        syncPaused: false,
        syncLastFiredAt: null,
        syncLastRunUnreadable: false,
        gaps: [],
        gapsTruncated: false,
        ...over,
    };
}

async function show(over: Record<string, unknown>): Promise<void> {
    api.apiGet.mockResolvedValue({ data: check(over), error: null, status: 200 });
    render(Page);
    await screen.findByText(m.admin_fix_episodes_heading());
}

afterEach(() => cleanup());

describe('/admin/fix/missing-episodes', () => {
    it('all series measured and no gaps → the all-clear', async () => {
        await show({});
        expect(screen.getByText(m.admin_fix_episodes_none_title())).toBeTruthy();
    });

    it('no series measured → no all-clear', async () => {
        await show({ unmeasuredSeries: 7, conflictedSeries: 3 });
        expect(screen.queryByText(m.admin_fix_episodes_none_title())).toBeNull();
        expect(screen.getByText(m.admin_fix_episodes_none_unmeasured())).toBeTruthy();
    });

    it('no series on disk → no all-clear', async () => {
        await show({ seriesWithFiles: 0 });
        expect(screen.queryByText(m.admin_fix_episodes_none_title())).toBeNull();
        expect(screen.getByText(m.admin_fix_episodes_none_noseries())).toBeTruthy();
    });

    it('some series unmeasured → a narrowed statement', async () => {
        await show({ unmeasuredSeries: 4 });
        expect(screen.queryByText(m.admin_fix_episodes_none_title())).toBeNull();
        expect(
            screen.getByText(m.admin_fix_episodes_none_partial({ measured: 6, total: 10 })),
        ).toBeTruthy();
    });

    it('an unreadable run history is not "never run"', async () => {
        await show({ syncLastRunUnreadable: true });
        expect(screen.queryByText(m.admin_fix_episodes_lastrun_never())).toBeNull();
        expect(screen.getByText(m.admin_fix_episodes_lastrun_unreadable())).toBeTruthy();
    });
});
