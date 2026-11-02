// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { cancellationDef as def } from '../../play-sessions/_cancellation.js';

const SQL = {} as never;
const SESSION_ID = '5b0c1c2e-6a8f-4d7e-9b1a-2f3c4d5e6f70';

function invoke(locals: Record<string, unknown>, sessionId = SESSION_ID) {
    return def.handlers.DELETE!({ params: { id: sessionId }, locals } as never, {} as never);
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue(SQL);
    mockKillSessionUnified.mockResolvedValue({
        killed: true,
        source: 'database',
        username: 'alice',
    });
});

describe('DELETE /api/v1/play-sessions/{id}', () => {
    // The reported gap: a tvOS app killed mid-play left its session holding the
    // listener's only stream slot, and this endpoint answered the owner with
    // 403 "Admin access required".
    it('lets the owner free their own session (204) and kills as themselves', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-alice' });
        const res = await invoke({
            principal: { username: 'alice', isAdmin: false, scopes: ['media:write'] },
            user: { userId: 'uid-alice', username: 'alice' },
        });
        expect(res.status).toBe(204);
        expect(mockKillSessionUnified).toHaveBeenCalledWith(SQL, SESSION_ID, 'alice');
        expect(mockAuditLog).toHaveBeenCalledWith(
            'play_session.self_cancel',
            SESSION_ID,
            expect.anything(),
        );
    });

    it('lets an admin cancel someone else’s session', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-bob' });
        const res = await invoke({
            principal: { username: 'admin', isAdmin: true, scopes: ['admin'] },
            user: { userId: 'uid-admin', username: 'admin', isAdmin: true },
        });
        expect(res.status).toBe(204);
        expect(mockKillSessionUnified).toHaveBeenCalledWith(SQL, SESSION_ID, 'admin');
        expect(mockAuditLog).toHaveBeenCalledWith(
            'play_session.cancel',
            SESSION_ID,
            expect.anything(),
        );
    });

    it('returns 404, not 403, when a non-admin targets someone else’s session', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-bob' });
        const res = await invoke({
            principal: { username: 'alice', isAdmin: false, scopes: ['media:write'] },
            user: { userId: 'uid-alice', username: 'alice' },
        });
        expect(res.status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    // A device-flow token held by an admin is NOT admin (principal.isAdmin is
    // authoritative); it must not reach someone else's session through the
    // group-derived locals.user flag.
    it('trusts principal.isAdmin over locals.user.isAdmin', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-bob' });
        const res = await invoke({
            principal: { username: 'admin', isAdmin: false },
            user: { userId: 'uid-admin', username: 'admin', isAdmin: true },
        });
        expect(res.status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('returns 404 when the session does not exist', async () => {
        mockGetSessionById.mockResolvedValue(null);
        const res = await invoke({ user: { userId: 'uid-alice', username: 'alice' } });
        expect(res.status).toBe(404);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });

    it('returns 404 for a malformed id without querying', async () => {
        const res = await invoke({ user: { userId: 'uid-alice', username: 'alice' } }, 'nope');
        expect(res.status).toBe(404);
        expect(mockGetSessionById).not.toHaveBeenCalled();
    });

    it('returns 404 when the session ended between the read and the kill', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-alice' });
        mockKillSessionUnified.mockResolvedValue(null);
        const res = await invoke({
            user: { userId: 'uid-alice', username: 'alice' },
            principal: { username: 'alice', isAdmin: false, scopes: ['media:write'] },
        });
        expect(res.status).toBe(404);
    });
    it('does not cancel even the owned session without media:write scope', async () => {
        mockGetSessionById.mockResolvedValue({ id: SESSION_ID, user_id: 'uid-alice' });
        const response = await invoke({
            user: { userId: 'uid-alice', username: 'alice' },
            principal: { username: 'alice', isAdmin: false, scopes: ['media:read'] },
        });
        expect(response.status).toBe(403);
        expect(mockKillSessionUnified).not.toHaveBeenCalled();
    });
});
