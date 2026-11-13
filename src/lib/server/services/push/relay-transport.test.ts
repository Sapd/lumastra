// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayTransport } from './relay-transport.js';
import { setRelayToken, getRelayToken, adoptRelayTokenIfFresher } from './relay-token.store.js';
import { buildPushPayload } from './push-payload.js';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: { ...actual.config, PUSH_RELAY_URL: 'https://push.lumastra.org' },
    };
});

const NID = '11111111-1111-4111-8111-111111111111';
const LONG_TOKEN = 'abcdef0123456789'.repeat(4);

function req(tokens: string[] = [LONG_TOKEN]) {
    return {
        bundleId: 'de.hinterthaner.stellar-tvos.ios',
        environment: 'production' as const,
        collapseId: NID,
        expirationEpochSeconds: 1786554000,
        tokens,
        payload: buildPushPayload({
            kind: 'library.new_episode',
            notificationId: NID,
            badge: 1,
            locale: 'en-US',
            mode: 'content-free',
        }),
    };
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), { status, headers });
}

let fetchMock: ReturnType<typeof vi.fn>;
let transport: RelayTransport;

beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    setRelayToken('relay-token-1');
    transport = new RelayTransport();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('RelayTransport', () => {
    it('posts to PUSH_RELAY_URL /api/push/send with a bearer relay token', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(200, { results: [{ token: LONG_TOKEN, status: 'ok' }] }),
        );

        await transport.send(req());

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://push.lumastra.org/api/push/send');
        expect(init.method).toBe('POST');
        expect(init.headers.Authorization).toBe('Bearer relay-token-1');
        const body = JSON.parse(init.body as string);
        expect(body.pushType).toBe('alert');
        expect(body.priority).toBe(10);
        expect(body.collapseId).toBe(NID);
        expect(body.expirationEpochSeconds).toBe(1786554000);
    });

    it('throws no_credential — not unauthenticated — when the install has no relay token', async () => {
        // The distinction decides the row's fate. `unauthenticated` means the
        // relay rejected what we sent and is plausibly transient;
        // `no_credential` means there is nothing to send, a permanent fact
        // about the configuration. Collapsing them makes a misconfigured
        // install spend the whole ~21-minute ladder and then report
        // `max_attempts`, which reads as a relay outage.
        setRelayToken(null);
        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'no_credential' });
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('maps a 200 results array straight through', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(200, {
                results: [
                    { token: 'a', status: 'ok' },
                    { token: 'b', status: 'gone' },
                ],
            }),
        );
        expect(await transport.send(req(['a', 'b']))).toEqual([
            { token: 'a', status: 'ok' },
            { token: 'b', status: 'gone' },
        ]);
    });

    it('refreshes the token and retries exactly once on 401', async () => {
        fetchMock
            .mockResolvedValueOnce(jsonResponse(401, { error: 'expired' }))
            .mockResolvedValueOnce(
                jsonResponse(200, { results: [{ token: LONG_TOKEN, status: 'ok' }] }),
            );

        const results = await transport.send(req());

        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(results).toEqual([{ token: LONG_TOKEN, status: 'ok' }]);
    });

    it('throws unauthenticated and invalidates the token when the 401 retry also fails', async () => {
        fetchMock.mockResolvedValue(jsonResponse(401, { error: 'expired' }));

        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'unauthenticated' });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(getRelayToken()).toBeNull();
    });

    it('a 401 on the token that was sent does not discard a newer token a sibling stored meanwhile', async () => {
        fetchMock.mockImplementation(async () => {
            // While the request is in flight another process hands us a newer token.
            adoptRelayTokenIfFresher('relay-token-newer', Date.now() + 23 * 3_600_000);
            return jsonResponse(401, { error: 'expired' });
        });

        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'unauthenticated' });
        expect(getRelayToken()).toBe('relay-token-newer');
    });

    it('throws not_entitled on 403 without retrying', async () => {
        fetchMock.mockResolvedValue(jsonResponse(403, { error: 'no push module' }));
        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'not_entitled' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('throws throttled carrying Retry-After on 429', async () => {
        fetchMock.mockResolvedValue(
            jsonResponse(429, { error: 'slow down' }, { 'Retry-After': '120' }),
        );
        await expect(transport.send(req())).rejects.toMatchObject({
            kind: 'throttled',
            retryAfterSeconds: 120,
        });
    });

    it('throws transient on 500 and on a network error', async () => {
        fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'transient' });

        fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'transient' });
    });

    it('throws invalid on 400', async () => {
        fetchMock.mockResolvedValue(jsonResponse(400, { error: 'bad topic' }));
        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'invalid' });
    });

    it('aborts a hung request via the per-call timeout and surfaces it as transient', async () => {
        // A short REAL timeout, not vi.useFakeTimers(): AbortSignal.timeout()
        // runs on Node's native timer binding, which fake timers do not
        // intercept, so this proves the `signal:` option genuinely fires an
        // abort rather than merely asserting the error-mapping branch.
        const shortTimeoutTransport = new RelayTransport(20);
        fetchMock.mockImplementation(
            (_url: string, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => {
                        reject(new DOMException('The operation was aborted.', 'TimeoutError'));
                    });
                }),
        );

        await expect(shortTimeoutTransport.send(req())).rejects.toMatchObject({
            kind: 'transient',
        });
    });

    it('throws transient when a 200 body has no results array', async () => {
        fetchMock.mockResolvedValue(jsonResponse(200, { success: true }));
        await expect(transport.send(req())).rejects.toMatchObject({ kind: 'transient' });
    });

    it('never puts a raw device token in a log line', async () => {
        const logged: string[] = [];
        vi.spyOn(console, 'info').mockImplementation((...a) => void logged.push(a.join(' ')));
        vi.spyOn(console, 'warn').mockImplementation((...a) => void logged.push(a.join(' ')));
        vi.spyOn(console, 'error').mockImplementation((...a) => void logged.push(a.join(' ')));

        fetchMock.mockResolvedValue(jsonResponse(500, { error: 'boom' }));
        await expect(transport.send(req())).rejects.toThrow();

        expect(logged.join('\n')).not.toContain(LONG_TOKEN);
    });
});
