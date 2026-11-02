// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mockGetCoverCollage = vi.fn();
const mockCheckMediaAccessBatch = vi.fn();
const mockGetDb = vi.fn();

vi.mock('$lib/server/services/music/cover-collage.service.js', () => ({
    getCoverCollage: (...args: unknown[]) => mockGetCoverCollage(...args),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: async (_sql: unknown, id: string) =>
        (await mockCheckMediaAccessBatch(_sql, [id])).has(id),
    checkMediaAccessBatch: (...args: unknown[]) => mockCheckMediaAccessBatch(...args),
}));
vi.mock('$lib/server/database/index.js', () => ({
    getDb: () => mockGetDb(),
}));

const { def } = await import('./collage.js');

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const REVISION = '0123456789abcdef';

function makeEvent(
    query: string,
    opts: { user?: Record<string, unknown> | null; bearer?: boolean } = {},
): RequestEvent {
    const url = `http://localhost/api/v1/music/images/collage${query}`;
    const headers: Record<string, string> = {};
    if (opts.bearer) headers.Authorization = 'Bearer pat';
    return {
        locals: {
            user: opts.user === undefined ? { userId: 'u1', isAdmin: false } : opts.user,
            authMethod: opts.bearer ? 'pat' : undefined,
        },
        url: new URL(url),
        params: {},
        request: new Request(url, { headers }),
    } as unknown as RequestEvent;
}

const ctx = { surface: 'v1' } as never;
const ok = { buffer: Buffer.from('webp'), contentType: 'image/webp', etag: '"cc-1"' };

