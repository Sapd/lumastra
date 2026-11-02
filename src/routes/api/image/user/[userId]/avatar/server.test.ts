// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PUT /api/image/user/{username}/avatar — the upload the web settings page
 * and the admin user drawer call. Real multipart bodies and real sharp; only
 * the DB and the avatar cache are stubbed.
 *
 * Regression: an avatar over adapter-node's 512K BODY_SIZE_LIMIT default made
 * `request.formData()` reject with a SvelteKitError (`status` 413), which
 * withErrorHandler turned into a 500 although the UI promises 2 MB.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    makeImageOfSize,
    type TestImageFormat,
} from '../../../../../../../tests/helpers/sized-test-image';
import { pixelBombPng } from '../../../../../../../tests/helpers/pixel-bomb-png';

const setUserAvatar = vi.fn(async () => true);
const invalidateAvatarCache = vi.fn(async () => undefined);

vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: vi.fn(async (_db: unknown, username: string) => ({ username })),
    setUserAvatar,
    deleteUserAvatar: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({ invalidateAvatarCache }),
    imageResponse: vi.fn(),
}));
vi.mock('$lib/server/utils/image-proxy', () => ({ parseQualityParam: vi.fn() }));

const { PUT } = await import('./+server');

const KiB = 1024;
const MiB = 1024 * 1024;

function putEvent(request: Request, username = 'alice'): Parameters<typeof PUT>[0] {
    return {
        request,
        params: { userId: username },
        url: new URL(request.url),
        route: { id: '/api/image/user/[userId]/avatar' },
        locals: { user: { username, ownerIsAdmin: false } },
    } as unknown as Parameters<typeof PUT>[0];
}

function uploadRequest(file: Buffer, mime: string): Request {
    const form = new FormData();
    form.append('avatar', new Blob([new Uint8Array(file)], { type: mime }), 'avatar');
    return new Request('http://localhost/api/image/user/alice/avatar', {
        method: 'PUT',
        body: form,
    });
}

beforeEach(() => {
    setUserAvatar.mockClear();
});

describe('PUT /api/image/user/{username}/avatar — size limits', () => {
    const formats: Array<[TestImageFormat, string]> = [
        ['jpeg', 'image/jpeg'],
        ['png', 'image/png'],
        ['webp', 'image/webp'],
    ];

    for (const [format, mime] of formats) {
        for (const size of [400 * KiB, 1 * MiB, 1.9 * MiB]) {
            it(`stores a ${Math.round(size / KiB)} KiB ${format}`, async () => {
                const image = await makeImageOfSize(format, size);
                const res = await PUT(putEvent(uploadRequest(image, mime)));

                expect(res.status).toBe(200);
                expect(setUserAvatar).toHaveBeenCalledOnce();
            });
        }

        it(`answers 413 with a readable message for a 2.5 MiB ${format}`, async () => {
            const image = await makeImageOfSize(format, 2.5 * MiB);
            const res = await PUT(putEvent(uploadRequest(image, mime)));

            expect(res.status).toBe(413);
            const body = (await res.json()) as { error: string };
            expect(body.error).toMatch(/too large.*2 ?MB/i);
            expect(setUserAvatar).not.toHaveBeenCalled();
        });
    }

    it('refuses a PNG declaring 10000×10000 with a clear message, stores nothing', async () => {
        const res = await PUT(putEvent(uploadRequest(pixelBombPng(10_000, 10_000), 'image/png')));
        expect(res.status).toBe(422);
        const body = (await res.json()) as { error: string };
        expect(body.error).toBe('Image too large (max 16 megapixels)');
        expect(setUserAvatar).not.toHaveBeenCalled();
    });

    it('answers 413, not 500, when the adapter body limit rejects the upload', async () => {
        const request = uploadRequest(await makeImageOfSize('jpeg', 400 * KiB), 'image/jpeg');
        // What adapter-node's body stream raises past BODY_SIZE_LIMIT.
        vi.spyOn(request, 'formData').mockRejectedValue(
            Object.assign(new Error('Content-length of 1048576 exceeds limit of 524288 bytes.'), {
                status: 413,
                text: 'Payload Too Large',
            }),
        );

        const res = await PUT(putEvent(request));

        expect(res.status).toBe(413);
        const body = (await res.json()) as { error: string };
        expect(body.error).toMatch(/too large.*2 ?MB/i);
    });
});

describe('PUT /api/image/user/{username}/avatar — who may change it', () => {
    function otherUserEvent(locals: Record<string, unknown>): Parameters<typeof PUT>[0] {
        const request = new Request('http://localhost/api/image/user/bob/avatar', {
            method: 'PUT',
            body: new FormData(),
        });
        return {
            request,
            params: { userId: 'bob' },
            url: new URL(request.url),
            route: { id: '/api/image/user/[userId]/avatar' },
            locals,
        } as unknown as Parameters<typeof PUT>[0];
    }

    it("refuses another user's avatar for a non-admin credential of an admin owner", async () => {
        const res = await PUT(
            otherUserEvent({
                user: { username: 'alice', isAdmin: true },
                principal: { username: 'alice', isAdmin: false },
            }),
        );
        expect(res.status).toBe(403);
    });

    it("lets an admin credential past the ownership check for another user's avatar", async () => {
        const res = await PUT(
            otherUserEvent({
                user: { username: 'alice', isAdmin: true },
                principal: { username: 'alice', isAdmin: true },
            }),
        );
        expect(res.status).not.toBe(403);
    });

    it('treats a differently cased own username as own', async () => {
        const request = new Request('http://localhost/api/image/user/Alice/avatar', {
            method: 'PUT',
            body: new FormData(),
        });
        const res = await PUT({
            request,
            params: { userId: 'Alice' },
            url: new URL(request.url),
            route: { id: '/api/image/user/[userId]/avatar' },
            locals: { user: { username: 'alice', ownerIsAdmin: false } },
        } as unknown as Parameters<typeof PUT>[0]);
        expect(res.status).not.toBe(403);
    });
});
