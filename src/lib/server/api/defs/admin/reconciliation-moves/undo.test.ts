// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The undo endpoint maps the service's refusals to HTTP: an unknown move is a
 * 404, every other precondition failure a 409, and anything unexpected is
 * rethrown (a 500) rather than disguised as a conflict.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));

class MockUndoError extends Error {
    constructor(
        readonly code: string,
        message: string,
    ) {
        super(message);
    }
}
const undoReconciliationMove = vi.fn();
vi.mock('$lib/server/services/episode-reconciliation-undo.service.js', () => ({
    ReconciliationUndoError: MockUndoError,
    undoReconciliationMove,
}));

const { def } = await import('./undo.js');

const ID = '00000000-0000-4000-a000-000000000001';

function call() {
    const event = { locals: { user: { username: 'admin-user' } } } as unknown as RequestEvent;
    return def.handlers.POST!(event, { input: { params: { id: ID } } } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('POST /api/admin/reconciliation-moves/{id}/undo', () => {
    it('returns the restored position and records the admin as the actor', async () => {
        undoReconciliationMove.mockResolvedValue({
            moveId: ID,
            episodeId: 'e1',
            seasonNumber: 1,
            episodeNumber: 422,
        });

        const res = await call();

        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({
            moveId: ID,
            episodeId: 'e1',
            seasonNumber: 1,
            episodeNumber: 422,
        });
        expect(undoReconciliationMove).toHaveBeenCalledWith(expect.anything(), ID, 'admin-user');
    });

    it('records a token caller by its own name, not as "admin"', async () => {
        undoReconciliationMove.mockResolvedValue({
            moveId: ID,
            episodeId: 'e1',
            seasonNumber: 1,
            episodeNumber: 1,
        });
        const event = {
            locals: { principal: { username: 'service:ci-bot', kind: 'service' } },
        } as unknown as RequestEvent;

        await def.handlers.POST!(event, { input: { params: { id: ID } } } as never);

        expect(undoReconciliationMove).toHaveBeenCalledWith(
            expect.anything(),
            ID,
            'service:ci-bot',
        );
    });

    it('answers 404 for an unknown move', async () => {
        undoReconciliationMove.mockRejectedValue(new MockUndoError('not-found', 'not found'));
        expect((await call()).status).toBe(404);
    });

    it.each([
        'already-undone',
        'slot-taken',
        'identity-changed',
        'season-gone',
        'episode-gone',
        'locked',
        'busy',
    ])('answers 409 for %s', async (code) => {
        undoReconciliationMove.mockRejectedValue(new MockUndoError(code, 'refused'));
        expect((await call()).status).toBe(409);
    });

    it('rethrows an unexpected failure', async () => {
        undoReconciliationMove.mockRejectedValue(new Error('db down'));
        await expect(call()).rejects.toThrow('db down');
    });
});
