// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PUT /api/v1/users/{id}/images/avatar — upload size contract. Real multipart
 * bodies and real sharp; the DB and the avatar cache are stubbed.
 *
 * A file over the 2 MiB cap is a 413 `payload_too_large` (it used to be a
 * 422), and an upload the adapter's BODY_SIZE_LIMIT rejects inside
 * `formData()` is a 413 too — before the fix that escaped as a 500.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { makeImageOfSize } from '../../../../../../../../tests/helpers/sized-test-image';
import { pixelBombPng } from '../../../../../../../../tests/helpers/pixel-bomb-png';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const setUserAvatar = vi.fn(async () => true);

vi.mock('$lib/server/database/index.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserById: vi.fn(async () => ({ username: 'alice' })),
    setUserAvatar,
    deleteUserAvatar: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/image-proxy/index.js', () => ({
    getImageProxyService: () => ({ invalidateAvatarCache: vi.fn(async () => undefined) }),
    imageResponse: vi.fn(),
}));

const { def } = await import('./[role]');

const KiB = 1024;
const MiB = 1024 * 1024;

function putEvent(request: Request): RequestEvent {
    return {
        request,
        params: { id: USER_ID, role: 'avatar' },
        url: new URL(request.url),
        locals: { principal: { userId: USER_ID, isAdmin: false } },
    } as unknown as RequestEvent;
}

function uploadRequest(file: Buffer, mime: string): Request {
    const form = new FormData();
    form.append('avatar', new Blob([new Uint8Array(file)], { type: mime }), 'avatar');
    return new Request(`http://localhost/api/v1/users/${USER_ID}/images/avatar`, {
        method: 'PUT',
        body: form,
    });
}

async function put(request: Request): Promise<Response> {
    const handler = def.handlers.PUT;
    if (!handler) throw new Error('no PUT handler');
    return handler(putEvent(request), { surface: 'v1' } as never);
}

beforeEach(() => setUserAvatar.mockClear());

describe('PUT /api/v1/users/{id}/images/avatar — size limits', () => {
    it('stores a 1.9 MiB webp', async () => {
        const res = await put(
            uploadRequest(await makeImageOfSize('webp', 1.9 * MiB), 'image/webp'),
        );

        expect(res.status).toBe(200);
        expect(setUserAvatar).toHaveBeenCalledOnce();
    });

    it('answers 413 payload_too_large for a 2.5 MiB jpeg', async () => {
        const res = await put(
            uploadRequest(await makeImageOfSize('jpeg', 2.5 * MiB), 'image/jpeg'),
        );

        expect(res.status).toBe(413);
        const body = (await res.json()) as { code: string; error: string };
        expect(body.code).toBe('payload_too_large');
        expect(body.error).toMatch(/too large.*2 ?MB/i);
        expect(setUserAvatar).not.toHaveBeenCalled();
    });

    it('refuses a PNG declaring 10000×10000 with a clear message, stores nothing', async () => {
        const res = await put(uploadRequest(pixelBombPng(10_000, 10_000), 'image/png'));
        expect(res.status).toBe(422);
        expect(JSON.stringify(await res.json())).toContain('Image too large (max 16 megapixels)');
        expect(setUserAvatar).not.toHaveBeenCalled();
    });

    it('answers 413, not a thrown 500, when the adapter body limit rejects the upload', async () => {
        const request = uploadRequest(await makeImageOfSize('png', 400 * KiB), 'image/png');
        vi.spyOn(request, 'formData').mockRejectedValue(
            Object.assign(new Error('request body size exceeded BODY_SIZE_LIMIT of 524288'), {
                status: 413,
                text: 'Payload Too Large',
            }),
        );

        const res = await put(request);

        expect(res.status).toBe(413);
    });
});
