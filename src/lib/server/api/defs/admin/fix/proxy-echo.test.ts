// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/proxy-echo verdicts. The trust decision runs through forward-auth's
 * real `identityHeaderVerdict` (only client-ip is stubbed), and the username is
 * read the way the login path reads it, so a header the login would discard is
 * never reported as `ok`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({
    FORWARD_AUTH_ENABLED: false as boolean | undefined,
    USERHEADER: 'X-Forwarded-User',
    GROUPHEADER: 'X-Forwarded-Groups',
}));
vi.mock('$lib/server/config.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/config.js')>()),
    config: mockConfig,
}));

const trust = vi.hoisted(() => ({
    posture: 'allowlist' as 'allowlist' | 'trust-any' | 'fail-closed',
    trustedPeer: '10.0.0.5',
}));
vi.mock('$lib/server/utils/client-ip.js', () => ({
    forwardAuthTrustPosture: () => trust.posture,
    isForwardAuthPeerTrusted: (peer: string) => peer === trust.trustedPeer,
}));

import { def } from './proxy-echo.js';
import { ProxyEchoSchema, type ProxyEcho } from '$lib/components/admin/fix/proxy-echo.schema.js';

async function echo(headers: Record<string, string>, peer = '10.0.0.5'): Promise<ProxyEcho> {
    const event = {
        request: new Request('http://localhost/api/admin/fix/proxy-echo', {
            headers: new Headers(headers),
        }),
        getClientAddress: () => peer,
    };
    const resp = await def.handlers.GET!(event as never, {} as never);
    return ProxyEchoSchema.parse(await (resp as Response).json());
}

const IDENTITY = { 'X-Forwarded-User': 'alice', 'X-Forwarded-Groups': 'family' };

beforeEach(() => {
    mockConfig.FORWARD_AUTH_ENABLED = false;
    trust.posture = 'allowlist';
    delete process.env.ADDRESS_HEADER;
    delete process.env.TRUSTED_PROXY_IPS;
});

describe('proxy-echo with forward auth off', () => {
    it('trusted peer sending identity headers → forward-auth-disabled', async () => {
        const body = await echo(IDENTITY);
        expect(body.verdict).toBe('forward-auth-disabled');
        expect(body.forwardAuthEnabled).toBe(false);
        expect(body.peerTrusted).toBe(true);
    });

    it('outranks fail-closed and no headers', async () => {
        trust.posture = 'fail-closed';
        expect((await echo(IDENTITY)).verdict).toBe('forward-auth-disabled');
        trust.posture = 'allowlist';
        expect((await echo({})).verdict).toBe('forward-auth-disabled');
    });

    it('identity from a peer the allowlist rejects → fix trust before turning it on', async () => {
        const body = await echo(IDENTITY, '203.0.113.9');
        expect(body.verdict).toBe('identity-from-untrusted-peer');
        expect(body.peerTrusted).toBe(false);
    });

    it('raises no trust warning while forward auth is off', async () => {
        trust.posture = 'trust-any';
        expect((await echo(IDENTITY)).trustWarning).toBeNull();
    });

    it('a missing key reads as off', async () => {
        mockConfig.FORWARD_AUTH_ENABLED = undefined;
        expect((await echo(IDENTITY)).forwardAuthEnabled).toBe(false);
    });

    it('labels each header with its role for the page to translate', async () => {
        const body = await echo(IDENTITY);
        expect(body.identityHeaders.map((h) => h.role)).toEqual(['user', 'groups']);
        expect(body.forwardingHeaders.map((h) => h.role)).toEqual([
            'client-ip',
            'proto',
            'forwarded-host',
            'host',
        ]);
    });

    it('never echoes header values', async () => {
        const body = await echo(IDENTITY);
        expect(JSON.stringify(body)).not.toContain('alice');
    });
});

describe('proxy-echo with forward auth on (unchanged verdicts)', () => {
    beforeEach(() => {
        mockConfig.FORWARD_AUTH_ENABLED = true;
    });

    it('trusted peer with identity → ok', async () => {
        const body = await echo(IDENTITY);
        expect(body.verdict).toBe('ok');
        expect(body.forwardAuthEnabled).toBe(true);
    });

    it('untrusted peer → identity-from-untrusted-peer', async () => {
        expect((await echo(IDENTITY, '203.0.113.9')).verdict).toBe('identity-from-untrusted-peer');
    });

    it('no headers → no-identity-headers; fail-closed → fail-closed-no-allowlist', async () => {
        expect((await echo({})).verdict).toBe('no-identity-headers');
        trust.posture = 'fail-closed';
        expect((await echo(IDENTITY)).verdict).toBe('fail-closed-no-allowlist');
    });

    it('groups without a username sign nobody in → no-identity-headers', async () => {
        const body = await echo({ 'X-Forwarded-Groups': 'family' });
        expect(body.verdict).toBe('no-identity-headers');
    });

    it.each([
        ['blank', '   '],
        ['unexpanded template', '{http.reverse_proxy.header.x-authentik-username}'],
    ])('a %s username → user-header-unusable', async (_label, value) => {
        const body = await echo({ 'X-Forwarded-User': value });
        expect(body.verdict).toBe('user-header-unusable');
        expect(JSON.stringify(body)).not.toContain('authentik');
    });

    it('no trust warning for a pinned proxy', async () => {
        process.env.TRUSTED_PROXY_IPS = '10.0.0.5';
        expect((await echo(IDENTITY)).trustWarning).toBeNull();
    });

    it('trust-any → ok, with a trust-any warning', async () => {
        trust.posture = 'trust-any';
        const body = await echo(IDENTITY);
        expect(body.verdict).toBe('ok');
        expect(body.trustWarning).toBe('trust-any');
    });

    it('a range wider than /24 → wide-range warning', async () => {
        process.env.TRUSTED_PROXY_IPS = '10.0.0.0/8';
        expect((await echo(IDENTITY)).trustWarning).toBe('wide-range');
    });

    it('ADDRESS_HEADER outranks the other warnings', async () => {
        process.env.ADDRESS_HEADER = 'x-forwarded-for';
        trust.posture = 'trust-any';
        expect((await echo(IDENTITY)).trustWarning).toBe('address-header');
    });
});
