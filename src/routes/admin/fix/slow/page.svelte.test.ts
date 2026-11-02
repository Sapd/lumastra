// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The slow guide's reassurances need measurements. "No transcodes are running"
 * needs the sampler, a dead mount is listed rather than dropped, and a failed
 * section is named instead of silently missing.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as m from '$lib/paraglide/messages.js';

const api = vi.hoisted(() => ({
    apiGet: vi.fn(),
    apiPost: vi.fn(),
    getTaskSystemNow: vi.fn(),
    getIngestStageActivity: vi.fn(),
    getSystemMetrics: vi.fn(),
}));
vi.mock('$lib/api/client.js', () => ({ apiGet: api.apiGet, apiPost: api.apiPost }));
vi.mock('$lib/api/admin.js', () => ({
    getTaskSystemNow: api.getTaskSystemNow,
    getIngestStageActivity: api.getIngestStageActivity,
    getSystemMetrics: api.getSystemMetrics,
}));
vi.mock('$app/stores', async () => {
    const { readable } = await import('svelte/store');
    return { page: readable({ data: {}, url: new URL('http://localhost/admin/fix/slow') }) };
});
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));
const toast = vi.hoisted(() => ({
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: toast }));

import Page from './+page.svelte';

const PRESSURE = {
    generatedAt: '2026-10-06T10:00:00.000Z',
    memory: { limitBytes: null, usageBytes: null, hostTotalBytes: 8e9, source: 'cgroup-v2' },
    volumes: [],
    unmeasured: [{ path: '/mnt/nas', label: '/mnt/nas', reason: 'timeout' }],
    pathsLookupFailed: false,
    cpu: { effectiveCores: 4, hostCores: 8, source: 'host' },
    containerized: true,
};

const FAIL = { data: undefined, error: 'boom', status: 500 };

beforeEach(() => {
    api.apiGet.mockImplementation(async (url: unknown) =>
        String(url).includes('host-pressure')
            ? { data: PRESSURE, error: null }
            : { data: { available: true, source: 'in-process' }, error: null },
    );
    api.getTaskSystemNow.mockResolvedValue(FAIL);
    api.getIngestStageActivity.mockResolvedValue(FAIL);
    api.getSystemMetrics.mockResolvedValue(FAIL);
});

afterEach(() => cleanup());

describe('/admin/fix/slow', () => {
    it('a failed metrics read is not "no transcodes are running"', async () => {
        render(Page);
        await screen.findByText(m.admin_fix_slow_playback_unknown());
        expect(screen.queryByText(m.admin_fix_slow_playback_none())).toBeNull();
    });

    it('lists a volume that did not answer', async () => {
        render(Page);
        await screen.findByText(
            m.admin_fix_slow_disk_unmeasured({ volume: '/mnt/nas', reason: 'timeout' }),
        );
    });

    it('names the sections it could not read', async () => {
        render(Page);
        const alert = await screen.findByRole('alert');
        expect(alert.textContent).toContain(m.admin_fix_slow_section_lanes());
        expect(alert.textContent).toContain(m.admin_fix_slow_section_stages());
    });
});

describe('/admin/fix/slow lane pause', () => {
    it('pausing says it persists and offers Resume from the toast', async () => {
        api.getTaskSystemNow.mockResolvedValue({
            data: {
                classes: [
                    {
                        resourceClass: 'cpu',
                        waiting: 3,
                        active: 1,
                        delayed: 0,
                        paused: false,
                        cap: 2,
                        saturationPct: 0.5,
                        leaderInstanceId: null,
                    },
                ],
                nodes: [],
                schedules: [],
                health: { status: 'healthy', available: true },
                generatedAt: '2026-10-06T10:00:00.000Z',
            },
            error: null,
        });
        api.apiPost.mockResolvedValue({ data: { message: 'server text' }, error: null });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: m.admin_fix_slow_pause() }),
        );
        await vi.waitFor(() => expect(toast.success).toHaveBeenCalled());
        const [message, opts] = toast.success.mock.calls[0] as [
            string,
            { action?: { label: string; onClick: () => void } },
        ];
        expect(message).not.toBe('server text');
        expect(opts.action?.label).toBe(m.admin_fix_slow_resume());
        opts.action?.onClick();
        await vi.waitFor(() =>
            expect(api.apiPost.mock.calls.some((c) => String(c[0]).endsWith('/cpu/resume'))).toBe(
                true,
            ),
        );
    });
});
