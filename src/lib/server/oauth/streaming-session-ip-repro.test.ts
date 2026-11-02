// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * F32 — stream-token IP binding vs. TRUSTED_PROXY_IPS unset.
 *
 * Original finding (2026-09): `getClientIp` returns the raw TCP peer when no
 * trusted proxies are configured, UNLESS `X-Forwarded-For` is present, in
 * which case implicit proxy trust honors it from ANY peer. Stream-token
 * validate() (`streaming-session.service.ts`) used `getClientIp` for its IP
 * check, so an attacker holding a stolen token could set
 * `X-Forwarded-For: <the mint-time IP>` and pass the check from any network —
 * the previous version of this file pinned exactly that as "correct".
 *
 * RESOLVED (security review P2, 2026-09-13): stream-token mint, refresh and
 * validate all now resolve the client IP via `getClientIpStrict` /
 * `getClientIpStrictFromRequest` (`forward-auth.ts`'s `handleStreamToken`,
 * the mint/refresh defs, and the audiobook byte-proxy route — see
 * `forward-auth-stream-token-strict-ip.test.ts` and
 * `audiobook-stream-routes.strict-ip.test.ts` for the end-to-end behaviour).
 * Unlike `getClientIp`, `getClientIpStrict` does NOT honor a client-supplied
 * `X-Forwarded-For` when `TRUSTED_PROXY_IPS` is unset — it falls back to the
 * raw TCP peer, so a forged header can no longer make an attacker's request
 * impersonate the mint-time IP. Trade-off (documented, not a bug): every
 * client behind the SAME unpinned reverse proxy collapses to that one peer
 * address — this stops IP *spoofing*, but does not by itself restore
 * per-client binding (that requires `TRUSTED_PROXY_IPS` to be pinned; see
 * `checkStreamTokenIpPinningIneffective` in
 * `security-self-check/config-rules.ts`).
 *
 * This file now pins the STRICT resolver's behaviour directly, in place of
 * the old (now-fixed) `getClientIp` expectation.
 *
 * Citations: src/lib/server/utils/client-ip.ts (getClientIpStrict),
 *            src/lib/server/middleware/forward-auth.ts (handleStreamToken)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

function makeEvent(peer: string, xff: string): RequestEvent {
    return {
        getClientAddress: () => peer,
        request: {
            headers: {
                get: (name: string) => (name.toLowerCase() === 'x-forwarded-for' ? xff : null),
            },
        },
    } as unknown as RequestEvent;
}

describe('F32 — stream-token IP binding uses the strict resolver, not the spoofable one', () => {
    let savedEnv: string | undefined;

    beforeEach(() => {
        savedEnv = process.env.TRUSTED_PROXY_IPS;
        delete process.env.TRUSTED_PROXY_IPS;
        vi.resetModules();
    });
    afterEach(() => {
        if (savedEnv === undefined) delete process.env.TRUSTED_PROXY_IPS;
        else process.env.TRUSTED_PROXY_IPS = savedEnv;
        vi.resetModules();
    });

    it('getClientIpStrict ignores a forged X-Forwarded-For and returns the raw TCP peer when TRUSTED_PROXY_IPS is unset', async () => {
        const { getClientIpStrict } = await import('$lib/server/utils/client-ip.js');

        const event = makeEvent('10.0.0.1' /* reverse proxy IP */, '203.0.113.42' /* forged */);

        const ip = getClientIpStrict(event);

        // Unlike the old getClientIp expectation, the strict resolver must
        // NOT trust the client-supplied header here — it has no allowlisted
        // proxy to attribute it to.
        expect(ip).toBe('10.0.0.1');
    });

    it("an attacker spoofing the victim's X-Forwarded-For from the SAME untrusted peer cannot impersonate the victim's IP", async () => {
        const { getClientIpStrict } = await import('$lib/server/utils/client-ip.js');

        // Both requests arrive through the same (unpinned) reverse proxy —
        // the only thing that differs is the attacker-controlled header.
        const attackerEvent = makeEvent('10.0.0.1', '198.51.100.7');
        const victimEvent = makeEvent('10.0.0.1', '203.0.113.42' /* the victim's real IP */);

        const attackerIp = getClientIpStrict(attackerEvent);
        const victimIp = getClientIpStrict(victimEvent);

        // Both collapse to the same (proxy) address — the attacker's forged
        // header is ignored, so the token's IP-binding check that compares
        // this value against the mint-time IP cannot be satisfied by simply
        // setting X-Forwarded-For to the victim's IP. (This is the
        // documented trade-off: per-client distinction is lost too, unless
        // TRUSTED_PROXY_IPS is pinned — see checkStreamTokenIpPinningIneffective.)
        expect(attackerIp).toBe(victimIp);
        expect(attackerIp).toBe('10.0.0.1');
    });
});
