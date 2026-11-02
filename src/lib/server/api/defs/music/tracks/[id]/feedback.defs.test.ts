// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
const mocks = vi.hoisted(() => ({ like: vi.fn(), dislike: vi.fn(), clearFeedback: vi.fn() }));
vi.mock('$lib/server/services/music-interaction-manager.service.js', () => ({
    musicInteractionManager: mocks,
}));
import { def } from '../../../user/music/tracks/[id]/feedback.js';
import * as route from '../../../../../../../routes/api/v1/me/music/tracks/[id]/feedback/+server.js';
const id = '11111111-2222-4333-a444-555555555555';
const user = { userId: '00000000-0000-4000-a000-000000000001' };
function event(method: string, body?: unknown): RequestEvent {
    return {
        locals: { user },
        params: { id },
        request: new Request('http://localhost/', {
            method,
            ...(body === undefined
                ? {}
                : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } }),
        }),
    } as unknown as RequestEvent;
}
const context = { input: { params: { id } } } as never;
beforeEach(() => vi.clearAllMocks());
describe('unified explicit feedback', () => {
    it.each(['liked', 'disliked'])('sets %s and returns 204', async (feedback) => {
        const response = await def.handlers.PUT!(event('PUT', { feedback }), context);
        expect(response.status).toBe(204);
        expect(mocks[feedback === 'liked' ? 'like' : 'dislike']).toHaveBeenCalledWith(
            user.userId,
            id,
            user,
        );
    });
    it('rejects an invalid direction', async () => {
        expect((await def.handlers.PUT!(event('PUT', { feedback: 'skip' }), context)).status).toBe(
            422,
        );
        expect(mocks.like).not.toHaveBeenCalled();
    });
    it('DELETE needs no body and is idempotent', async () => {
        expect((await def.handlers.DELETE!(event('DELETE'), context)).status).toBe(204);
        expect((await def.handlers.DELETE!(event('DELETE'), context)).status).toBe(204);
        expect(mocks.clearFeedback).toHaveBeenCalledWith(user.userId, id, user);
        expect(route.PUT).toBeTypeOf('function');
        expect(route.DELETE).toBeTypeOf('function');
    });
});
