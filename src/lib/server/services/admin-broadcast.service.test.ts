// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the broadcast fan-out.
 *
 * Everything asserted here is a decision that is invisible in the happy path
 * and expensive to rediscover:
 *
 *  - the per-recipient publish is SEQUENTIAL (a `Promise.all` would drain the
 *    connection pool and overrun the shared 500-entry SSE replay buffer on a
 *    single admin action);
 *  - broadcasts NEVER expire (`ttlMs: null`), or a pinned announcement would
 *    silently age out from under its own pin;
 *  - the push opt-out is per-call and does not touch the kind taxonomy;
 *  - an unknown recipient FAILS the send rather than shrinking the audience;
 *  - no `coalesceKey` reaches the payload, which would cap an admin at one
 *    broadcast per user per UTC day via the existing unique index.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockPublishUserEvent = vi.fn();
const mockInsertBroadcast = vi.fn();
const mockListBroadcastRecipients = vi.fn();
const mockListBroadcastRecipientsByIds = vi.fn();
const mockAuditLog = vi.fn();

vi.mock('./notification-events.service.js', () => ({
    publishUserEvent: (...args: unknown[]) => mockPublishUserEvent(...args),
}));

vi.mock('$lib/server/database/queries/admin-broadcasts.queries.js', () => ({
    insertBroadcast: (...args: unknown[]) => mockInsertBroadcast(...args),
    listBroadcastRecipients: (...args: unknown[]) => mockListBroadcastRecipients(...args),
    listBroadcastRecipientsByIds: (...args: unknown[]) => mockListBroadcastRecipientsByIds(...args),
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: (...args: unknown[]) => mockAuditLog(...args),
}));

const { sendBroadcast, EVENT_KIND_ADMIN_BROADCAST } = await import('./admin-broadcast.service.js');

const BROADCAST_ID = '55555555-5555-4555-8555-555555555555';
const SQL = {} as never;

const RECIPIENTS = [
    { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', username: 'alice' },
    { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', username: 'bob' },
];

function broadcastRow(overrides: Record<string, unknown> = {}) {
    return {
        id: BROADCAST_ID,
        title: 'Maintenance on Sunday',
        body: null,
        audience: 'all',
        recipientCount: RECIPIENTS.length,
        pushEnabled: true,
        pinnedAt: null,
        pinnedBy: null,
        pinExpiresAt: null,
        isPinned: false,
        createdBy: 'admin',
        createdAt: '2026-01-01T00:00:00.000Z',
        ...overrides,
    };
}

// A PAT-attributed actor — distinct from `createdBy` ('admin', the DB
// column's plain username) so a test asserting on `actor` can't accidentally
// pass by matching the string `createdBy` also happens to carry.
const ACTOR = { username: 'admin', kind: 'pat' as const, credentialId: 'pat-7' };

const BASE = {
    title: 'Maintenance on Sunday',
    audience: 'all' as const,
    pinned: false,
    pushEnabled: true,
    createdBy: 'admin',
    actor: ACTOR,
};

beforeEach(() => {
    vi.clearAllMocks();
    mockListBroadcastRecipients.mockResolvedValue(RECIPIENTS);
    mockInsertBroadcast.mockResolvedValue(broadcastRow());
    // `'inserted'` — the durable row landed. The real function returns its
    // persist outcome, and the fan-out's delivery accounting reads it.
    mockPublishUserEvent.mockResolvedValue('inserted');
});

describe('sendBroadcast — fan-out', () => {
    it('publishes one durable event per recipient, with the broadcast id attached', async () => {
        const result = await sendBroadcast(SQL, BASE);

        expect(result.ok).toBe(true);
        expect(mockPublishUserEvent).toHaveBeenCalledTimes(RECIPIENTS.length);
        for (const recipient of RECIPIENTS) {
            expect(mockPublishUserEvent).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: recipient.id,
                    kind: EVENT_KIND_ADMIN_BROADCAST,
                    broadcastId: BROADCAST_ID,
                }),
            );
        }
    });

    it('emits the literal wire string the taxonomy advertises', () => {
        expect(EVENT_KIND_ADMIN_BROADCAST).toBe('admin.broadcast');
    });

    it('awaits each publish before starting the next', async () => {
        // A `Promise.all` fan-out would issue every INSERT, replay push,
        // pub/sub publish and outbox enqueue at once — draining the connection
        // pool and evicting every other user's frames from the SHARED,
        // bounded replay buffer on one admin action.
        let inFlight = 0;
        let maxInFlight = 0;
        mockPublishUserEvent.mockImplementation(async () => {
            inFlight++;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight--;
        });

        await sendBroadcast(SQL, BASE);

        expect(maxInFlight).toBe(1);
    });

    it('never expires the durable rows', async () => {
        await sendBroadcast(SQL, { ...BASE, pinned: true });

        // `null`, not `undefined`: undefined would fall through to the 30-day
        // default, and a pinned announcement that aged out would leave an empty
        // pinned block with nothing to explain it.
        expect(mockPublishUserEvent).toHaveBeenCalledWith(expect.objectContaining({ ttlMs: null }));
    });

    it('carries no coalesceKey — that would cap an admin at one broadcast a day', async () => {
        await sendBroadcast(SQL, BASE);

        const { data } = mockPublishUserEvent.mock.calls[0][0] as {
            data: Record<string, unknown>;
        };
        expect(data).not.toHaveProperty('coalesceKey');
        expect(data).toMatchObject({ broadcastId: BROADCAST_ID, title: BASE.title });
    });

    it('omits an absent body rather than sending an empty string', async () => {
        await sendBroadcast(SQL, BASE);
        const { data } = mockPublishUserEvent.mock.calls[0][0] as {
            data: Record<string, unknown>;
        };
        expect(data).not.toHaveProperty('body');
    });

    it('carries an attached link into every recipient payload', async () => {
        await sendBroadcast(SQL, { ...BASE, linkUrl: 'https://lumastra.org/release-notes' });

        // The presenter builds the row's `link` from this key on every read —
        // the parent `admin_broadcasts` row is never consulted at render time,
        // so a payload that loses it makes the announcement untappable.
        for (const call of mockPublishUserEvent.mock.calls) {
            const { data } = call[0] as { data: Record<string, unknown> };
            expect(data.linkUrl).toBe('https://lumastra.org/release-notes');
        }
    });

    it('omits linkUrl entirely for an announcement with no link', async () => {
        await sendBroadcast(SQL, BASE);
        const { data } = mockPublishUserEvent.mock.calls[0][0] as {
            data: Record<string, unknown>;
        };
        // Absent, not empty: `buildNotificationPresentation` reads presence, so
        // an empty string would be the difference between "no link" and a row
        // whose tap goes nowhere.
        expect(data).not.toHaveProperty('linkUrl');

        mockPublishUserEvent.mockClear();
        await sendBroadcast(SQL, { ...BASE, linkUrl: null });
        const second = mockPublishUserEvent.mock.calls[0][0] as { data: Record<string, unknown> };
        expect(second.data).not.toHaveProperty('linkUrl');
    });
});

