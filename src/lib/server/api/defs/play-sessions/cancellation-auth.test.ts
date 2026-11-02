// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { principalLocals, TEST_USER_ID } from '../../principal-locals.test-helpers.js';

const mocks = vi.hoisted(() => ({ row: vi.fn(), live: vi.fn(), kill: vi.fn() }));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: mocks.row,
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/services/livetv-active-sessions.service.js', () => ({
    cancelLiveTvPlaybackSession: mocks.live,
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({ killSessionUnified: mocks.kill }));
vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: () => ({}) }));

import { mount } from '../../mount.js';
import { cancellationDef } from './_cancellation.js';

const id = '550e8400-e29b-41d4-a716-446655440000';
function event(): RequestEvent {
    const locals = principalLocals({
        kind: 'bearer',
        ownerIsAdmin: false,
        tokenScopes: ['media:read'],
    });
    locals.user!.hasLiveTvPermission = true;
    const url = new URL(`http://localhost/api/v1/play-sessions/${id}`);
    return {
        locals,
        url,
        request: new Request(url, { method: 'DELETE' }),
        params: { id },
        route: { id: '/api/v1/play-sessions/[id]' },
        getClientAddress: () => '127.0.0.1',
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}
beforeEach(() => {
    vi.clearAllMocks();
    mocks.row.mockResolvedValue(null);
    mocks.live.mockResolvedValue(new Response(null, { status: 204 }));
});

it('lets a read-scoped authenticated Live TV caller reach ownership-checked cancellation', async () => {
    const response = await mount(cancellationDef, { surface: 'v1' }).DELETE!(event());
    expect(response.status).toBe(204);
    expect(mocks.live).toHaveBeenCalledWith(expect.anything(), id);
    expect(mocks.kill).not.toHaveBeenCalled();
});
it('preserves media:write for the same token cancelling its own VOD session', async () => {
    mocks.row.mockResolvedValue({ id, user_id: TEST_USER_ID });
    const response = await mount(cancellationDef, { surface: 'v1' }).DELETE!(event());
    expect(response.status).toBe(403);
    expect(mocks.kill).not.toHaveBeenCalled();
    expect(mocks.live).not.toHaveBeenCalled();
});
