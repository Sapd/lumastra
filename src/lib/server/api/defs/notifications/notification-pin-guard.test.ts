// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Regression test — a pinned announcement cannot be dismissed.
 *
 * The product rule: an administrator pinned it so it would STAY visible, and a
 * user dismissing it would undo that unilaterally. Marking it read is still
 * allowed and is the intended action — it clears the badge while the
 * announcement stays put.
 *
 * The drawer already hides its dismiss control on a pinned row, but that is a
 * courtesy, not the enforcement: any API client, any older build of the iOS
 * app, and any user with curl can still issue the DELETE. This test pins the
 * SERVER-side half.
 *
 * Named `notification-pin-guard.test.ts` rather than colocated as
 * `[id]/index.test.ts` because `[id]` is a route-parameter directory; a test
 * file there is awkward to target and the guard is about the FEATURE, not the
 * file.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// ── Module mocks (hoisted before the def import below) ────────────────────────

const mockGetDb = vi.fn();
const mockGetNotificationForUser = vi.fn();
const mockDeleteNotification = vi.fn();

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: (...args: unknown[]) => mockGetDb(...args),
}));

vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    getNotificationForUser: (...args: unknown[]) => mockGetNotificationForUser(...args),
    deleteNotification: (...args: unknown[]) => mockDeleteNotification(...args),
}));

vi.mock('$lib/server/services/request-dismissal-sync.service.js', () => ({
    scheduleDismissalSyncForInboxRow: vi.fn(),
}));

const { def } = await import('./[id]/index.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOTIFICATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = 'user-uuid-0001';

function makeEvent(): RequestEvent {
    const url = new URL(`http://localhost/api/v1/notifications/${NOTIFICATION_ID}`);
    return {
        url,
        params: { id: NOTIFICATION_ID },
        request: new Request(url.toString(), { method: 'DELETE' }),
        locals: {
            principal: { userId: USER_ID },
        } as unknown as RequestEvent['locals'],
    } as unknown as RequestEvent;
}

const CTX = { surface: 'v1' } as const;

function row(overrides: Record<string, unknown> = {}) {
    return {
        id: NOTIFICATION_ID,
        userId: USER_ID,
        kind: 'admin.broadcast',
        payload: { broadcastId: '22222222-2222-4222-8222-222222222222', title: 'Maintenance' },
        readAt: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: null,
        pinnedAt: null,
        isPinned: false,
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockDeleteNotification.mockResolvedValue(row());
});

describe('DELETE /api/v1/notifications/{id} — pin guard', () => {
    it('refuses with 409 while the announcement is pinned', async () => {
        mockGetNotificationForUser.mockResolvedValue(
            row({ isPinned: true, pinnedAt: '2026-01-02T00:00:00.000Z' }),
        );

        const res = (await def.handlers.DELETE!(makeEvent(), CTX as never)) as Response;

        expect(res.status).toBe(409);
        // The refusal must actually PREVENT the delete, not merely report one
        // after the row is gone.
        expect(mockDeleteNotification).not.toHaveBeenCalled();
    });

    it('deletes normally once the pin is gone', async () => {
        mockGetNotificationForUser.mockResolvedValue(row({ isPinned: false, pinnedAt: null }));

        const res = (await def.handlers.DELETE!(makeEvent(), CTX as never)) as Response;

        expect(res.status).toBe(204);
        expect(mockDeleteNotification).toHaveBeenCalledOnce();
    });

    it('answers 404 — not 409 — for a row that is absent or owned by someone else', async () => {
        mockGetNotificationForUser.mockResolvedValue(null);

        const res = (await def.handlers.DELETE!(makeEvent(), CTX as never)) as Response;

        // 404 for both cases so the endpoint cannot be used to probe which ids
        // exist; the pin check must not turn that into a distinguishable 409.
        expect(res.status).toBe(404);
        expect(mockDeleteNotification).not.toHaveBeenCalled();
    });
});

describe('GET /api/v1/notifications/{id} — pin state on the wire', () => {
    it('carries pinnedAt for a pinned row', async () => {
        mockGetNotificationForUser.mockResolvedValue(
            row({ isPinned: true, pinnedAt: '2026-01-02T00:00:00.000Z' }),
        );

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const body = (await res.json()) as Record<string, unknown>;

        expect(body.pinnedAt).toBe('2026-01-02T00:00:00.000Z');
        // `isPinned` is the same fact and is NOT part of the declared schema —
        // emitting both would put an undeclared field on a validated response
        // and give clients two things to keep in sync.
        expect(body).not.toHaveProperty('isPinned');
    });

    it('omits pinnedAt entirely when the row is not pinned', async () => {
        mockGetNotificationForUser.mockResolvedValue(row());

        const res = (await def.handlers.GET!(makeEvent(), CTX as never)) as Response;
        const body = (await res.json()) as Record<string, unknown>;

        // Absent, not null: the schema declares it `.optional()`, and a null
        // would be a third state the contract does not define.
        expect(body).not.toHaveProperty('pinnedAt');
    });
});