describe('sendBroadcast — push opt-out', () => {
    it('skips push per call when the admin unticked it', async () => {
        await sendBroadcast(SQL, { ...BASE, pushEnabled: false });

        // Per-INVOCATION, not a taxonomy change: `PUSH_KINDS` answers "is this
        // kind the sort of thing that pushes" and must stay derived from the
        // notification class.
        expect(mockPublishUserEvent).toHaveBeenCalledWith(
            expect.objectContaining({ skipPush: true }),
        );
    });

    it('still writes the durable row and publishes when push is off', async () => {
        await sendBroadcast(SQL, { ...BASE, pushEnabled: false });

        // The admin declined a lock-screen interruption, not the message.
        expect(mockPublishUserEvent).toHaveBeenCalledTimes(RECIPIENTS.length);
        expect(mockInsertBroadcast).toHaveBeenCalledOnce();
    });

    it('sends push when enabled', async () => {
        await sendBroadcast(SQL, BASE);
        expect(mockPublishUserEvent).toHaveBeenCalledWith(
            expect.objectContaining({ skipPush: false }),
        );
    });
});

describe('sendBroadcast — recipient resolution', () => {
    it('fails the whole send when a selected user is unknown', async () => {
        mockListBroadcastRecipientsByIds.mockResolvedValue([RECIPIENTS[0]]);

        const result = await sendBroadcast(SQL, {
            ...BASE,
            audience: 'users',
            userIds: [RECIPIENTS[0].id, 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
        });

        // Delivering to the subset that resolved would leave an admin who
        // picked two people and reached one with no way to notice.
        expect(result).toEqual({
            ok: false,
            reason: 'unknown_recipients',
            unknownIds: ['cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
        });
        expect(mockInsertBroadcast).not.toHaveBeenCalled();
        expect(mockPublishUserEvent).not.toHaveBeenCalled();
    });

    it('treats a duplicated id as one recipient, not as an unknown one', async () => {
        mockListBroadcastRecipientsByIds.mockResolvedValue([RECIPIENTS[0]]);

        const result = await sendBroadcast(SQL, {
            ...BASE,
            audience: 'users',
            userIds: [RECIPIENTS[0].id, RECIPIENTS[0].id],
        });

        expect(result.ok).toBe(true);
        expect(mockPublishUserEvent).toHaveBeenCalledTimes(1);
    });

    it('refuses a send that would reach nobody', async () => {
        mockListBroadcastRecipients.mockResolvedValue([]);

        const result = await sendBroadcast(SQL, BASE);

        expect(result).toEqual({ ok: false, reason: 'no_recipients' });
        expect(mockInsertBroadcast).not.toHaveBeenCalled();
    });

    it('records the addressed count on the parent row', async () => {
        await sendBroadcast(SQL, BASE);

        // Who it was ADDRESSED to at send time — not how many copies survive
        // after recipients delete theirs.
        expect(mockInsertBroadcast).toHaveBeenCalledWith(
            SQL,
            expect.objectContaining({ recipientCount: RECIPIENTS.length }),
        );
    });
});

/**
 * Partial fan-out failures have to be VISIBLE.
 *
 * The loop is deliberately sequential and therefore slow, which makes the window
 * for a recipient to be deleted mid-send real rather than theoretical — and the
 * emitter logs that FK violation instead of raising it. Reporting only the
 * addressed count meant an admin who reached half their users was told the send
 * succeeded, with the shortfall visible nowhere.
 */
describe('sendBroadcast — delivery accounting', () => {
    it('reports every recipient delivered on an ordinary send', async () => {
        const result = await sendBroadcast(SQL, BASE);

        expect(result).toMatchObject({
            ok: true,
            deliveredCount: RECIPIENTS.length,
            failedCount: 0,
        });
    });

    it('counts a recipient whose durable insert failed', async () => {
        mockPublishUserEvent.mockResolvedValueOnce('failed').mockResolvedValueOnce('inserted');

        const result = await sendBroadcast(SQL, BASE);

        // Still `ok` — the announcement exists and the rest of the audience has
        // it, so this is a qualified success, not a failed send.
        expect(result).toMatchObject({ ok: true, deliveredCount: 1, failedCount: 1 });
    });

    it('does not abandon the remaining recipients when one throws', async () => {
        mockPublishUserEvent
            .mockRejectedValueOnce(new Error('connection terminated'))
            .mockResolvedValueOnce('inserted');

        const result = await sendBroadcast(SQL, BASE);

        // `publishUserEvent` does not throw by contract; a bug that made it
        // throw must degrade into a counted failure rather than stopping the
        // loop and silently dropping everyone after the first bad recipient.
        expect(mockPublishUserEvent).toHaveBeenCalledTimes(RECIPIENTS.length);
        expect(result).toMatchObject({ ok: true, deliveredCount: 1, failedCount: 1 });
    });

    it('counts a coalescing conflict as DELIVERED, not as a miss', async () => {
        mockPublishUserEvent.mockResolvedValue('conflict');

        const result = await sendBroadcast(SQL, BASE);

        // A conflict means a durable row for this notification already exists
        // and another writer owns its delivery — the recipient has it. Only
        // `'failed'` means nobody wrote one.
        expect(result).toMatchObject({
            ok: true,
            deliveredCount: RECIPIENTS.length,
            failedCount: 0,
        });
    });

    it('keeps the addressed count on the parent row when delivery degrades', async () => {
        mockPublishUserEvent.mockResolvedValue('failed');

        await sendBroadcast(SQL, BASE);

        // `recipient_count` records who it was ADDRESSED to and is written
        // before the fan-out. The delivered/failed split is the separate fact.
        expect(mockInsertBroadcast).toHaveBeenCalledWith(
            SQL,
            expect.objectContaining({ recipientCount: RECIPIENTS.length }),
        );
    });
});

describe('sendBroadcast — audit trail', () => {
    it('audits the send with the full actor object (credential-attributed, not a bare username)', async () => {
        await sendBroadcast(SQL, { ...BASE, pinned: true });

        // R5: the audit row must carry WHICH credential sent this (kind +
        // credentialId), not just the username `createdBy` stores in the DB
        // column — so the actor passed to auditLog() is the object, not the
        // bare 'admin' string.
        expect(mockAuditLog).toHaveBeenCalledWith(
            'notification.broadcast.send',
            BROADCAST_ID,
            ACTOR,
            expect.objectContaining({
                audience: 'all',
                recipientCount: RECIPIENTS.length,
                pinned: true,
            }),
        );
    });

    it('records the delivered/failed split, not just the addressed count', async () => {
        mockPublishUserEvent.mockResolvedValueOnce('failed').mockResolvedValueOnce('inserted');

        await sendBroadcast(SQL, BASE);

        // In the audit record rather than only in a log line: an operator
        // reconstructing "I never got the announcement" months later needs the
        // shortfall from something durable.
        expect(mockAuditLog).toHaveBeenCalledWith(
            'notification.broadcast.send',
            BROADCAST_ID,
            ACTOR,
            expect.objectContaining({ deliveredCount: 1, failedCount: 1 }),
        );
    });

    it('does not audit a refused send', async () => {
        mockListBroadcastRecipients.mockResolvedValue([]);
        await sendBroadcast(SQL, BASE);
        expect(mockAuditLog).not.toHaveBeenCalled();
    });
});
