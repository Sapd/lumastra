// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getTcpPeer } from './tcp-peer';

function eventWithPeer(platform: RequestEvent['platform']): RequestEvent {
    return {
        platform,
        getClientAddress: vi.fn(() => '10.0.0.5'),
    } as unknown as RequestEvent;
}

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('getTcpPeer', () => {
    it.each(['x-forwarded-for', 'x-real-ip'])(
        'ignores %s and XFF_DEPTH for socket identity',
        (header) => {
            vi.stubEnv('ADDRESS_HEADER', header);
            vi.stubEnv('XFF_DEPTH', '2');
            const event = eventWithPeer({ req: { socket: { remoteAddress: '203.0.113.9' } } });
            expect(getTcpPeer(event)).toBe('203.0.113.9');
            expect(event.getClientAddress).not.toHaveBeenCalled();
        },
    );

    it('does not call a header-derived address getter if the socket is unavailable', () => {
        vi.stubEnv('ADDRESS_HEADER', 'x-forwarded-for');
        for (const platform of [undefined, { req: { socket: {} } }]) {
            const event = eventWithPeer(platform);
            expect(getTcpPeer(event)).toBe('');
            expect(event.getClientAddress).not.toHaveBeenCalled();
        }
    });

    it('uses the adapter address when no header override or Node request is present', () => {
        vi.stubEnv('ADDRESS_HEADER', '');
        expect(getTcpPeer(eventWithPeer(undefined))).toBe('10.0.0.5');
    });

    it('never replaces a missing Node socket with the adapter address', () => {
        vi.stubEnv('ADDRESS_HEADER', '');
        expect(getTcpPeer(eventWithPeer({ req: {} }))).toBe('');
    });

    it('returns an empty peer if the adapter getter throws', () => {
        vi.stubEnv('ADDRESS_HEADER', '');
        const event = eventWithPeer(undefined);
        event.getClientAddress = () => {
            throw new Error('unavailable');
        };
        expect(getTcpPeer(event)).toBe('');
    });
});
