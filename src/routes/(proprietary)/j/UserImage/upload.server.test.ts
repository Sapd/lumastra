// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * POST /j/UserImage with a pixel bomb: a ~100-byte PNG declaring 20000×20000
 * must be refused with 400 before sharp tries to decode 400 MP, and nothing
 * is stored. The real processAvatarImage (sharp) runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { pixelBombPng } from '../../../../../tests/helpers/pixel-bomb-png';

const h = vi.hoisted(() => ({ setUserAvatar: vi.fn(), errors: [] as unknown[] }));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
    withOptionalJellyfinAuth: (handler: unknown) => handler,
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries', () => ({
    setUserAvatar: h.setUserAvatar,
    deleteUserAvatar: vi.fn(),
}));
// The real processAvatarImage, recording why it refused.
vi.mock('$lib/server/utils/avatar-image', async (orig) => {
    const actual = await orig<typeof import('$lib/server/utils/avatar-image')>();
    return {
        ...actual,
        processAvatarImage: async (...args: Parameters<typeof actual.processAvatarImage>) => {
            try {
                return await actual.processAvatarImage(...args);
            } catch (err) {
                h.errors.push(err);
                throw err;
            }
        },
    };
});
vi.mock('$lib/server/services/image-proxy', () => ({
    getImageProxyService: () => ({ invalidateAvatarCache: vi.fn(async () => undefined) }),
    imageResponse: vi.fn(),
}));

const { POST } = await import('./+server.js');

beforeEach(() => {
    h.setUserAvatar.mockReset();
    h.errors.length = 0;
    h.setUserAvatar.mockResolvedValue(true);
});

describe('POST /j/UserImage', () => {
    it.each([
        [20_000, 20_000],
        [10_000, 10_000],
    ])('answers 400 for a PNG declaring %i×%i and stores nothing', async (w, hgt) => {
        const url = new URL('https://app.example/j/UserImage');
        const res = await POST({
            request: new Request(url, {
                method: 'POST',
                headers: { 'Content-Type': 'image/png' },
                body: pixelBombPng(w, hgt).toString('base64'),
            }),
            url,
            params: {},
            locals: { user: { userId: '11111111-1111-4111-8111-111111111111', username: 'a' } },
        } as never);
        expect(res.status).toBe(400);
        expect(h.setUserAvatar).not.toHaveBeenCalled();
        expect(String(h.errors[0])).toMatch(/pixel limit/i);
        const body = (await res.json()) as { title: string };
        expect(body.title).toBe('Image too large (max 16 megapixels)');
    });
});
