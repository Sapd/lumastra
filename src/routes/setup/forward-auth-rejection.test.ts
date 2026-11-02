// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { forwardAuthRejectionView } from './forward-auth-rejection';

const ROUTE =
    'Iface\tDestination\tGateway\tFlags\n' +
    'eth0\t00000000\t010015AC\t0003\n' +
    'eth0\t000015AC\t00000000\t0001\n';

const base = {
    identityAccepted: false,
    mayShowDiagnostics: true,
    rejectedPeer: '172.21.0.5',
    procNetRoute: ROUTE,
};

describe('forwardAuthRejectionView', () => {
    it('surfaces the rejected peer to the pre-admin setup flow', () => {
        expect(forwardAuthRejectionView(base)).toEqual({
            peer: '172.21.0.5',
            peerIsGateway: false,
        });
    });

    it('flags a peer that is the Docker gateway (trusting it trusts the host)', () => {
        expect(forwardAuthRejectionView({ ...base, rejectedPeer: '172.21.0.1' })).toEqual({
            peer: '172.21.0.1',
            peerIsGateway: true,
        });
    });

    it('never exposes the peer outside setup (configured instance, non-admin)', () => {
        expect(forwardAuthRejectionView({ ...base, mayShowDiagnostics: false })).toBeNull();
    });

    it('is null when the identity was accepted or nothing was rejected', () => {
        expect(forwardAuthRejectionView({ ...base, identityAccepted: true })).toBeNull();
        expect(forwardAuthRejectionView({ ...base, rejectedPeer: null })).toBeNull();
    });

    it('off Linux (no route table) the peer is shown without the gateway flag', () => {
        expect(
            forwardAuthRejectionView({ ...base, rejectedPeer: '172.21.0.1', procNetRoute: null }),
        ).toEqual({ peer: '172.21.0.1', peerIsGateway: false });
    });
});
