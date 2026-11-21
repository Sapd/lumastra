// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const { mockGetSourceById, mockStartRun } = vi.hoisted(() => ({
    mockGetSourceById: vi.fn(),
    mockStartRun: vi.fn(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn().mockResolvedValue({}) },
}));
vi.mock('$lib/server/database/queries/livetv-sources.queries.js', () => ({
    getSourceById: mockGetSourceById,
}));
vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: mockStartRun },
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from './import.js';

const SOURCE_ID = 'aaaaaaaa-0000-4000-8000-000000000001';

function makeEvent(): RequestEvent {
    const url = new URL(`http://localhost/api/v1/livetv/admin/sources/${SOURCE_ID}/import`);
    return {
        url,
        request: new Request(url, { method: 'POST' }),
        params: { sourceId: SOURCE_ID },
        route: { id: '/api/v1/livetv/admin/sources/[id]/import' },
        locals: { principal: { scopes: ['livetv:admin'] } },
        cookies: { get: vi.fn(), set: vi.fn() },
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

it('returns 409 for import on a source marked for deletion', async () => {
    mockGetSourceById.mockResolvedValueOnce({
        deleting_since: new Date(),
        m3u_url: 'http://provider.example/playlist.m3u',
    });
    const { POST } = mount(def, { surface: 'v1' });

    const res = await POST!(makeEvent());

    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'conflict', error: 'Source is being deleted' });
    expect(mockGetSourceById).toHaveBeenCalledWith({}, SOURCE_ID);
    expect(mockStartRun).not.toHaveBeenCalled();
});
