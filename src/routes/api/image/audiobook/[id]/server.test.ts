// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    sql: vi.fn(),
    lookup: vi.fn(),
    access: vi.fn(),
    cover: vi.fn(),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: () => mocks.sql }));
vi.mock('$lib/server/database/queries/external-ids.queries.js', () => ({
    findMediaIdByProviderExternalId: mocks.lookup,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: mocks.access }));
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({ getAudiobookImage: mocks.cover }),
    imageResponse: () => new Response('cover'),
}));
vi.mock('$lib/server/middleware/valkey-rate-limit', () => ({
    withImageProxyRateLimit: (handler: unknown) => handler,
}));
import { GET } from './+server';

function event(user?: object): Parameters<typeof GET>[0] {
    return {
        url: new URL('http://localhost/api/image/audiobook/abs-book-opaque-id'),
        params: { id: 'abs-book-opaque-id' },
        locals: { user },
        request: new Request('http://localhost/api/image/audiobook/abs-book-opaque-id'),
    } as unknown as Parameters<typeof GET>[0];
}
const viewer = { ownerIsAdmin: false, userId: 'kid', isAgeRestricted: true, maxAgeRating: 12 };
beforeEach(() => {
    vi.clearAllMocks();
    mocks.lookup.mockResolvedValue('00000000-0000-4000-8000-000000000001');
    mocks.access.mockResolvedValue(true);
    mocks.cover.mockResolvedValue({ buffer: Buffer.from('cover'), contentType: 'image/jpeg' });
});
describe('ABS cover object authorization', () => {
    it.each(['library', 'age', 'retired'])(
        'returns 404 before fetching a cover denied by %s',
        async () => {
            mocks.access.mockResolvedValue(false);
            const response = await GET(event(viewer));
            expect(response.status).toBe(404);
            expect(mocks.lookup).toHaveBeenCalledWith(mocks.sql, {
                provider: 'audiobookshelf',
                externalId: 'abs-book-opaque-id',
                mediaType: 'audiobook',
            });
            expect(mocks.access).toHaveBeenCalledWith(
                mocks.sql,
                '00000000-0000-4000-8000-000000000001',
                viewer,
            );
            expect(mocks.cover).not.toHaveBeenCalled();
        },
    );
    it('returns 404 when the ABS id has no local audiobook identity', async () => {
        mocks.lookup.mockResolvedValue(null);
        expect((await GET(event(viewer))).status).toBe(404);
        expect(mocks.cover).not.toHaveBeenCalled();
    });
    it('serves an admitted authenticated cover', async () => {
        expect((await GET(event(viewer))).status).toBe(200);
        expect(mocks.access).toHaveBeenCalled();
    });
    it('preserves the anonymous artwork behavior handled by the surrounding route policy', async () => {
        expect((await GET(event())).status).toBe(200);
        expect(mocks.lookup).not.toHaveBeenCalled();
    });
    it('preserves the admin artwork bypass', async () => {
        expect((await GET(event({ ownerIsAdmin: true, mediaAccessIsAdmin: true }))).status).toBe(
            200,
        );
        expect(mocks.lookup).not.toHaveBeenCalled();
    });
    it('does not restore the bypass for a scoped admin credential', async () => {
        mocks.access.mockResolvedValue(false);
        expect(
            (await GET(event({ ...viewer, ownerIsAdmin: true, mediaAccessIsAdmin: false }))).status,
        ).toBe(404);
    });
});

// The existing gates above must still run before any cached upstream miss.
describe('ABS cover not found response', () => {
    it.each([undefined, viewer, { ownerIsAdmin: true, mediaAccessIsAdmin: true }])(
        'returns a clean 404 when no cover is available for viewer %j',
        async (user) => {
            mocks.cover.mockResolvedValue(null);
            const response = await GET(event(user));
            expect(response.status).toBe(404);
            expect(await response.text()).toBe('Image not found');
        },
    );
});
