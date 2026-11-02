// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notifications/{id}/image — the forwarded-notification artwork route.
 *
 * Pins the signature SCOPE: the route verifies purpose `notification-image`
 * (never `push-image`), refuses before reading anything when the signature
 * fails, and serves only after it passes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    verifySignedUrl: vi.fn(),
    getDb: vi.fn(),
    getNotificationById: vi.fn(),
    resolvePushImageTarget: vi.fn(),
    getImageByCatalogId: vi.fn(),
}));

vi.mock('$lib/server/utils/signed-url.js', () => ({
    verifySignedUrl: mocks.verifySignedUrl,
    signUrl: vi.fn(),
}));
vi.mock('$lib/server/database/index.js', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/database/queries/user-notifications.queries.js', () => ({
    getNotificationById: mocks.getNotificationById,
}));
vi.mock('$lib/server/services/push/push-rich-content.js', () => ({
    resolvePushImageTarget: mocks.resolvePushImageTarget,
    PUSH_IMAGE_URL_PURPOSE: 'push-image',
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ getImageByCatalogId: mocks.getImageByCatalogId }),
    imageResponse: () => new Response('img', { headers: { 'Content-Type': 'image/jpeg' } }),
}));

import { def } from './image.js';

const ID = '8f2b1c34-5d6e-4a7b-8c9d-0e1f2a3b4c5d';

function event(): RequestEvent {
    const url = new URL(
        `http://localhost/api/v1/notifications/${ID}/image?expires=1&purpose=x&sig=y`,
    );
    return {
        url,
        params: { id: ID },
        request: new Request(url),
        locals: {},
    } as unknown as RequestEvent;
}

const GET = def.handlers.GET!;

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.getNotificationById.mockResolvedValue({ kind: 'library.new_episode', payload: {} });
    mocks.resolvePushImageTarget.mockResolvedValue({ mediaId: 'm1', role: 'thumb' });
    mocks.getImageByCatalogId.mockResolvedValue({ buffer: Buffer.from('x') });
});

describe('GET notifications/{id}/image', () => {
    it('verifies the notification-image purpose, not push-image', async () => {
        mocks.verifySignedUrl.mockReturnValue({ valid: true });
        const res = await GET(event(), {} as never);
        expect(res.status).toBe(200);
        expect(mocks.verifySignedUrl).toHaveBeenCalledWith(expect.any(URL), 'notification-image');
        expect(mocks.getImageByCatalogId).toHaveBeenCalledWith('m1', 'thumb', {
            size: 'hd',
            format: 'jpg',
        });
    });

    it('refuses an invalid signature before reading the notification', async () => {
        mocks.verifySignedUrl.mockReturnValue({ valid: false, reason: 'purpose_mismatch' });
        const res = await GET(event(), {} as never);
        expect(res.status).toBe(403);
        expect(mocks.getNotificationById).not.toHaveBeenCalled();
    });

    it('answers 404 when the notification has no artwork', async () => {
        mocks.verifySignedUrl.mockReturnValue({ valid: true });
        mocks.resolvePushImageTarget.mockResolvedValueOnce(null);
        expect((await GET(event(), {} as never)).status).toBe(404);
    });
});
