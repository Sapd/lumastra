// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The typed client wakes the app-wide manual-run tracker whenever a MUTATING
 * response says it started a run — so no action has to remember to notify it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';

vi.mock('$app/environment', () => ({ browser: false, dev: false }));
const monitoredFetch = vi.hoisted(() => vi.fn());
vi.mock('$lib/auth-monitor.js', () => ({ monitoredFetch, handleAuthExpiration: vi.fn() }));

const { apiGet, apiPost } = await import('./client.js');
const { onRunStarted } = await import('./run-started-signal.js');

const json = (body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
const anything = z.object({}).passthrough();

describe('run-started signal from the API client', () => {
    const listener = vi.fn();
    beforeEach(() => {
        vi.clearAllMocks();
        onRunStarted(listener);
    });

    it('fires on a POST whose response carries a jobId or runId', async () => {
        monitoredFetch.mockResolvedValueOnce(json({ jobId: 'run_1', message: 'Scan started' }));
        await apiPost('/api/admin/plugins/file-scanner', anything, {});
        monitoredFetch.mockResolvedValueOnce(json({ runId: 'run_2' }));
        await apiPost('/api/admin/media/x/sync', anything, {});
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('stays quiet for GETs and for responses without a run id', async () => {
        monitoredFetch.mockResolvedValueOnce(json({ jobId: 'run_1' }));
        await apiGet('/api/runs', anything);
        monitoredFetch.mockResolvedValueOnce(json({ ok: true }));
        await apiPost('/api/rating', anything, {});
        expect(listener).not.toHaveBeenCalled();
    });
});
