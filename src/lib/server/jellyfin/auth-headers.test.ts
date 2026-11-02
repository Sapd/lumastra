// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { buildJellyfinAuthHeaders } from './auth-headers.js';
import * as m from '$lib/paraglide/messages';

describe('Jellyfin Authorization', () => {
    it('uses the standard MediaBrowser scheme with complete client identity', () => {
        expect(buildJellyfinAuthHeaders({ token: 'server-key' })).toEqual({
            Authorization:
                'MediaBrowser Client="Lumastra", Device="Lumastra Server", DeviceId="lumastra-server", Version="1.0.0", Token="server-key"',
        });
    });

    it('sends the explicit user token, never a configured admin token', () => {
        expect(buildJellyfinAuthHeaders({ token: 'user-token' }).Authorization).toContain(
            'Token="user-token"',
        );
    });

    it('omits Token for unauthenticated Quick Connect and preserves device identity', () => {
        expect(
            buildJellyfinAuthHeaders({
                token: null,
                deviceName: 'Living Room TV',
                deviceId: 'tv-42',
            }),
        ).toEqual({
            Authorization:
                'MediaBrowser Client="Lumastra", Device="Living Room TV", DeviceId="tv-42", Version="1.0.0"',
        });
    });

    it('removes quotes, backslashes and header controls from untrusted device identity', () => {
        const { Authorization } = buildJellyfinAuthHeaders({
            token: null,
            deviceName: 'TV"\\\r\n',
            deviceId: 'id"\\\r\n',
        });
        expect(Authorization).toContain('Device="TV", DeviceId="id"');
        expect(() => new Headers({ Authorization })).not.toThrow();
    });

    it.each(['', 'key"', 'key\\', 'key,Token=other', 'key\r\n', 'key\u0000'])(
        'rejects malformed tokens without exposing them (%#)',
        (token) => {
            expect(() => buildJellyfinAuthHeaders({ token })).toThrow('Invalid Jellyfin token');
        },
    );

    it('limits only Device after sanitization, preserving long device ids and tokens', () => {
        const token = 't'.repeat(120);
        const deviceId = 'i'.repeat(120);
        const { Authorization } = buildJellyfinAuthHeaders({
            token,
            deviceName: '"'.repeat(20) + 'D'.repeat(120),
            deviceId,
        });
        expect(Authorization).toContain(`Device="${'D'.repeat(100)}"`);
        expect(Authorization).toContain(`DeviceId="${deviceId}"`);
        expect(Authorization).toContain(`Token="${token}"`);
    });

    it.each(['en', 'de'] as const)(
        'gives key and proxy checks without version advice in %s',
        (locale) => {
            const message = m.jellyfin_auth_rejected({}, { locale });
            expect(message).toContain('401');
            expect(message).toContain('Authorization');
            expect(message).toContain(
                locale === 'en'
                    ? 'Jellyfin Dashboard > API Keys'
                    : 'Jellyfin-Dashboard > API-Schlüssel',
            );
            expect(message).toMatch(/reverse proxy|Reverse-Proxy/);
            expect(message).not.toMatch(/12\.x|version|Version|modern|modern[e]?/);
        },
    );
});
