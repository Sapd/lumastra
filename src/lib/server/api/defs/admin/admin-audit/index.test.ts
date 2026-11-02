// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An unparseable `since`/`until` is a 422. It used to be dropped silently, so a
 * CSV export the caller believed was bounded returned the whole log.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
const listAdminAuditFeed = vi.fn(async () => ({ events: [], nextCursor: null }));
const streamAdminAuditExport = vi.fn(async () => []);
vi.mock('$lib/server/database/queries/admin-audit.queries.js', () => ({
    listAdminAuditFeed,
    streamAdminAuditExport,
}));

const { def } = await import('./index.js');

function call(query: Record<string, unknown>) {
    const event = {
        url: new URL('http://localhost/api/admin/admin-audit'),
    } as unknown as RequestEvent;
    return def.handlers.GET!(event, { input: { query: { limit: 50, ...query } } } as never);
}

beforeEach(() => vi.clearAllMocks());

describe('GET /api/admin/admin-audit — date bounds', () => {
    it.each([
        ['since', { since: 'last tuesday' }],
        ['until', { until: '2026-13-45' }],
        ['since on a CSV export', { since: 'yesterday', format: 'csv' }],
    ])('rejects an invalid %s', async (_label, query) => {
        const res = await call(query);
        expect(res.status).toBe(422);
        expect(listAdminAuditFeed).not.toHaveBeenCalled();
        expect(streamAdminAuditExport).not.toHaveBeenCalled();
    });

    it('passes valid bounds through', async () => {
        const res = await call({ since: '2026-10-01T00:00:00Z', until: '2026-10-02T00:00:00Z' });
        expect(res.status).toBe(200);
        expect(listAdminAuditFeed).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                since: new Date('2026-10-01T00:00:00Z'),
                until: new Date('2026-10-02T00:00:00Z'),
            }),
        );
    });
});
