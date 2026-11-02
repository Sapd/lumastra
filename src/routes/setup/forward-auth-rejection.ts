// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * "Your proxy's identity headers arrived but were REJECTED" — for the first-run
 * wizard. Previously step 2 said "No forward-auth headers detected on this
 * request." while the server log said `identity headers ignored — untrusted TCP
 * peer {"peer":"172.21.0.1"}` (Linux e2e 2026-09-29).
 *
 * Lives in a non-`+` sibling module so the exposure gate is unit-tested: the
 * peer address is shown ONLY to the pre-admin setup flow or to an authenticated
 * admin resuming it — never on a configured instance.
 */

import { detectGatewayTrust } from '$lib/server/utils/docker-gateway-trust.js';

export interface ForwardAuthRejectionView {
    /** The TCP peer whose identity headers were discarded. */
    peer: string;
    /**
     * The peer is the container's default gateway (the Docker host): trusting it
     * would trust every process on the host, so the wizard warns instead of just
     * handing over the TRUSTED_PROXY_IPS line.
     */
    peerIsGateway: boolean;
}

export function forwardAuthRejectionView(input: {
    /** A trusted identity was read — nothing was rejected. */
    identityAccepted: boolean;
    /** Pre-admin first run, or an authenticated admin resuming onboarding. */
    mayShowDiagnostics: boolean;
    /** readRejectedForwardAuthPeer(event). */
    rejectedPeer: string | null;
    /** /proc/net/route content (null off Linux). */
    procNetRoute: string | null;
}): ForwardAuthRejectionView | null {
    if (input.identityAccepted || !input.mayShowDiagnostics || !input.rejectedPeer) return null;
    const peerIsGateway =
        detectGatewayTrust({
            trustedProxyIps: input.rejectedPeer,
            procNetRoute: input.procNetRoute,
        }) !== null;
    return { peer: input.rejectedPeer, peerIsGateway };
}
