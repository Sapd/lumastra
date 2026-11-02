// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `adminStatus.ack()` patches the payload optimistically. A second ack of the
 * same item (double click, or the bell and the list both firing) decremented
 * the unread count again, so the bell read lower than the real number until
 * the next refresh.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AdminStatusPayload } from '$lib/schemas/api-admin-status-payload';

const mockGetPayload = vi.fn();
const mockAck = vi.fn();
vi.mock('$lib/api/admin.js', () => ({
    getAdminStatusPayload: () => mockGetPayload(),
    ackAttentionItem: (...a: unknown[]) => mockAck(...a),
    snoozeAttentionItem: vi.fn(),
}));

const { adminStatus } = await import('./admin-status.store.svelte');

function payload(unreadCount: number): AdminStatusPayload {
    return {
        attention: {
            items: [
                {
                    id: 'a',
                    fingerprint: 'fp-a',
                    type: 'degraded-component',
                    severity: 'warning',
                    title: 'A',
                    actions: [],
                    firstSeen: '2026-01-01T00:00:00Z',
                    lastSeen: '2026-01-01T00:00:00Z',
                    acked: false,
                },
            ],
            unreadCount,
            unavailable: false,
        },
        sectionStatus: {},
    } as unknown as AdminStatusPayload;
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe('adminStatus.ack', () => {
    it('decrements the unread count once, however often the same item is acked', async () => {
        mockGetPayload.mockResolvedValue({ data: payload(3), error: null, status: 200 });
        await adminStatus.refresh();
        // Hold the refresh after the ack so the optimistic patch stays visible.
        mockGetPayload.mockReturnValue(new Promise(() => {}));
        mockAck.mockResolvedValue({ data: { ok: true } });

        void adminStatus.ack('a');
        void adminStatus.ack('a');
        await Promise.resolve();

        expect(adminStatus.payload?.attention.unreadCount).toBe(2);
        expect(mockAck).toHaveBeenCalledTimes(1);
    });
});
