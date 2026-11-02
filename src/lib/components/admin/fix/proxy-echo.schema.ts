// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Wire contract for `/admin/fix/proxy` — what the reverse proxy actually sends.
 *
 * ## The failure this exists to make loud
 *
 * When `TRUSTED_PROXY_IPS` does not list the real edge, forward-auth headers are
 * discarded as untrusted and every login silently fails closed. That is correct
 * behaviour and it produces NO error anywhere: no exception, no failed
 * healthcheck, no log line an operator would think to look for. It has bitten
 * this deployment before, and the only way to see it is to ask the app what it
 * received.
 *
 * The operator's own request is the test. It travelled the same path a user's
 * would, so what the app saw of THIS request is the measurement.
 *
 * ## Header VALUES are never returned, only presence
 *
 * Two reasons, and both matter. Identity headers name a real person, so echoing
 * them puts a username in a diagnostic payload for no diagnostic gain. And an
 * UNTRUSTED peer's header value is attacker-chosen text — reflecting it would
 * turn this page into a mirror for whatever a forger sent. Presence and length
 * answer every question the operator actually has ("is it arriving at all?",
 * "is it empty?") without either hazard.
 */

import { z } from 'zod';

export const ProxyHeaderSchema = z.object({
    /** The header the app looks for, as configured on this instance. */
    name: z.string(),
    present: z.boolean(),
    /** Length only — never the value. See the module note. */
    length: z.number(),
    /** Which header this is, so the page renders its purpose in the user's language. */
    role: z.enum(['user', 'groups', 'client-ip', 'proto', 'forwarded-host', 'host']),
    /** English purpose text, kept as a fallback for older pages; the page uses `role`. */
    purpose: z.string(),
});
export type ProxyHeader = z.infer<typeof ProxyHeaderSchema>;

export const ProxyEchoSchema = z.object({
    generatedAt: z.string(),

    /**
     * The TCP peer the app sees — the machine that actually opened the
     * connection. This is the value `TRUSTED_PROXY_IPS` must contain, and the
     * one operators most often get wrong by listing the edge's public address
     * instead of the address it connects FROM.
     */
    peerAddress: z.string(),
    /** Whether that peer may set identity headers on this instance. */
    peerTrusted: z.boolean(),
    /**
     * FORWARD_AUTH_ENABLED. Off (the default): identity headers are ignored even
     * from a trusted peer, so `peerTrusted` alone does not mean sign-in works.
     */
    forwardAuthEnabled: z.boolean(),
    /**
     * `allowlist` — TRUSTED_PROXY_IPS is set and enforced.
     * `trust-any`  — no allowlist, explicitly opted out.
     * `fail-closed` — no allowlist and no opt-in: nobody can authenticate.
     */
    posture: z.enum(['allowlist', 'trust-any', 'fail-closed']),

    /** Identity headers, by configured name. */
    identityHeaders: z.array(ProxyHeaderSchema),
    /** Transport headers, which tell you whether the proxy is rewriting correctly. */
    forwardingHeaders: z.array(ProxyHeaderSchema),

    /**
     * The verdict, computed server-side: is this request's forward-auth chain
     * intact? `ok` means identity arrived from a trusted peer. Everything else
     * names what is wrong. `user-header-unusable`: the username header arrived
     * blank or as an unexpanded `{…}` proxy template, which the login path
     * discards.
     */
    verdict: z.enum([
        'ok',
        'user-header-unusable',
        'forward-auth-disabled',
        'no-identity-headers',
        'identity-from-untrusted-peer',
        'fail-closed-no-allowlist',
    ]),

    /**
     * Set only with forward auth on, when more than the proxy may send identity
     * headers: `address-header` (ADDRESS_HEADER makes the peer client-chosen),
     * `trust-any` (LUMASTRA_TRUST_ANY_PROXY), `wide-range` (TRUSTED_PROXY_IPS
     * holds a range wider than /24). Independent of the verdict.
     */
    trustWarning: z.enum(['address-header', 'trust-any', 'wide-range']).nullable(),
});
export type ProxyEcho = z.infer<typeof ProxyEchoSchema>;
