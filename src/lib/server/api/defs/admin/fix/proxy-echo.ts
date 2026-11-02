// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/proxy-echo — what the reverse proxy actually sends this app.
 *
 * GET /api/admin/fix/proxy-echo → ProxyEcho.
 * Auth: admin. Errors: problem+json.
 *
 * ## A failure class that produces no errors anywhere
 *
 * When `TRUSTED_PROXY_IPS` does not contain the real edge, forward-auth identity
 * headers are discarded as untrusted and every login fails closed. That is the
 * correct behaviour, and it is completely silent: no exception, no failed
 * healthcheck, no log line an operator would think to search for. This
 * deployment has hit it before — the edge moved and the allowlist still named
 * the old host.
 *
 * Nothing can detect this from stored state, because the evidence only exists
 * during a request. So the operator's OWN request is the probe: it travelled the
 * same path a user's would, and what the app saw of it is the measurement.
 *
 * ## Values are never echoed, only presence and length
 *
 * An identity header names a real person, so returning it puts a username in a
 * diagnostic payload for no diagnostic gain. And an untrusted peer's header
 * value is attacker-chosen text — reflecting it would make this endpoint a
 * mirror for whatever a forger sent. Presence and length answer both questions
 * an operator actually has ("is it arriving?", "is it empty?") with neither
 * hazard. This is the same reasoning `forward-auth.ts` gives for not logging an
 * untrusted peer's header value.
 */

import { defineEndpoint } from '$lib/server/api/define.js';
import { json } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { forwardAuthTrustPosture } from '$lib/server/utils/client-ip.js';
import {
    decodeProxyHeaderValue,
    identityHeaderVerdict,
    isUnexpandedProxyPlaceholder,
} from '$lib/server/middleware/forward-auth.js';
import { findWideTrustedProxyRanges } from '$lib/server/utils/trusted-proxy-ranges.js';
import type { ProxyEcho, ProxyHeader } from '$lib/components/admin/fix/proxy-echo.schema.js';

export const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['users:admin'] },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const h = event.request.headers;

            /** Presence and length only — never the value. */
            function probe(name: string, role: ProxyHeader['role'], purpose: string): ProxyHeader {
                const raw = h.get(name);
                return {
                    name,
                    present: raw !== null,
                    length: raw?.length ?? 0,
                    role,
                    purpose,
                };
            }

            const identityHeaders: ProxyHeader[] = [
                probe(
                    config.USERHEADER,
                    'user',
                    'Who the proxy says you are. Without it nobody can sign in.',
                ),
                probe(
                    config.GROUPHEADER,
                    'groups',
                    'Your groups, which decide admin rights and library access.',
                ),
            ];

            const forwardingHeaders: ProxyHeader[] = [
                probe(
                    'x-forwarded-for',
                    'client-ip',
                    'The original client address. Used for rate limits and audit entries.',
                ),
                probe(
                    'x-forwarded-proto',
                    'proto',
                    'Whether the user reached the proxy over HTTPS. Wrong here means links ' +
                        'and redirects can be built with the wrong scheme.',
                ),
                probe('x-forwarded-host', 'forwarded-host', 'The hostname the user typed.'),
                probe('host', 'host', 'The Host header this app received.'),
            ];

            // Display only. The trust decision below goes through forward-auth's
            // own `identityHeaderVerdict`, which uses its own fail-closed sentinel
            // for an unknowable peer.
            let peerAddress: string;
            try {
                peerAddress = event.getClientAddress();
            } catch {
                peerAddress = 'unknown';
            }

            const posture = forwardAuthTrustPosture();
            // The same gate every identity-header reader applies, so the echo
            // cannot drift from what a login actually gets.
            const gate = identityHeaderVerdict(event);
            const peerTrusted = gate !== 'untrusted-peer';
            const forwardAuthEnabled = config.FORWARD_AUTH_ENABLED === true;
            const anyIdentity = identityHeaders.some((x) => x.present);
            // Read the username the way `readTrustedForwardAuthIdentity` does: a
            // blank value or an unexpanded `{…}` template is not an identity, and
            // groups without a username sign nobody in.
            const user = decodeProxyHeaderValue(h.get(config.USERHEADER))?.trim() || null;
            const userArrived = h.get(config.USERHEADER) !== null;
            const userUsable = user !== null && !isUnexpandedProxyPlaceholder(user);

            // Ordered by what the operator should fix first. With forward auth
            // off no header is read, so that is the answer — unless identity
            // headers are arriving from a peer the allowlist rejects: turning the
            // flag on would not help, and the trust problem must be fixed first.
            // A fail-closed posture is reported ahead of a missing header because
            // it makes the header irrelevant.
            const verdict: ProxyEcho['verdict'] = !forwardAuthEnabled
                ? anyIdentity && gate === 'untrusted-peer' && posture !== 'fail-closed'
                    ? 'identity-from-untrusted-peer'
                    : 'forward-auth-disabled'
                : posture === 'fail-closed'
                  ? 'fail-closed-no-allowlist'
                  : gate === 'untrusted-peer'
                    ? anyIdentity
                        ? 'identity-from-untrusted-peer'
                        : 'no-identity-headers'
                    : !userArrived
                      ? 'no-identity-headers'
                      : !userUsable
                        ? 'user-header-unusable'
                        : 'ok';

            // With forward auth on, a trust setting that lets more than the
            // proxy send identity headers turns them into a sign-in for anyone
            // who can connect. Reported even when the verdict is `ok`: the chain
            // works, and so would a forger's.
            const trustWarning: ProxyEcho['trustWarning'] = !forwardAuthEnabled
                ? null
                : (process.env.ADDRESS_HEADER ?? '').trim()
                  ? 'address-header'
                  : posture === 'trust-any'
                    ? 'trust-any'
                    : (findWideTrustedProxyRanges(process.env.TRUSTED_PROXY_IPS)?.wide.length ??
                            0) > 0
                      ? 'wide-range'
                      : null;

            const payload: ProxyEcho = {
                generatedAt: new Date().toISOString(),
                peerAddress,
                peerTrusted,
                forwardAuthEnabled,
                posture,
                identityHeaders,
                forwardingHeaders,
                verdict,
                trustWarning,
            };

            return json(payload);
        },
    },
});
