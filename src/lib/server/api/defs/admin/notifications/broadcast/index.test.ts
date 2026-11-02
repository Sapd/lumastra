// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audit-actor coverage for POST /api/admin/notifications/broadcast (fix
 * round 1, security review 2026-09-13, R5 follow-through).
 *
 * `SendBroadcastOpts.actor` is a REQUIRED field, so a type-only regression
 * (dropping `actor: auditActor(event)` entirely) would already fail to
 * compile — but a regression that passes something OTHER than
 * `auditActor(event)` (e.g. accidentally reusing `{ username }`, the DB
 * `createdBy` value) would still type-check and would silently drop
 * `kind`/`credentialId` from the audit trail again. This test asserts the
 * EXACT object `auditActor(event)` builds reaches `sendBroadcast`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockSendBroadcast = vi.fn();
vi.mock('$lib/server/services/admin-broadcast.service.js', () => ({
    sendBroadcast: (...args: unknown[]) => mockSendBroadcast(...args),
}));

const mockGetDb = vi.fn();
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: () => mockGetDb(),
}));

const { def } = await import('./index.js');

function makeEvent(locals: Record<string, unknown>): RequestEvent {
    return { locals } as unknown as RequestEvent;
}

const INPUT = {
    title: 'Maintenance on Sunday',
    audience: 'all' as const,
    pinned: false,
    pushEnabled: true,
};

const ctx = { input: { body: INPUT } } as never;

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({} as never);
    mockSendBroadcast.mockResolvedValue({
        ok: true,
        broadcast: { id: 'b1', recipientCount: 0, pinnedAt: null },
        deliveredCount: 0,
        failedCount: 0,
    });
});

describe('POST /admin/notifications/broadcast — audit actor', () => {
    it('passes actor: auditActor(event) — the full Principal object, not the plain createdBy username', async () => {
        const event = makeEvent({
            user: { username: 'alice' },
            principal: { username: 'alice', kind: 'pat', credentialId: 'pat-1', isAdmin: true },
        });

        await def.handlers.POST!(event, ctx);

        expect(mockSendBroadcast).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                createdBy: 'alice',
                actor: { username: 'alice', kind: 'pat', credentialId: 'pat-1' },
            }),
        );
    });

    it('falls back to a null-username actor when no Principal is resolved (locals.user only)', async () => {
        const event = makeEvent({ user: { username: 'bob' } });

        await def.handlers.POST!(event, ctx);

        expect(mockSendBroadcast).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                createdBy: 'bob',
                actor: { username: 'bob' },
            }),
        );
    });
});
