// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Security fix C7: the service-worker app-shell cache could keep one user's
 * personalized SSR HTML across logout on a shared device/browser, and this
 * route never told the browser to clear it. Every response POST /logout can
 * produce (unauthenticated no-op, browser/forward-auth session with no
 * device tokens to revoke, and a device-authenticated session that does
 * revoke tokens) must carry `Clear-Site-Data: "cache"` so the
 * browser wipes CacheStorage as part of the logout response itself.
 */

import { describe, it, expect, vi } from 'vitest';
import type { RequestEvent } from './$types';

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
    },
}));

const revoke = vi.fn().mockResolvedValue(true);
vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: () => ({ revoke }),
}));

const revokeByDeviceSessionId = vi.fn().mockResolvedValue(1);
const isDeviceAuthEnabled = vi.fn().mockReturnValue(true);
vi.mock('$lib/server/oauth/index.js', () => ({
    isDeviceAuthEnabled: () => isDeviceAuthEnabled(),
    getRefreshTokenService: () => ({ revokeByDeviceSessionId }),
}));

/**
 * `locals` only needs the two fields this route actually reads
 * (`user.userId`/`user.username`, `deviceSessionId`) — a real `UserContext`
 * carries several more (groups, permissions, …) that are irrelevant here, so
 * the test's partial shape is cast rather than fully populated.
 */
async function post(locals: Record<string, unknown>): Promise<Response> {
    const { POST } = await import('./+server.js');
    return POST({ locals } as unknown as RequestEvent);
}

describe('POST /logout — Clear-Site-Data', () => {
    it('unauthenticated caller (nothing to revoke) still gets the header', async () => {
        const res = await post({ user: undefined });
        expect(res.headers.get('Clear-Site-Data')).toBe('"cache"');
        expect((await res.json()).success).toBe(true);
    });

    it('browser/forward-auth session with no device tokens gets the header', async () => {
        const res = await post({
            user: { userId: 'u1', username: 'alice' },
            deviceSessionId: undefined,
        });
        expect(res.headers.get('Clear-Site-Data')).toBe('"cache"');
    });

    it('device-authenticated session that revokes tokens gets the header', async () => {
        const res = await post({
            user: { userId: 'u1', username: 'alice' },
            deviceSessionId: 'device-session-123',
        });
        expect(res.headers.get('Clear-Site-Data')).toBe('"cache"');
        expect(revoke).toHaveBeenCalledWith('device-session-123', 'u1');
        expect(revokeByDeviceSessionId).toHaveBeenCalledWith('device-session-123');
    });
});
