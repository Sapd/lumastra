// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { toUserId } from '$lib/shared/user-id';
const h = vi.hoisted(() => ({
    validate: vi.fn().mockResolvedValue({ Id: 'jf-user', Name: 'admin' }),
}));
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql(): object {
            return {};
        }
    },
}));
vi.mock('../jellyfin', () => ({ jellyfinAuthService: { validateAccessToken: h.validate } }));
vi.mock('../config', () => ({ config: { APP_NAME: 'Lumastra' } }));
vi.mock('../database/queries/provider-device-tokens.queries.js', () => ({
    updateJellyfinTokenLastUsed: vi.fn(),
}));
import { JellyfinTokenService } from './jellyfin-token.service';

describe('device token validation identity', () => {
    it('forwards the immutable provider binding and session id, even after a display-name change', async () => {
        const service = new JellyfinTokenService();
        const userId = toUserId('10000000-0000-4000-8000-000000000001');
        vi.spyOn(service, 'getByDeviceSession').mockResolvedValue({
            id: 1,
            user_id: userId,
            provider_user_id: 'jf-user',
            device_session_id: 'tv-session',
            provider_device_binding: 'Lumastra - Original TV',
            provider_access_token: 'device-token',
            created_at: new Date(),
            last_used_at: null,
            revoked_at: null,
        });
        expect(
            await service.getOrCreateToken({
                userId,
                jellyfinUserId: 'jf-user',
                deviceSessionId: 'tv-session',
                deviceName: 'Renamed TV',
                forceValidate: true,
            }),
        ).toEqual({ token: 'device-token', deviceName: 'Lumastra - Original TV' });
        expect(h.validate).toHaveBeenCalledExactlyOnceWith('device-token', {
            deviceName: 'Lumastra - Original TV',
            deviceId: 'tv-session',
        });
    });
});
