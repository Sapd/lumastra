// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for security review P2 on the audiobook byte-proxy route: the
 * `authenticate()` helper in audiobook-stream-routes.ts must resolve the
 * client IP it hands to `authenticateAudiobookStream` (which pins it to the
 * stream token's IP-binding check) with the STRICT, non-spoofable resolver —
 * not the implicit-trust `getClientIpFromRequest`, which honors a
 * client-supplied `X-Forwarded-For` when `TRUSTED_PROXY_IPS` is unset.
 *
 * Mirrors `forward-auth-stream-token-strict-ip.test.ts`: mocks
 * `authenticateAudiobookStream` to reproduce the real service's IP-binding
 * contract (reject unless `clientIp` matches the mint-time IP) and asserts
 * WHICH ip this route actually passes in. Deliberately does NOT mock
 * `$lib/server/utils/client-ip.js` (via its relative specifier here) — the
 * real module is exercised so the strict-vs-spoofable distinction is genuine.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const BOUND_IP = '203.0.113.7'; // the IP the stream token was minted under

const authCalls: Array<{ clientIp?: string }> = [];
const mockAuthenticateAudiobookStream = vi.fn(
    async (opts: {
        clientIp?: string;
    }): Promise<
        | { ok: true; absApiKey: string; absItemId: string }
        | { ok: false; status: number; reason: string }
    > => {
        authCalls.push({ clientIp: opts.clientIp });
        if (opts.clientIp !== BOUND_IP) {
            return { ok: false, status: 401, reason: 'invalid_token' };
        }
        return { ok: true, absApiKey: 'abs-key', absItemId: 'abs-item-1' };
    },
);
vi.mock('./audiobook-stream-auth.js', () => ({
    authenticateAudiobookStream: (...args: [{ clientIp?: string }]) =>
        mockAuthenticateAudiobookStream(...args),
    extractStreamToken: () => 'stream_abc123',
}));

vi.mock('../database/queries/play-sessions.queries.js', () => ({
    getSessionById: async () => ({
        user_id: 'owner',
        media_id: 'media-1',
        source: 'audiobookshelf',
        source_session_id: 'server-session',
        status: 'ACTIVE',
        device_capabilities: { audiobookTracks: [{ index: 1, ino: 'server-inode' }] },
    }),
}));
vi.mock('../database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('../config.js', () => ({ config: { AUDIOURL: 'http://abs.example/' } }));
vi.mock('../utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
// Not exercised on the auth-rejection path tested here.
vi.mock('./audiobook-byte-proxy.service.js', () => ({
    absFilePath: () => '/x',
    absHlsPath: () => '/x',
    AudiobookProxyError: class extends Error {},
    proxyAudiobookBytes: vi.fn(),
}));

// NOTE: ../utils/client-ip.js is intentionally NOT mocked — see file doc comment.

const { handleAudiobookFile } = await import('./audiobook-stream-routes.js');

function makeEvent(opts: { peer: string; xff?: string }): RequestEvent {
    const url = new URL(
        'http://lumastra.test/api/v1/audiobooks/media-1/files/1?PlaySessionId=11111111-1111-4111-8111-111111111111',
    );
    const headers = new Headers();
    if (opts.xff) headers.set('x-forwarded-for', opts.xff);
    return {
        params: { mediaId: 'media-1', trackIndex: '1' },
        url,
        request: new Request(url, { headers }),
        getClientAddress: () => opts.peer,
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    authCalls.length = 0;
    delete process.env.TRUSTED_PROXY_IPS;
    delete process.env.LUMASTRA_TRUST_ANY_PROXY;
});

describe('P2 — audiobook byte-proxy route uses the strict (non-spoofable) client IP', () => {
    it('a thief from an untrusted peer B, forging X-Forwarded-For to the mint peer A, is REJECTED — the strict peer, not the forged header, reaches authenticateAudiobookStream', async () => {
        const PEER_B = '198.51.100.42';
        const event = makeEvent({ peer: PEER_B, xff: BOUND_IP });

        const res = await handleAudiobookFile(event);

        expect(res.status).toBe(401);
        expect(authCalls).toHaveLength(1);
        expect(authCalls[0].clientIp).toBe(PEER_B);
    });

    it('the legitimate owner, requesting directly from the mint peer, is authenticated', async () => {
        const event = makeEvent({ peer: BOUND_IP });

        await handleAudiobookFile(event);

        expect(authCalls).toHaveLength(1);
        expect(authCalls[0].clientIp).toBe(BOUND_IP);
    });
});
