// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PATCH/DELETE /api/admin/notifications/broadcasts/{id} — handler behaviour.
 *
 * The def tests next door pin the schemas and the gating; nothing drove the
 * handlers themselves, so a 404 turned into a 200, a skipped audit entry, or the
 * strict re-parse (which the all-optional def body cannot do) going missing
 * would all have passed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockSetBroadcastPin = vi.fn();
const mockDeleteBroadcast = vi.fn();
vi.mock('$lib/server/database/queries/admin-broadcasts.queries.js', () => ({
    setBroadcastPin: (...args: unknown[]) => mockSetBroadcastPin(...args),
    deleteBroadcast: (...args: unknown[]) => mockDeleteBroadcast(...args),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
    auditActor: () => ({ username: 'alice' }),
}));

const { def } = await import('./index.js');

const ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function makeEvent(): RequestEvent {
    return {
        locals: { user: { username: 'alice' } },
        params: { id: ID },
    } as unknown as RequestEvent;
}

function ctxWithBody(body: unknown): never {
    return { input: { body } } as never;
}

function isoOffsetFromNow(ms: number): string {
    return new Date(Date.now() + ms).toISOString();
}

const UNPINNED_ROW = {
    id: ID,
    title: 'Maintenance',
    body: null,
    audience: 'all',
    recipientCount: 3,
    pushEnabled: true,
    pinnedAt: null,
    pinnedBy: null,
    pinExpiresAt: null,
    isPinned: false,
    createdBy: 'alice',
    createdAt: '2026-10-01T00:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({} as never);
    mockSetBroadcastPin.mockResolvedValue(UNPINNED_ROW);
    mockDeleteBroadcast.mockResolvedValue(true);
});

describe('PATCH /api/admin/notifications/broadcasts/{id}', () => {
    it('unpins even when the client echoes a lapsed pin deadline', async () => {
        const res = await def.handlers.PATCH!(
            makeEvent(),
            ctxWithBody({ pinned: false, pinExpiresAt: isoOffsetFromNow(-60 * 60 * 1000) }),
        );

        expect(res.status).toBe(200);
        expect(mockSetBroadcastPin).toHaveBeenCalledWith(
            expect.anything(),
            ID,
            expect.objectContaining({ pinned: false }),
        );
        expect(mockAuditLog).toHaveBeenCalledWith(
            'notification.broadcast.unpin',
            ID,
            expect.anything(),
            expect.anything(),
        );
    });

    it('refuses to PIN with a past deadline (422, nothing written)', async () => {
        const res = await def.handlers.PATCH!(
            makeEvent(),
            ctxWithBody({ pinned: true, pinExpiresAt: isoOffsetFromNow(-1000) }),
        );

        expect(res.status).toBe(422);
        expect(mockSetBroadcastPin).not.toHaveBeenCalled();
    });

    it('refuses a body without `pinned` instead of reading it as an unpin', async () => {
        const res = await def.handlers.PATCH!(makeEvent(), ctxWithBody({}));

        expect(res.status).toBe(422);
        expect(mockSetBroadcastPin).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown broadcast and audits nothing', async () => {
        mockSetBroadcastPin.mockResolvedValue(null);

        const res = await def.handlers.PATCH!(makeEvent(), ctxWithBody({ pinned: true }));

        expect(res.status).toBe(404);
        expect(mockAuditLog).not.toHaveBeenCalled();
    });
});

describe('DELETE /api/admin/notifications/broadcasts/{id}', () => {
    it('answers 204 and audits the retraction', async () => {
        const res = await def.handlers.DELETE!(makeEvent(), ctxWithBody({}));

        expect(res.status).toBe(204);
        expect(mockDeleteBroadcast).toHaveBeenCalledWith(expect.anything(), ID);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'notification.broadcast.delete',
            ID,
            expect.anything(),
        );
    });

    it('answers 404 for an unknown broadcast and audits nothing', async () => {
        mockDeleteBroadcast.mockResolvedValue(false);

        const res = await def.handlers.DELETE!(makeEvent(), ctxWithBody({}));

        expect(res.status).toBe(404);
        expect(mockAuditLog).not.toHaveBeenCalled();
    });
});
