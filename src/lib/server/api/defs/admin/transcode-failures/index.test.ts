// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * DELETE /api/admin/transcode-failures: a scoped clear never widens to the whole
 * bucket, and every clear is attributed in the admin audit log.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
const deleteFailureIncidents = vi.fn(async (_sql: unknown, _opts: unknown) => 4);
const listFailureIncidents = vi.fn(async (_sql: unknown, _opts: unknown) => ({
    rows: [] as unknown[],
    totalGroups: 0,
}));
vi.mock('$lib/server/database/queries/transcode-failure-events.queries.js', () => ({
    listFailureIncidents,
    deleteFailureIncidents,
    FAILED_OUTCOMES: ['failed'],
    RECOVERED_OUTCOMES: ['recovered'],
}));
const auditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog,
    auditActor: () => ({ username: 'admin' }),
}));

const { def } = await import('./index.js');

const event = {} as RequestEvent;
const del = (query: Record<string, unknown>) =>
    def.handlers.DELETE!(event, { input: { query: { outcome: 'failed', ...query } } } as never);

beforeEach(() => vi.clearAllMocks());

describe('DELETE /api/admin/transcode-failures', () => {
    it('rejects cutoffs finer than PostgreSQL microseconds instead of rounding up', () => {
        expect(
            def.request!.query!.safeParse({
                before: '2026-10-07T10:00:00.1234569Z',
            }).success,
        ).toBe(false);
        expect(
            def.request!.query!.parse({
                before: '2026-10-07T12:00:00.123456+02:00',
            }).before,
        ).toBe('2026-10-07T12:00:00.123456+02:00');
    });
    it('refuses an encoder without a category instead of clearing the whole bucket', async () => {
        const res = await del({ encoder: 'hevc_qsv' });
        expect(res.status).toBe(422);
        expect(deleteFailureIncidents).not.toHaveBeenCalled();
        expect(auditLog).not.toHaveBeenCalled();
    });

    it('a scoped clear deletes that group and is audited', async () => {
        const res = await del({ category: 'gpu-failure', encoder: 'software' });
        expect(res.status).toBe(200);
        expect(deleteFailureIncidents).toHaveBeenCalledWith(expect.anything(), {
            outcomes: ['failed'],
            category: 'gpu-failure',
            encoder: null,
            before: undefined,
        });
        expect(auditLog).toHaveBeenCalledWith(
            'transcode_failures.clear',
            'gpu-failure',
            { username: 'admin' },
            expect.objectContaining({ cleared: 4, encoder: 'software' }),
        );
    });

    it('a clear-all is audited against "all"', async () => {
        await del({});
        expect(auditLog).toHaveBeenCalledWith(
            'transcode_failures.clear',
            'all',
            { username: 'admin' },
            expect.objectContaining({ category: null }),
        );
    });

    it('passes the screen bound through so newer failures are not cleared unseen', async () => {
        await del({ before: '2026-10-07T10:00:00.123456Z' });
        expect(deleteFailureIncidents).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ before: '2026-10-07T10:00:00.123456Z' }),
        );
        expect(auditLog).toHaveBeenCalledWith(
            'transcode_failures.clear',
            'all',
            { username: 'admin' },
            expect.objectContaining({ before: '2026-10-07T10:00:00.123456Z' }),
        );
    });
});

describe('GET /api/admin/transcode-failures', () => {
    const get = (query: Record<string, unknown>) =>
        def.handlers.GET!(event, { input: { query: { outcome: 'failed', ...query } } } as never);

    it('preserves the exact timestamp used to clear the newest event', async () => {
        listFailureIncidents.mockResolvedValueOnce({
            rows: [
                {
                    category: 'gpu-failure',
                    encoder: null,
                    occurrences: '1',
                    distinct_files: '0',
                    distinct_sessions: '1',
                    first_seen: new Date('2026-10-07T10:00:00.123Z'),
                    last_seen: '2026-10-07T10:00:00.123456Z',
                },
            ],
            totalGroups: 1,
        });
        const body = await (await get({})).json();
        expect(body.incidents[0].lastSeen).toBe('2026-10-07T10:00:00.123456Z');
        const params = new URLSearchParams({ before: body.incidents[0].lastSeen });
        const query = def.request!.query!.parse(Object.fromEntries(params));
        await del(query);
        expect(deleteFailureIncidents).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ before: '2026-10-07T10:00:00.123456Z' }),
        );
    });

    it('says when the list is truncated', async () => {
        listFailureIncidents.mockResolvedValueOnce({ rows: [], totalGroups: 140 });
        const body = await (await get({})).json();
        expect(body).toMatchObject({ truncated: true, totalGroups: 140 });
    });

    it('filters by encoder server-side, software meaning NULL', async () => {
        await get({ encoder: 'software' });
        expect(listFailureIncidents).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ encoder: null }),
        );
        await get({ encoder: 'hevc_qsv' });
        expect(listFailureIncidents).toHaveBeenLastCalledWith(
            expect.anything(),
            expect.objectContaining({ encoder: 'hevc_qsv' }),
        );
    });
});
