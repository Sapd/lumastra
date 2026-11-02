// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/api/mount.js', () => ({ enforce: async () => null }));
const mockCancelLive = vi.hoisted(() => vi.fn().mockResolvedValue(null));
vi.mock('$lib/server/services/livetv-active-sessions.service.js', () => ({
    cancelLiveTvPlaybackSession: mockCancelLive,
}));
const mockGetSessionById = vi.fn();
const mockKillSessionUnified = vi.fn();
const mockGetSql = vi.fn();
const mockAuditLog = vi.fn();

vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: (...a: unknown[]) => mockGetSessionById(...a),
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({
    killSessionUnified: (...a: unknown[]) => mockKillSessionUnified(...a),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return {
        ...actual,
        auditLog: (...a: unknown[]) => mockAuditLog(...a),
    };
});

import { cancellationDef as def } from '../_cancellation.js';

const SQL = {} as never;
const SESSION_ID = '550e8400-e29b-41d4-a716-446655440000';
// Invoke the def's DELETE handler directly with a minimal event + validated ctx.
function invoke(locals: Record<string, unknown>, sessionId = SESSION_ID) {
    return def.handlers.DELETE!(
        { locals } as never,
        { input: { params: { id: sessionId } } } as never,
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    mockCancelLive.mockResolvedValue(null);
    mockGetSql.mockResolvedValue(SQL);
    mockKillSessionUnified.mockResolvedValue({
        killed: true,
        source: 'database',
        username: 'alice',
    });
});

describe('DELETE /api/play-sessions/[id]', () => {
    it('lets the owner cancel their own session (204) and kills as themselves', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-alice' });
        const res = await invoke({ user: { userId: 'uid-alice', username: 'alice' } });
        expect(res.status).toBe(204);
        expect(mockKillSessionUnified).toHaveBeenCalledWith(SQL, SESSION_ID, 'alice');
        expect(mockAuditLog).toHaveBeenCalledWith('play_session.self_cancel', SESSION_ID, {
            username: 'alice',
        });
    });

    it('lets an admin cancel someone else’s session', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-bob' });
        const res = await invoke({
            user: { userId: 'uid-admin', username: 'admin', isAdmin: true },
            principal: { kind: 'session', username: 'admin', isAdmin: true },
        });
        expect(res.status).toBe(204);
        expect(mockKillSessionUnified).toHaveBeenCalledWith(SQL, SESSION_ID, 'admin');
        expect(mockAuditLog).toHaveBeenCalledWith(
            'play_session.cancel',
            SESSION_ID,
            expect.objectContaining({ username: 'admin' }),
        );
    });

    it('returns 404 (not 403) when a non-admin targets someone else’s session', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-bob' });
        const res = await invoke({ user: { userId: 'uid-alice', username: 'alice' } });
        expect(res.status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('returns 404 when the session does not exist', async () => {
        mockGetSessionById.mockResolvedValue(null);
        const res = await invoke({ user: { userId: 'uid-alice', username: 'alice' } });
        expect(res.status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('delegates a Live TV handle to the owner-checked Live TV stop', async () => {
        mockGetSessionById.mockResolvedValue(null);
        mockCancelLive.mockResolvedValue(new Response(null, { status: 204 }));
        expect((await invoke({ user: { userId: 'uid-alice', username: 'alice' } })).status).toBe(
            204,
        );
        expect(mockCancelLive).toHaveBeenCalledWith(expect.anything(), SESSION_ID);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('returns 401 when unauthenticated', async () => {
        const res = await invoke({});
        expect(res.status).toBe(401);
    });
});
