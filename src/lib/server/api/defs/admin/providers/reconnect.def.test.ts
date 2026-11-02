// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/v1/admin/providers/reconnect?service=jellyfin goes through the
 * connection lifecycle (re-read + apply settings, then check), so Reconnect
 * works in a process that booted without Jellyfin settings.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockReconnect = vi.fn<() => Promise<boolean | null>>();
const state = vi.hoisted(() => ({ value: 'connected' }));

vi.mock('$lib/server/jellyfin/connection-lifecycle.js', () => ({
    reconnectJellyfin: () => mockReconnect(),
}));
vi.mock('$lib/server/services/connection-status.service.js', () => ({
    connectionStatus: { getStatus: () => ({ state: state.value }) },
}));

const { def } = await import('./reconnect.js');

function post(service: string): Promise<Response> {
    const url = new URL(`http://localhost/api/v1/admin/providers/reconnect?service=${service}`);
    const handler = def.handlers.POST as unknown as (e: RequestEvent) => Promise<Response>;
    return handler({ url, locals: {}, params: {} } as unknown as RequestEvent);
}

beforeEach(() => mockReconnect.mockReset());

describe('admin providers reconnect (jellyfin)', () => {
    it('reports the lifecycle result and the current state', async () => {
        mockReconnect.mockResolvedValue(true);
        state.value = 'connected';
        const res = await post('jellyfin');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            service: 'jellyfin',
            success: true,
            state: 'connected',
        });
        expect(mockReconnect).toHaveBeenCalledTimes(1);
    });

    it('reports a failed check as success:false', async () => {
        mockReconnect.mockResolvedValue(false);
        state.value = 'disconnected';
        const res = await post('jellyfin');
        expect(res.status).toBe(200);
        expect((await res.json()).success).toBe(false);
    });

    it('answers 422 when Jellyfin is not configured', async () => {
        mockReconnect.mockResolvedValue(null);
        const res = await post('jellyfin');
        expect(res.status).toBe(422);
    });

    it('rejects an unknown service without touching Jellyfin', async () => {
        const res = await post('emby');
        expect(res.status).toBe(422);
        expect(mockReconnect).not.toHaveBeenCalled();
    });
});