describe('music/images/collage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue({});
        mockCheckMediaAccessBatch.mockImplementation(
            async (_sql: unknown, ids: string[]) => new Set(ids),
        );
        mockGetCoverCollage.mockResolvedValue(ok);
    });

    it('renders the requested ids at the requested size', async () => {
        const res = await def.handlers.GET!(makeEvent(`?ids=${A},${B}&size=thumb`), ctx);
        expect(res.status).toBe(200);
        expect(res.headers.get('Content-Type')).toBe('image/webp');
        expect(res.headers.get('Cache-Control')).toBe(
            'private, max-age=3600, stale-while-revalidate=86400',
        );
        expect(res.headers.get('Vary')).toBe('Accept, Save-Data, Authorization, Cookie');
        expect(mockGetCoverCollage).toHaveBeenCalledWith([A, B], 'thumb', undefined);
    });

    it.each([
        '',
        'random-value',
        'a'.repeat(15),
        'a'.repeat(17),
        '0123456789abcdeg',
        '0123456789ABCDEF',
        '0123456789abcdef\n',
        '0123456789abcdef/extra',
    ])('ignores invalid revision %j as an unversioned request', async (revision) => {
        const plain = await def.handlers.GET!(makeEvent(`?ids=${A}`), ctx);
        const response = await def.handlers.GET!(
            makeEvent(`?ids=${A}&v=${encodeURIComponent(revision)}`),
            ctx,
        );
        expect(response.status).toBe(200);
        expect(mockGetCoverCollage).toHaveBeenNthCalledWith(1, [A], 'card', undefined);
        expect(mockGetCoverCollage).toHaveBeenNthCalledWith(2, [A], 'card', undefined);
        expect(response.headers.get('cache-control')).toBe(plain.headers.get('cache-control'));
    });

    it('defaults to card and de-duplicates ids', async () => {
        await def.handlers.GET!(makeEvent(`?ids=${A},${A},${B}`), ctx);
        expect(mockGetCoverCollage).toHaveBeenCalledWith([A, B], 'card', undefined);
    });

    it.each([
        ['missing ids', ''],
        ['empty ids', '?ids='],
        ['non-uuid id', `?ids=${A},tmdb:603:movie`],
        [
            'too many ids',
            `?ids=${Array.from({ length: 9 }, (_, i) => `${A.slice(0, -1)}${i}`).join(',')}`,
        ],
        ['bad size', `?ids=${A}&size=huge`],
    ])('rejects %s with a validation error', async (_label, query) => {
        const res = await def.handlers.GET!(makeEvent(query), ctx);
        expect(res.status).toBe(422);
        expect(mockGetCoverCollage).not.toHaveBeenCalled();
    });

    it('drops ids the signed-in caller cannot access, keeping order', async () => {
        mockCheckMediaAccessBatch.mockImplementation(
            async (_sql: unknown, ids: string[]) => new Set(ids.filter((id) => id !== B)),
        );
        await def.handlers.GET!(makeEvent(`?ids=${A},${B},${C}`), ctx);
        expect(mockCheckMediaAccessBatch).toHaveBeenCalledTimes(1);
        expect(mockCheckMediaAccessBatch).toHaveBeenCalledWith({}, [A, B, C], expect.anything());
        expect(mockCheckMediaAccessBatch.mock.invocationCallOrder[0]).toBeLessThan(
            mockGetCoverCollage.mock.invocationCallOrder[0],
        );
        expect(mockGetCoverCollage).toHaveBeenCalledWith([A, C], 'card', undefined);
    });

    it('answers a fully denied list like a missing image, without rendering', async () => {
        mockCheckMediaAccessBatch.mockResolvedValue(new Set());
        const res = await def.handlers.GET!(makeEvent(`?ids=${A}`, { bearer: true }), ctx);
        expect(res.status).toBe(404);
        expect(res.headers.get('X-Lumastra-Placeholder')).toBe('1');
        expect(mockGetCoverCollage).not.toHaveBeenCalled();
    });

    it('serves anonymous requests without an access check (artwork only)', async () => {
        const res = await def.handlers.GET!(makeEvent(`?ids=${A}`, { user: null }), ctx);
        expect(res.status).toBe(200);
        expect(mockCheckMediaAccessBatch).not.toHaveBeenCalled();
    });

    it('fails closed with 503 when the access gate cannot run for a non-admin', async () => {
        mockGetDb.mockReturnValue(null);
        const res = await def.handlers.GET!(makeEvent(`?ids=${A}`), ctx);
        expect(res.status).toBe(503);
        expect(mockGetCoverCollage).not.toHaveBeenCalled();
    });

    it('returns 404 for native clients when nothing renders', async () => {
        mockGetCoverCollage.mockResolvedValue(null);
        const res = await def.handlers.GET!(makeEvent(`?ids=${A}`, { bearer: true }), ctx);
        expect(res.status).toBe(404);
    });

    it('answers a matching If-None-Match with 304', async () => {
        const event = makeEvent(`?ids=${A}`);
        const req = new Request(event.url, { headers: { 'If-None-Match': '"cc-1"' } });
        const res = await def.handlers.GET!({ ...event, request: req } as RequestEvent, ctx);
        expect(res.status).toBe(304);
    });
});

it.each(['thumb', 'card', 'full'])(
    'only revisioned bounded collages are immutable (%s)',
    async (size) => {
        mockGetDb.mockReturnValue({});
        mockCheckMediaAccessBatch.mockImplementation(
            async (_sql: unknown, ids: string[]) => new Set(ids),
        );
        mockGetCoverCollage.mockResolvedValue(ok);
        const response = await def.handlers.GET!(
            makeEvent(`?ids=${A}&size=${size}&v=${REVISION}`),
            ctx,
        );
        expect(response.headers.get('cache-control')).toBe(
            'private, max-age=86400, stale-while-revalidate=86400, immutable',
        );
        expect(response.headers.get('vary')).toBe('Accept, Save-Data, Authorization, Cookie');
    },
);

it('passes the server-format URL revision to the disk cache', async () => {
    await def.handlers.GET!(makeEvent(`?ids=${A}&v=${REVISION}`), ctx);
    expect(mockGetCoverCollage).toHaveBeenCalledWith([A], 'card', REVISION);
});
