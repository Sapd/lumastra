// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The fan-out writes a command to this replica's sockets directly and
 * publishes it once; when the replica's own publish comes back through the
 * shared subscription it must be skipped, or every command runs twice on the
 * device. A peer's envelope is delivered.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    published: [] as Array<{ channel: string; message: string }>,
    deliverLocal: vi.fn(),
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn(async (channel: string, message: string) => {
        h.published.push({ channel, message });
        return true;
    }),
    subscribeToChannel: vi.fn(),
}));
vi.mock('./local-sockets', () => ({ deliverLocal: h.deliverLocal }));

const {
    DELIVER_CHANNEL,
    __resetFanoutForTests,
    deliverToSession,
    ensureFanoutSubscription,
    sendToSession,
} = await import('./fanout');
const valkey = await import('$lib/server/cache/valkey.js');
const { outboundMessage } = await import('./protocol');

let onMessage: (raw: string) => void = () => undefined;

beforeEach(async () => {
    h.published.length = 0;
    h.deliverLocal.mockReset().mockReturnValue(1);
    __resetFanoutForTests();
    const subscribe = vi.fn(async (_channel: string, handler: (raw: string) => void) => {
        onMessage = handler;
        return () => undefined;
    });
    expect(await ensureFanoutSubscription(subscribe as never)).toBe(true);
    expect(subscribe).toHaveBeenCalledWith(DELIVER_CHANNEL, expect.any(Function));
});

describe('remote-control fan-out', () => {
    it('delivers its own command once: the echo of its own publish is skipped', async () => {
        const reached = await sendToSession(
            'sess-1',
            outboundMessage('Playstate', { Command: 'Pause' }),
        );
        expect(reached).toBe(1);
        expect(h.deliverLocal).toHaveBeenCalledTimes(1);
        expect(h.published).toHaveLength(1);

        // Valkey hands the replica its own publish back.
        onMessage(h.published[0].message);
        expect(h.deliverLocal).toHaveBeenCalledTimes(1);
    });

    it('delivers a peer replica’s envelope to the local sockets', () => {
        const payload = JSON.stringify(outboundMessage('Playstate', { Command: 'Stop' }));
        onMessage(JSON.stringify({ origin: 'other-replica', sessionId: 'sess-2', payload }));
        expect(h.deliverLocal).toHaveBeenCalledTimes(1);
        expect(h.deliverLocal).toHaveBeenCalledWith('sess-2', payload);
    });

    it('reports whether anything can have received a message', async () => {
        const message = outboundMessage('Playstate', { Command: 'Pause' });
        expect(await deliverToSession('s', message)).toEqual({ local: 1, published: true });
        h.deliverLocal.mockReturnValue(0);
        vi.mocked(valkey.publishMessage).mockResolvedValueOnce(false);
        expect(await deliverToSession('s', message)).toEqual({ local: 0, published: false });
    });
});
