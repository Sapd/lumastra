// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `DirectApnsTransport` against a real local HTTP/2 server impersonating APNs.
 *
 * 🔴 No test in this file contacts Apple. Everything binds to 127.0.0.1.
 *
 * The assertions that matter are on the UPSTREAM traffic — how many requests
 * were issued, which token each carried, which JWT signed it — not on the
 * returned array. APNs has no batch endpoint, so a transport that sends only
 * the first token still returns a well-formed `PushResult[]` reporting `ok` for
 * every device, and nothing downstream notices.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DirectApnsTransport } from './direct-apns-transport.js';
import { PushTransportError } from './push-transport.js';
import { FakePushTransport } from './fake-push-transport.js';
import { buildPushPayload } from './push-payload.js';
import {
    deviceToken,
    FakeApns,
    inspectProviderJwt,
    testApnsDispatcherFactory,
    testSigningKey,
} from './fake-apns.testing.js';

const NID = '11111111-1111-4111-8111-111111111111';
const KEY_ID = 'ABCDE12345';
const TEAM_ID = 'TEAM123456';
const BUNDLE_ID = 'de.hinterthaner.stellar-tvos.ios';

let production: FakeApns;
let sandbox: FakeApns;
const transports: DirectApnsTransport[] = [];

beforeAll(async () => {
    [production, sandbox] = await Promise.all([FakeApns.start(), FakeApns.start()]);
});

afterAll(async () => {
    await Promise.all(transports.map((t) => t.close()));
    await Promise.all([production.stop(), sandbox.stop()]);
});

afterEach(() => {
    production.reset();
    sandbox.reset();
    production.setHandler(() => ({ status: 200 }));
    sandbox.setHandler(() => ({ status: 200 }));
});

interface Harness {
    transport: DirectApnsTransport;
    advance(ms: number): void;
}

function makeTransport(
    overrides: {
        ttlMs?: number;
        minRemintIntervalMs?: number;
        sendTimeoutMs?: number;
        requestTimeoutMs?: number;
    } = {},
): Harness {
    let clock = 1_700_000_000_000;
    const transport = new DirectApnsTransport({
        credential: { keyP8: testSigningKey(), keyId: KEY_ID, teamId: TEAM_ID },
        hosts: { production: production.origin, sandbox: sandbox.origin },
        dispatcherFactory: testApnsDispatcherFactory,
        providerTokenTtlMs: overrides.ttlMs ?? 40 * 60_000,
        minRemintIntervalMs: overrides.minRemintIntervalMs ?? 20_000,
        sendTimeoutMs: overrides.sendTimeoutMs ?? 2_500,
        requestTimeoutMs: overrides.requestTimeoutMs ?? 1_500,
        now: () => clock,
    });
    transports.push(transport);
    return {
        transport,
        advance: (ms) => {
            clock += ms;
        },
    };
}

