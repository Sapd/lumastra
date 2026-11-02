// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST /api/admin/watch-events/repudiate, found broken 2026-10-06:
 *   - the Jellyfin unmark resolved the Jellyfin user from a USERNAME resolver
 *     handed a users.id UUID, so every unmark failed and the next pull
 *     re-imported the cascade;
 *   - an item without a Jellyfin id was counted as skipped AND succeeded;
 *   - nothing reached the audit trail.
 * The ISO bound format the page sends is pinned in the query integration test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { ApiContext } from '$lib/server/api/define.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';

const externalIdRows = [{ media_id: 'm-1', external_id: 'jf-item-1' }];
const sqlTag = Object.assign(
    vi.fn(async () => externalIdRows),
    { begin: vi.fn(async (fn: (tx: unknown) => Promise<void>) => fn({})) },
);
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => sqlTag }));

const mockRepudiateEvents = vi.fn();
const mockGetUnmarkMedia = vi.fn();
vi.mock('$lib/server/database/queries/user-media-events.queries.js', () => ({
    repudiateEvents: (...a: unknown[]) => mockRepudiateEvents(...a),
    getRepudiatedUnwatchedMediaIds: (...a: unknown[]) => mockGetUnmarkMedia(...a),
}));
vi.mock('$lib/server/services/watch-state-rebuilder.service.js', () => ({
    rebuildAllStatesForUser: vi.fn(async () => 2),
}));
const mockResolveById = vi.fn();
vi.mock('$lib/server/services/jellyfin-user-id-resolver.js', () => ({
    resolveJellyfinUserIdByUserId: (...a: unknown[]) => mockResolveById(...a),
}));
const mockAxiosDelete = vi.fn();
vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: {
        getAxiosInstance: () => ({ delete: (...a: unknown[]) => mockAxiosDelete(...a) }),
        getBaseUrl: () => 'http://jf',
        getApiToken: () => 'tok',
    },
}));
const mockAuditLog = vi.fn();
vi.mock('$lib/server/utils/audit-log.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/utils/audit-log.js')>();
    return { ...actual, auditLog: (...a: unknown[]) => mockAuditLog(...a) };
});

import { def } from './repudiate.js';

async function post(body: Record<string, unknown>): Promise<Response> {
    const event = {
        request: new Request('http://localhost/api/admin/watch-events/repudiate', {
            method: 'POST',
        }),
        url: new URL('http://localhost/api/admin/watch-events/repudiate'),
        params: {},
        locals: { user: { username: 'root', ownerIsAdmin: true } },
    } as unknown as RequestEvent;
    return def.handlers.POST!(event, {
        surface: 'internal',
        input: { body },
    } as unknown as ApiContext);
}

const body = {
    userId: USER_ID,
    source: 'jellyfin-sync',
    fromTs: '2026-10-06T12:00:00.100000Z',
    toTs: '2026-10-06T12:00:00.999000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    mockRepudiateEvents.mockResolvedValue({ count: 2, mediaIds: ['m-1', 'm-2'] });
    mockGetUnmarkMedia.mockResolvedValue(['m-1', 'm-2']);
    mockResolveById.mockResolvedValue('jf-user-1');
    mockAxiosDelete.mockResolvedValue({});
});

describe('POST /api/admin/watch-events/repudiate', () => {
    it('accepts the ISO bounds the bulk-window query now emits', () => {
        const parsed = def.request!.body!.safeParse(body);
        expect(parsed.success).toBe(true);
    });

    it('resolves the Jellyfin user by users.id and unmarks only items with a Jellyfin id', async () => {
        const res = await post(body);
        expect(res.status).toBe(200);
        expect(mockResolveById).toHaveBeenCalledWith(USER_ID);
        expect(mockAxiosDelete).toHaveBeenCalledTimes(1);
        expect(mockAxiosDelete.mock.calls[0][1]).toEqual({
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="tok"$/,
                ),
            },
        });
        expect(mockAxiosDelete.mock.calls[0][0]).toBe(
            'http://jf/Users/jf-user-1/PlayedItems/jf-item-1',
        );

        const json = (await res.json()) as { jellyfinUnmark: Record<string, number> };
        // m-2 has no Jellyfin id: skipped, not also counted as succeeded.
        expect(json.jellyfinUnmark).toEqual({
            attempted: 2,
            succeeded: 1,
            failed: 0,
            skippedNoExternalId: 1,
        });
    });

    it('retries the unmark when nothing is newly repudiated', async () => {
        mockRepudiateEvents.mockResolvedValue({ count: 0, mediaIds: [] });
        const res = await post(body);
        expect(res.status).toBe(200);
        expect(mockGetUnmarkMedia).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: USER_ID, source: 'jellyfin-sync' }),
        );
        expect(mockAxiosDelete).toHaveBeenCalledTimes(1);
        expect(mockAxiosDelete.mock.calls[0][1]).toEqual({
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="tok"$/,
                ),
            },
        });
        expect(await res.json()).toEqual({
            repudiated: 0,
            rebuildCount: 2,
            jellyfinUnmark: { attempted: 2, succeeded: 1, failed: 0, skippedNoExternalId: 1 },
        });
    });

    it('does not unmark media the user has watched again (query excludes them)', async () => {
        mockGetUnmarkMedia.mockResolvedValue(['m-1']);
        const res = await post(body);
        const json = (await res.json()) as { jellyfinUnmark: { attempted: number } };
        expect(json.jellyfinUnmark.attempted).toBe(1);
        expect(mockAxiosDelete).toHaveBeenCalledTimes(1);
        expect(mockAxiosDelete.mock.calls[0][1]).toEqual({
            headers: {
                Authorization: expect.stringMatching(
                    /^MediaBrowser Client="Lumastra", .*Token="tok"$/,
                ),
            },
        });
    });

    it('leaves jellyfinUnmark null when no media remain to unmark', async () => {
        mockGetUnmarkMedia.mockResolvedValue([]);
        const res = await post(body);
        expect((await res.json()) as unknown).toMatchObject({ jellyfinUnmark: null });
        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it('does not query or unmark for alsoUnmarkOnSource: false', async () => {
        await post({ ...body, alsoUnmarkOnSource: false });
        expect(mockGetUnmarkMedia).not.toHaveBeenCalled();
        expect(mockAxiosDelete).not.toHaveBeenCalled();
    });

    it('writes an audit row naming the user and the window', async () => {
        await post(body);
        expect(mockAuditLog).toHaveBeenCalledWith(
            'watch_events.repudiate',
            USER_ID,
            expect.anything(),
            expect.objectContaining({ source: 'jellyfin-sync', repudiated: 2 }),
        );
    });

    it('rejects a reversed window even when the offsets differ', async () => {
        const res = await post({
            ...body,
            fromTs: '2026-10-06T14:00:00+02:00',
            toTs: '2026-10-06T11:30:00Z',
        });
        expect(res.status).toBe(422);
        expect(mockRepudiateEvents).not.toHaveBeenCalled();
    });
});
