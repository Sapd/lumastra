// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { beforeEach, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const session = vi.hoisted(() => vi.fn());
const heartbeat = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/preview-session.service.js', () => ({
    getPreviewSession: session,
    updateSessionHeartbeat: heartbeat,
    deletePreview: vi.fn(),
}));
import { deletePreview } from '$lib/server/services/preview-session.service.js';
import { def } from './[id]/keepalive.js';
import { def as preview } from './[id].js';
import { mount } from '$lib/server/api/mount.js';
import { principalLocals, TEST_USER_ID } from '$lib/server/api/principal-locals.test-helpers.js';
beforeEach(() => {
    vi.clearAllMocks();
    session.mockResolvedValue({ userId: TEST_USER_ID });
    heartbeat.mockResolvedValue(true);
});
it.each(['internal', 'v1'] as const)(
    '%s preview keepalive is bodyless and owner-only',
    async (surface) => {
        const id = 'preview-id';
        const url = new URL(
            `http://localhost/api${surface === 'v1' ? '/v1' : ''}/playback/previews/${id}/keepalive`,
        );
        const event = (): RequestEvent =>
            ({
                url,
                request: new Request(url, { method: 'POST' }),
                params: { id },
                locals: principalLocals({ kind: 'session', ownerIsAdmin: false }),
                getClientAddress: () => '127.0.0.1',
            }) as RequestEvent;
        const { POST } = mount(def, { surface });
        expect((await POST!(event())).status).toBe(204);
        expect(heartbeat).toHaveBeenCalledWith(id);
        heartbeat.mockClear();
        session.mockResolvedValue({ userId: 'another-user' });
        expect((await POST!(event())).status).toBe(404);
        expect(heartbeat).not.toHaveBeenCalled();
        expect(Reflect.get(preview.handlers, 'PATCH')).toBeUndefined();
    },
);

it('does not acknowledge a preview cleaned up between lookup and heartbeat', async () => {
    heartbeat.mockResolvedValue(false);
    const res = await def.handlers.POST!(
        { locals: { user: { userId: TEST_USER_ID } } } as RequestEvent,
        { input: { params: { id: 'ended' } } } as never,
    );
    expect(res.status).toBe(404);
});

it('keeps DELETE idempotent: 204 for unknown or foreign ids while keepalive is 404', async () => {
    const del = vi.mocked(deletePreview);
    del.mockResolvedValue(undefined as never);
    session.mockResolvedValue({ userId: 'another-user' });
    const res = await preview.handlers.DELETE!(
        { locals: { user: { userId: TEST_USER_ID } } } as RequestEvent,
        { input: { params: { id: 'foreign-or-unknown' } } } as never,
    );
    expect(res.status).toBe(204);
    const alive = await def.handlers.POST!(
        { locals: { user: { userId: TEST_USER_ID } } } as RequestEvent,
        { input: { params: { id: 'foreign-or-unknown' } } } as never,
    );
    expect(alive.status).toBe(404);
});