function req(
    tokens: string[],
    overrides: {
        environment?: 'production' | 'sandbox';
        expirationEpochSeconds?: number;
        bundleId?: string;
    } = {},
) {
    return {
        bundleId: overrides.bundleId ?? BUNDLE_ID,
        environment: overrides.environment ?? ('production' as const),
        collapseId: NID,
        expirationEpochSeconds: overrides.expirationEpochSeconds ?? 1_786_554_000,
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

describe('DirectApnsTransport fan-out', () => {
    it('issues one upstream request per token and returns one result per token, in order', async () => {
        const { transport } = makeTransport();
        const tokens = [1, 2, 3, 4, 5].map(deviceToken);

        const results = await transport.send(req(tokens));

        // The assertion the whole transport turns on: APNs has no batch
        // endpoint, so "5 tokens in, 5 upstream POSTs out" is the behaviour, and
        // a one-token implementation passes every response-shape assertion.
        expect(production.requests).toHaveLength(5);
        expect(production.tokens.slice().sort()).toEqual(tokens.slice().sort());
        expect(results).toEqual(tokens.map((token) => ({ token, status: 'ok' })));
        for (const request of production.requests) {
            expect(request.method).toBe('POST');
            expect(request.path).toBe(`/3/device/${request.token}`);
        }
    });

    it('multiplexes the fan-out over a single HTTP/2 connection', async () => {
        const { transport } = makeTransport();
        const before = production.sessionCount;

        await transport.send(req([1, 2, 3, 4, 5, 6, 7, 8].map(deviceToken)));

        expect(production.requests).toHaveLength(8);
        expect(production.sessionCount - before).toBe(1);
    });

    it('issues the requests concurrently rather than one after another', async () => {
        // Guards the undici trap the transport documents: a POST is not
        // idempotent by undici's reckoning, and a non-idempotent request waits
        // for the previous response even over HTTP/2. Serialised, six tokens at
        // 80 ms take ~480 ms and blow the 2.5 s whole-call budget at any real
        // fan-out size. Concurrent, they take ~80 ms.
        const { transport } = makeTransport();
        const tokens = [50, 51, 52, 53, 54, 55].map(deviceToken);
        production.setHandler(() => ({ status: 200, delayMs: 80 }));

        const startedAt = Date.now();
        const results = await transport.send(req(tokens));
        const elapsed = Date.now() - startedAt;

        expect(results.every((r) => r.status === 'ok')).toBe(true);
        expect(production.requests).toHaveLength(6);
        // Every request reached the server before the first reply was due.
        const first = production.requests[0]?.receivedAt ?? 0;
        const last = production.requests[5]?.receivedAt ?? 0;
        expect(last - first).toBeLessThan(80);
        expect(elapsed).toBeLessThan(6 * 80);
    });

    it('maps each per-token failure to the right token amongst successes', async () => {
        const { transport } = makeTransport();
        const tokens = [10, 11, 12, 13, 14].map(deviceToken);
        const unregistered = tokens[1];
        const invalid = tokens[3];

        production.setHandler((request) => {
            if (request.token === unregistered) return { status: 410, reason: 'Unregistered' };
            if (request.token === invalid) return { status: 400, reason: 'BadDeviceToken' };
            return { status: 200 };
        });

        expect(await transport.send(req(tokens))).toEqual([
            { token: tokens[0], status: 'ok' },
            { token: unregistered, status: 'unregistered' },
            { token: tokens[2], status: 'ok' },
            { token: invalid, status: 'invalid' },
            { token: tokens[4], status: 'ok' },
        ]);
    });

    it('does not let a slow token reorder results onto the wrong tokens', async () => {
        // The first token's reply is delayed past the others on purpose: an
        // implementation that assembles results in completion order rather than
        // input order mis-attributes every status.
        const { transport } = makeTransport();
        const tokens = [20, 21, 22].map(deviceToken);
        const slow = tokens[0];

        production.setHandler((request) =>
            request.token === slow
                ? { status: 410, reason: 'Unregistered', delayMs: 120 }
                : { status: 200 },
        );

        expect(await transport.send(req(tokens))).toEqual([
            { token: slow, status: 'unregistered' },
            { token: tokens[1], status: 'ok' },
            { token: tokens[2], status: 'ok' },
        ]);
    });

    it('maps a 410 with no recognised reason to gone', async () => {
        const { transport } = makeTransport();
        production.setHandler(() => ({ status: 410, reason: 'ExpiredToken' }));

        expect((await transport.send(req([deviceToken(23)])))[0]).toEqual({
            token: deviceToken(23),
            status: 'gone',
        });
    });

    it('maps DeviceTokenNotForTopic to invalid', async () => {
        const { transport } = makeTransport();
        production.setHandler(() => ({ status: 400, reason: 'DeviceTokenNotForTopic' }));

        expect((await transport.send(req([deviceToken(24)])))[0]?.status).toBe('invalid');
    });

    it('maps 429 and 503 to failed so the row takes the ladder', async () => {
        const { transport } = makeTransport();

        production.setHandler(() => ({ status: 429, reason: 'TooManyRequests' }));
        expect((await transport.send(req([deviceToken(25)])))[0]?.status).toBe('failed');

        production.setHandler(() => ({ status: 503, reason: 'ServiceUnavailable' }));
        expect((await transport.send(req([deviceToken(26)])))[0]?.status).toBe('failed');
    });

    it('maps an unrecognised reason to failed rather than discarding the push', async () => {
        const { transport } = makeTransport();
        production.setHandler(() => ({ status: 507, reason: 'SomethingAppleInventedToday' }));

        expect((await transport.send(req([deviceToken(27)])))[0]?.status).toBe('failed');
    });
});

describe('DirectApnsTransport headers and payload', () => {
    it('sends every APNs header with the value the delivery pass supplied', async () => {
        const { transport } = makeTransport();
        await transport.send(req([deviceToken(60)]));

        const headers = production.requests[0]?.headers ?? {};
        expect(headers['apns-topic']).toBe(BUNDLE_ID);
        expect(headers['apns-push-type']).toBe('alert');
        expect(headers['apns-priority']).toBe('10');
        expect(headers['apns-collapse-id']).toBe(NID);
        expect(headers.authorization).toMatch(/^bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    });

    it('passes apns-expiration through unchanged as absolute epoch seconds', async () => {
        // A fixed absolute timestamp, deliberately not "now + something". The
        // failure this guards is reading the field as a duration and sending
        // `now + 1786554000`, which APNs accepts and silently never expires.
        const { transport } = makeTransport();
        await transport.send(req([deviceToken(61)], { expirationEpochSeconds: 1_786_554_000 }));

        expect(production.requests[0]?.headers['apns-expiration']).toBe('1786554000');
    });

    it('forwards the payload byte-for-byte', async () => {
        const { transport } = makeTransport();
        const request = req([deviceToken(62)]);
        await transport.send(request);

        expect(JSON.parse(production.requests[0]?.body ?? '{}')).toEqual(request.payload);
    });
});

describe('DirectApnsTransport environment routing', () => {
    it('sends production tokens to the production host only', async () => {
        const { transport } = makeTransport();
        await transport.send(req([deviceToken(40)], { environment: 'production' }));

        expect(production.tokens).toEqual([deviceToken(40)]);
        expect(sandbox.requests).toHaveLength(0);
    });

    it('sends sandbox tokens to the sandbox host only', async () => {
        const { transport } = makeTransport();
        await transport.send(req([deviceToken(41)], { environment: 'sandbox' }));

        expect(sandbox.tokens).toEqual([deviceToken(41)]);
        expect(production.requests).toHaveLength(0);
    });

    it('keeps the two hosts separate across calls on one transport', async () => {
        const { transport } = makeTransport();
        await transport.send(req([deviceToken(42)], { environment: 'production' }));
        await transport.send(req([deviceToken(43)], { environment: 'sandbox' }));

        expect(production.tokens).toEqual([deviceToken(42)]);
        expect(sandbox.tokens).toEqual([deviceToken(43)]);
    });
});

describe('DirectApnsTransport provider token', () => {
    it('signs ES256 with the key id in the header and the team id as issuer', async () => {
        const { transport } = makeTransport();
        await transport.send(req([deviceToken(1)]));

        const jwt = inspectProviderJwt(production.authorizations[0] ?? '');
        expect(jwt.alg).toBe('ES256');
        expect(jwt.kid).toBe(KEY_ID);
        expect(jwt.iss).toBe(TEAM_ID);
        expect(jwt.iat).toBe(Math.floor(1_700_000_000_000 / 1000));
    });

    it('mints one JWT for a whole fan-out and reuses it inside the window', async () => {
        const harness = makeTransport();

        await harness.transport.send(req([1, 2, 3, 4, 5].map(deviceToken)));
        harness.advance(39 * 60_000);
        await harness.transport.send(req([deviceToken(6)]));

        expect(production.authorizations).toHaveLength(6);
        expect(new Set(production.authorizations).size).toBe(1);
    });

    it('re-mints once the ~40-minute boundary is crossed', async () => {
        const harness = makeTransport({ ttlMs: 40 * 60_000 });

        await harness.transport.send(req([deviceToken(20)]));
        harness.advance(40 * 60_000 - 1_000);
        await harness.transport.send(req([deviceToken(21)]));
        harness.advance(2_000); // now past 40 minutes
        await harness.transport.send(req([deviceToken(22)]));

        const auth = production.authorizations;
        expect(auth[0]).toBe(auth[1]);
        expect(auth[2]).not.toBe(auth[0]);
        // The fresh token carries the current time — a re-mint that reused the
        // old `iat` would be rejected exactly as the old token was.
        expect(inspectProviderJwt(auth[2] ?? '').iat).toBeGreaterThan(
            inspectProviderJwt(auth[0] ?? '').iat ?? 0,
        );
    });
});

/**
 * Reject every request bearing the *first* JWT the fake sees, and accept any
 * other. That is what an expired provider token looks like from Apple's side:
 * the rejection follows the credential, not the request ordinal. Rejecting by
 * ordinal instead would let an implementation that retries with the cached
 * token pass, simply because the second request is second.
 */
function rejectFirstJwt(server: FakeApns): void {
    let stale: string | null = null;
    server.setHandler((request) => {
        const auth = request.headers.authorization ?? '';
        stale ??= auth;
        return auth === stale ? { status: 403, reason: 'ExpiredProviderToken' } : { status: 200 };
    });
}

describe('DirectApnsTransport 403 ExpiredProviderToken', () => {
    it('re-mints and retries once, and the retry carries a DIFFERENT JWT', async () => {
        const { transport } = makeTransport();
        rejectFirstJwt(production);

        const results = await transport.send(req([deviceToken(30)]));

        expect(results).toEqual([{ token: deviceToken(30), status: 'ok' }]);
        expect(production.requests).toHaveLength(2);
        // The assertion that matters. Retrying with the cached token earns a
        // second 403 in production and passes any test that only checked that
        // a retry happened.
        expect(production.authorizations[0]).not.toBe(production.authorizations[1]);
        expect(inspectProviderJwt(production.authorizations[1] ?? '').alg).toBe('ES256');
    });

    it('retries the same device token, not a different one', async () => {
        const { transport } = makeTransport();
        rejectFirstJwt(production);

        await transport.send(req([deviceToken(31)]));

        expect(production.tokens).toEqual([deviceToken(31), deviceToken(31)]);
    });

    it('re-mints once for a whole fan-out, not once per token', async () => {
        // One expired JWT produces N simultaneous 403s. Minting N replacements
        // trips Apple's "no more than one token update per 20 minutes" rule and
        // turns a recoverable 403 into a 429.
        const { transport } = makeTransport();
        rejectFirstJwt(production);

        const results = await transport.send(req([40, 41, 42, 43].map(deviceToken)));

        expect(results.every((r) => r.status === 'ok')).toBe(true);
        expect(production.requests).toHaveLength(8);
        // Exactly two distinct JWTs: the stale one and its single replacement.
        expect(new Set(production.authorizations).size).toBe(2);
    });

    it('gives up after one retry rather than looping', async () => {
        const { transport } = makeTransport();
        production.setHandler(() => ({ status: 403, reason: 'ExpiredProviderToken' }));

        const results = await transport.send(req([deviceToken(50)]));

        expect(results).toEqual([{ token: deviceToken(50), status: 'failed' }]);
        expect(production.requests).toHaveLength(2);
    });

    it('treats a non-expiry 403 as failed without re-minting', async () => {
        const { transport } = makeTransport();
        production.setHandler(() => ({ status: 403, reason: 'InvalidProviderToken' }));

        const results = await transport.send(req([deviceToken(70)]));

        expect(results).toEqual([{ token: deviceToken(70), status: 'failed' }]);
        expect(production.requests).toHaveLength(1);
    });
});

describe('DirectApnsTransport timeout', () => {
    it('raises transient — not a per-token failure — when nothing was answered in time', async () => {
        // The hard per-call timeout is the only thing bounding push-outbox.ts's
        // CLAIM_TTL_SECONDS budget. Without it a hung Apple lets a second
        // replica re-claim rows that are still in flight.
        const { transport } = makeTransport({ sendTimeoutMs: 250, requestTimeoutMs: 250 });
        production.setHandler(() => ({ status: 200, delayMs: 3_000 }));

        const startedAt = Date.now();
        const error = await transport.send(req([deviceToken(80)])).catch((e: unknown) => e);
        const elapsed = Date.now() - startedAt;

        expect(error).toBeInstanceOf(PushTransportError);
        expect((error as PushTransportError).kind).toBe('transient');
        expect(elapsed).toBeLessThan(1_500);
    });

    it('keeps the outcomes it did learn when only some tokens timed out', async () => {
        // Discarding a partial result to report one uniform failure throws away
        // real per-token outcomes — including `gone`, which retires a device —
        // and re-sends to everyone on the next attempt.
        const { transport } = makeTransport({ sendTimeoutMs: 400, requestTimeoutMs: 400 });
        const tokens = [81, 82].map(deviceToken);
        production.setHandler((request) =>
            request.token === tokens[0] ? { status: 200, delayMs: 3_000 } : { status: 200 },
        );

        expect(await transport.send(req(tokens))).toEqual([
            { token: tokens[0], status: 'failed' },
            { token: tokens[1], status: 'ok' },
        ]);
    });
});

describe('DirectApnsTransport token redaction', () => {
    let output: string[];

    beforeEach(() => {
        output = [];
        const capture = (...args: unknown[]): void => {
            output.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
        };
        vi.spyOn(console, 'log').mockImplementation(capture);
        vi.spyOn(console, 'warn').mockImplementation(capture);
        vi.spyOn(console, 'error').mockImplementation(capture);
        vi.spyOn(console, 'debug').mockImplementation(capture);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('never writes a whole device token to a log line, on any path', async () => {
        // A device token is a credential: it plus our topic is enough to push
        // to that device. Logs get shipped, pasted into issues and bundled into
        // support archives.
        const { transport } = makeTransport({ sendTimeoutMs: 300, requestTimeoutMs: 300 });
        const delivered = deviceToken(90);
        const dead = deviceToken(91);
        const stalled = deviceToken(92);

        production.setHandler((request) => {
            if (request.token === dead) return { status: 410, reason: 'Unregistered' };
            if (request.token === stalled) return { status: 200, delayMs: 3_000 };
            return { status: 200 };
        });

        await transport.send(req([delivered, dead, stalled]));

        const text = output.join('\n');
        expect(text).not.toContain(delivered);
        expect(text).not.toContain(dead);
        expect(text).not.toContain(stalled);
        // Redacted, not absent: a correlation prefix still has to be there or
        // the log cannot identify which device failed.
        expect(text).toContain(`${dead.slice(0, 8)}...`);
    });

    it('never puts a device token in the message of a thrown error', async () => {
        // push-outbox.ts logs `errMsg(err)` verbatim, so a token in a message
        // here defeats every redaction above it.
        const { transport } = makeTransport({ sendTimeoutMs: 250, requestTimeoutMs: 250 });
        const token = deviceToken(93);
        production.setHandler(() => ({ status: 200, delayMs: 3_000 }));

        const error = await transport.send(req([token])).catch((e: unknown) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).not.toContain(token);
        expect((error as Error).message).not.toContain(token.slice(0, 16));
    });
});

describe('FakePushTransport', () => {
    it('records calls and returns ok for every token by default', async () => {
        const t = new FakePushTransport();
        const results = await t.send(req(['a', 'b']));
        expect(results).toEqual([
            { token: 'a', status: 'ok' },
            { token: 'b', status: 'ok' },
        ]);
        expect(t.calls).toHaveLength(1);
        expect(t.calls[0].collapseId).toBe(NID);
    });

    it('can be programmed per token', async () => {
        const t = new FakePushTransport();
        t.setResults((token) => (token === 'b' ? 'gone' : 'ok'));
        expect(await t.send(req(['a', 'b']))).toEqual([
            { token: 'a', status: 'ok' },
            { token: 'b', status: 'gone' },
        ]);
    });

    it('can be programmed to throw', async () => {
        const t = new FakePushTransport();
        t.setError(new PushTransportError('boom', 'transient'));
        await expect(t.send(req(['a']))).rejects.toThrow('boom');
    });
});
