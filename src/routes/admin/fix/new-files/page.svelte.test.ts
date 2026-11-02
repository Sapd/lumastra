// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The scan check answers 200 with `dbError` when the database or the library
 * paths could not be read. The rest of that payload is defaults, and rendered
 * it reads "no library folders are configured" — the wrong diagnosis on a
 * "my library is empty" visit. These pin that it is shown as an error.
 */

import { cleanup, render, screen } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({ apiGet: vi.fn() }));
vi.mock('$lib/api/client.js', () => api);
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ data: {}, url: new URL('http://localhost/admin/fix/new-files') }) };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));

import Page from './+page.svelte';

function payload(over: Record<string, unknown> = {}): unknown {
    return {
        generatedAt: '2026-10-06T10:00:00.000Z',
        schedule: {
            globallyDisabled: false,
            paused: false,
            pausedBy: null,
            lastFiredAt: null,
            nextFireAt: null,
            neverScheduled: true,
            unreadable: false,
        },
        process: { uid: 1000, gid: 1000, containerized: true, platform: 'linux' },
        paths: [],
        pipeline: null,
        dbError: null,
        ...over,
    };
}

afterEach(() => cleanup());

describe('/admin/fix/new-files', () => {
    it('a dbError payload is an error, not "no folders configured"', async () => {
        api.apiGet.mockResolvedValue({
            data: payload({ dbError: 'Could not read library paths' }),
            error: null,
            status: 200,
        });
        render(Page);
        await screen.findByRole('button', { name: m.common_retry() });
        expect(screen.queryByText(m.admin_fix_files_paths_none())).toBeNull();
        expect(screen.queryByText(m.admin_fix_files_scan_never())).toBeNull();
    });

    it('an unreadable schedule is not "never scheduled"', async () => {
        api.apiGet.mockResolvedValue({
            data: payload({
                schedule: {
                    globallyDisabled: false,
                    paused: false,
                    pausedBy: null,
                    lastFiredAt: null,
                    nextFireAt: null,
                    neverScheduled: false,
                    unreadable: true,
                },
            }),
            error: null,
            status: 200,
        });
        render(Page);
        await screen.findByText(m.admin_fix_files_scan_unreadable());
        expect(screen.queryByText(m.admin_fix_files_scan_never())).toBeNull();
    });

    it('a real empty configuration still says so', async () => {
        api.apiGet.mockResolvedValue({ data: payload(), error: null, status: 200 });
        render(Page);
        await screen.findByText(m.admin_fix_files_paths_none());
    });
});
