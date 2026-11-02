// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-gate contract for GET /api/v1/notifications (E1 row #25).
 *
 * The gate ENFORCES the documented pagination contract: `limit` is bounded to
 * [1, 100] and `unread` is the boolean enum {true,false}. Previously the gate
 * accepted any string/int and the handler silently clamped — an out-of-range
 * `limit` now yields a 422 at mount() instead.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    listNotifications: vi.fn(),
    countUnread: vi.fn(),
    markAllRead: vi.fn(),
}));

const { def } = await import('./index.js');
const query = def.request!.query!;

describe('GET /api/v1/notifications — query gate', () => {
    it('accepts limit within [1, 100]', () => {
        expect(query.safeParse({ limit: '1' }).success).toBe(true);
        expect(query.safeParse({ limit: '100' }).success).toBe(true);
        expect(query.safeParse({ limit: '50' }).success).toBe(true);
    });

    it('rejects limit > 100 (was silently clamped, now 422)', () => {
        expect(query.safeParse({ limit: '101' }).success).toBe(false);
        expect(query.safeParse({ limit: '1000' }).success).toBe(false);
    });

    it('rejects limit < 1', () => {
        expect(query.safeParse({ limit: '0' }).success).toBe(false);
        expect(query.safeParse({ limit: '-5' }).success).toBe(false);
    });

    it('accepts the unread boolean enum only', () => {
        expect(query.safeParse({ unread: 'true' }).success).toBe(true);
        expect(query.safeParse({ unread: 'false' }).success).toBe(true);
        expect(query.safeParse({ unread: '1' }).success).toBe(false);
        expect(query.safeParse({ unread: 'yes' }).success).toBe(false);
    });

    it('treats all params as optional (empty query is valid)', () => {
        expect(query.safeParse({}).success).toBe(true);
    });

    it('accepts cursor and since as non-empty strings', () => {
        // Shape only — the CONTENTS are validated in the handler so each can
        // answer 422 with a field-specific message.
        expect(query.safeParse({ cursor: 'eyJ0IjoiIn0' }).success).toBe(true);
        expect(query.safeParse({ since: '2026-01-01T00:00:00.000Z' }).success).toBe(true);
        expect(query.safeParse({ cursor: '' }).success).toBe(false);
        expect(query.safeParse({ since: '' }).success).toBe(false);
    });

    it('no longer accepts the retired `before` param as a cursor', () => {
        // `before` is stripped, not rejected (schemas here are lenient by
        // convention), so what matters is that it does not survive into the
        // parsed input and silently paginate.
        const parsed = query.parse({ before: '2026-01-01T00:00:00.000Z' });
        expect(parsed).not.toHaveProperty('before');
    });
});
