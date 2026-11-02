// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { deepRedact, scrubText } from './redact.js';
import { fingerprintFor } from './fingerprint.js';
import { summaryFor, shortIdFor } from './summary.js';
import { inflateBounded, InflateLimitError, InflateFormatError } from './gzip.js';
import { withBundleSlot, BundleBusyError } from './semaphore.js';
import { deterministicUuidFrom } from './ingest.service.js';
import type { DiagnosticEventInput } from '$lib/schemas/client-diagnostics.js';

const env = {
    eventId: '6f1c1e0a-7b2d-4c7e-9a51-0d6c2b1f9e11',
    platform: 'ios',
    occurredAt: Date.now(),
} as const;
const frames = (n: number, salt = 0) =>
    Array.from({ length: n }, (_, i) => ({
        binaryUUID: 'B1',
        offset: 1000 + i + (i >= 5 ? salt : 0),
    }));

describe('redact', () => {
    it('scrubs tokens, bearer headers and emails at any depth', () => {
        const out = deepRedact({
            a: { url: 'https://x/y?api_key=SECRET123&z=1', note: 'mail me at jo@example.com' },
            b: ['Authorization: Bearer abc.def.ghi'],
            password: 'hunter2',
        }) as Record<string, unknown>;
        const text = JSON.stringify(out);
        expect(text).not.toContain('SECRET123');
        expect(text).not.toContain('jo@example.com');
        expect(text).not.toContain('abc.def.ghi');
        expect(text).not.toContain('hunter2');
    });
    it('scrubText redacts home-directory user names and iOS app-container ids, idempotently', () => {
        const input = [
            'open /Users/alice/Movies/x.mkv failed',
            'cfg at /home/bob/.config/app',
            'crash in /private/var/mobile/Containers/Data/Application/0F8FAD5B-D9CB-469F-A165-70867728950E/Library/Caches/log.txt',
            'C:\\Users\\Carol\\AppData\\x.log',
            'trailing /Users/dave',
        ].join('\n');
        const once = scrubText(input);
        expect(once).not.toMatch(/alice|bob|Carol|dave|0F8FAD5B/);
        expect(once).toContain('/Users/[user]/Movies/x.mkv');
        expect(once).toContain('/home/[user]/.config/app');
        expect(once).toContain(
            '/var/mobile/Containers/Data/Application/[app]/Library/Caches/log.txt',
        );
        expect(once).toContain('C:\\Users\\[user]\\AppData');
        expect(scrubText(once)).toBe(once);
    });
    it('scrubText still redacts normal emails and URL userinfo', () => {
        const out = scrubText(
            'mail jo.doe+x@mail.example.co.uk and http://admin:pw@10.0.0.5:8989/x',
        );
        expect(out).toContain('mail [email] and');
        expect(out).not.toMatch(/jo\.doe|admin|pw@/);
    });
    it.each([
        ['hex-dash run', '0123456789abcdef-'.repeat(12_000)],
        ['alnum run', 'a'.repeat(200_000)],
        ['dotted run', 'a.'.repeat(100_000)],
        ['scheme-like run', 'a://'.repeat(50_000)],
    ])('scrubText is linear-ish on a long %s', (_n, input) => {
        const t = performance.now();
        scrubText(input);
        expect(performance.now() - t).toBeLessThan(1000);
    });
    it('scrubText is idempotent', () => {
        const once = scrubText('token=abc jo@example.com');
        expect(scrubText(once)).toBe(once);
    });
});

describe('fingerprint', () => {
    it('crash: tail frames beyond the top 5 do not change it', () => {
        const a = {
            ...env,
            kind: 'crash',
            payload: {
                source: 'metrickit',
                confidence: 'high',
                callStacks: [{ threadAttributed: true, frames: frames(8) }],
            },
        } as DiagnosticEventInput;
        const b = {
            ...env,
            kind: 'crash',
            payload: {
                source: 'metrickit',
                confidence: 'high',
                callStacks: [{ threadAttributed: true, frames: frames(8, 77) }],
            },
        } as DiagnosticEventInput;
        expect(fingerprintFor(a)).toBe(fingerprintFor(b));
    });
    it('crash without frames falls back to source + exceptionName', () => {
        const a = {
            ...env,
            kind: 'crash',
            payload: {
                source: 'exception_handler',
                confidence: 'low',
                exceptionName: 'NSRangeException',
                callStacks: [],
            },
        } as DiagnosticEventInput;
        const b = {
            ...env,
            kind: 'crash',
            payload: {
                source: 'exception_handler',
                confidence: 'low',
                exceptionName: 'NSInvalidArgumentException',
                callStacks: [],
            },
        } as DiagnosticEventInput;
        expect(fingerprintFor(a)).not.toBe(fingerprintFor(b));
    });
    it('js_error: numbers in the message and line:col do not change it', () => {
        const mk = (msg: string, stack: string) =>
            ({
                ...env,
                platform: 'web',
                kind: 'js_error',
                payload: { name: 'TypeError', message: msg, stack, origin: 'window_error' },
            }) as DiagnosticEventInput;
        expect(fingerprintFor(mk('user 4821 missing', 'at f (app.js:10:5)'))).toBe(
            fingerprintFor(mk('user 9012 missing', 'at f (app.js:99:17)')),
        );
    });
    it('api_failures: status is not part of it, outcome is', () => {
        const mk = (outcome: string, status?: number) =>
            ({
                ...env,
                kind: 'api_failures',
                payload: {
                    windowStart: 1,
                    windowEnd: 2,
                    method: 'GET',
                    route: 'getX',
                    outcome,
                    status,
                },
            }) as unknown as DiagnosticEventInput;
        expect(fingerprintFor(mk('status_5xx', 502))).toBe(fingerprintFor(mk('status_5xx', 503)));
        expect(fingerprintFor(mk('status_5xx', 502))).not.toBe(fingerprintFor(mk('network')));
    });
    it('api_failures: a problem code splits a route, a request id does not', () => {
        const mk = (problemCode?: string, requestId?: string) =>
            ({
                ...env,
                kind: 'api_failures',
                payload: {
                    windowStart: 1,
                    windowEnd: 2,
                    method: 'GET',
                    route: '/api/x',
                    outcome: 'status_5xx',
                    problemCode,
                    requestId,
                },
            }) as unknown as DiagnosticEventInput;
        expect(fingerprintFor(mk('bad_gateway', 'a'))).toBe(fingerprintFor(mk('bad_gateway', 'b')));
        expect(fingerprintFor(mk('bad_gateway'))).not.toBe(fingerprintFor(mk('internal_error')));
    });
    it('js_error error_toast: groups by message key, page and failed call, not by stack', () => {
        const mk = (toastKey: string, stack: string, route = '/(app)/+page') =>
            ({
                ...env,
                platform: 'web',
                kind: 'js_error',
                payload: {
                    name: 'Error',
                    message: 'x',
                    stack,
                    origin: 'error_toast',
                    toastKey,
                    route,
                    cause: {
                        method: 'POST',
                        route: '/api/v1/play-sessions',
                        outcome: 'status_5xx',
                        status: 502,
                    },
                },
            }) as DiagnosticEventInput;
        expect(fingerprintFor(mk('audiobook_session_failed', 'at a'))).toBe(
            fingerprintFor(mk('audiobook_session_failed', 'at b')),
        );
        expect(fingerprintFor(mk('audiobook_session_failed', 'at a'))).not.toBe(
            fingerprintFor(mk('music_playback_failed', 'at a')),
        );
        expect(fingerprintFor(mk('untagged', 'at a'))).not.toBe(
            fingerprintFor(mk('untagged', 'at a', '/(app)/music')),
        );
    });
    it('playback_incident has no fingerprint', () => {
        expect(
            fingerprintFor({
                ...env,
                kind: 'playback_incident',
                attemptId: 'a',
                payload: { triggerType: 'terminal', timeline: [] },
            } as DiagnosticEventInput),
        ).toBeNull();
    });
});

describe('summary', () => {
    it('describes each kind in one short line', () => {
        expect(summaryFor('js_error', { name: 'TypeError', message: 'x is undefined' })).toBe(
            'TypeError: x is undefined',
        );
        expect(
            summaryFor('api_failures', {
                method: 'GET',
                route: 'getX',
                outcome: 'status_5xx',
                status: 502,
            }),
        ).toBe('GET getX → status_5xx 502');
        expect(summaryFor('crash', { source: 'abnormal_exit' })).toBe('abnormal_exit');
        expect(summaryFor('log_bundle', {})).toBe('Log bundle');
        expect(
            summaryFor('js_error', { name: 'E', message: 'y'.repeat(500) })!.length,
        ).toBeLessThanOrEqual(200);
    });
    it('shortIdFor formats the first 8 hex chars', () => {
        expect(shortIdFor('7f3a91c2-0000-4000-8000-000000000000')).toBe('7F3A-91C2');
    });
    it('api_failures: a partial payload falls back to "?" instead of rendering "undefined"', () => {
        expect(summaryFor('api_failures', { outcome: 'network' })).toBe('? ? → network');
        expect(summaryFor('api_failures', { method: 'GET', status: 502 })).toBe('GET ? → ? 502');
        expect(summaryFor('api_failures', {})).toBe('? ? → ?');
    });
});

describe('inflateBounded', () => {
    it('returns size, hash and text', async () => {
        const out = await inflateBounded(gzipSync(Buffer.from('hello')), 1024, { keepText: true });
        expect(out.bytes).toBe(5);
        expect(out.text).toBe('hello');
        expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    });
    it('aborts a bomb past the cap without inflating it all', async () => {
        const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024, 0));
        await expect(inflateBounded(bomb, 1024 * 1024)).rejects.toBeInstanceOf(InflateLimitError);
    });
    it('rejects bytes that are not gzip', async () => {
        await expect(inflateBounded(Buffer.from('plain'), 1024)).rejects.toBeInstanceOf(
            InflateFormatError,
        );
    });
});

describe('withBundleSlot', () => {
    it('allows two concurrent slots and times out the third', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const a = withBundleSlot(() => gate);
        const b = withBundleSlot(() => gate);
        await expect(withBundleSlot(async () => 1, 50)).rejects.toBeInstanceOf(BundleBusyError);
        release();
        await Promise.all([a, b]);
        await expect(withBundleSlot(async () => 2, 50)).resolves.toBe(2);
    });

    it('hands a freed slot directly to a queued waiter, never exceeding MAX_SLOTS even with a synchronous new caller', async () => {
        // Fix-round-1 regression test (Codex finding #1): the old
        // implementation decremented `inUse` on release BEFORE waking the
        // queued waiter, and the woken waiter only re-incremented after its
        // own resume (a later microtask). That left a window where a
        // brand-new caller, arriving in that gap, could see "free" capacity
        // and take it — so once the woken waiter also resumed and
        // incremented, `inUse` (and real concurrency) reached 3.
        //
        // `a`'s fn is `gateA` itself (not wrapped), so `a`'s internal
        // `await fn()` continuation is registered directly on `gateA`. We
        // register our own `.then` on the SAME promise right after — since
        // promise subscribers resolve in registration order, our callback
        // (which starts `d`) runs in the same microtask wave as `a`'s
        // release, exactly the window the old code got wrong: by the time
        // our callback runs, the old code had already done `inUse--` for
        // `a`, but the queued waiter `c` (woken via `resolve()`) had not yet
        // resumed to re-increment.
        let live = 0;
        let maxLive = 0;
        const track = (ms: number) => async (): Promise<true> => {
            live++;
            maxLive = Math.max(maxLive, live);
            await new Promise<void>((r) => setTimeout(r, ms));
            live--;
            return true;
        };

        let releaseA!: () => void;
        const gateA = new Promise<void>((r) => (releaseA = r));

        const a = withBundleSlot(() => gateA); // holds one of the 2 slots until released
        const b = withBundleSlot(track(30)); // holds the other slot throughout
        const c = withBundleSlot(track(5)); // slots full — queued as a waiter

        let d!: Promise<unknown>;
        const chained = gateA.then(() => {
            d = withBundleSlot(track(5));
        });

        releaseA();
        await chained;
        await Promise.all([a, b, c, d]);

        expect(maxLive).toBeLessThanOrEqual(2);
    });

    it('never leaks a slot when fn throws', async () => {
        await expect(
            withBundleSlot(async () => {
                throw new Error('boom');
            }),
        ).rejects.toThrow('boom');
        // The slot from the failed call above must have been released —
        // otherwise this would see only 1 free slot instead of 2.
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const a = withBundleSlot(() => gate);
        const b = withBundleSlot(() => gate);
        await expect(withBundleSlot(async () => 1, 50)).rejects.toBeInstanceOf(BundleBusyError);
        release();
        await Promise.all([a, b]);
    });

    it('rejects immediately once the waiter queue is full (Codex finding #2)', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const holders = [withBundleSlot(() => gate), withBundleSlot(() => gate)];
        // Fill the waiter queue to its cap (MAX_WAITERS = 8).
        const queued = Array.from({ length: 8 }, () => withBundleSlot(async () => 1, 5_000));

        const start = Date.now();
        await expect(withBundleSlot(async () => 1, 5_000)).rejects.toBeInstanceOf(BundleBusyError);
        // Rejected immediately (queue full), not after waiting `waitMs`.
        expect(Date.now() - start).toBeLessThan(200);

        release();
        await Promise.all(holders);
        await Promise.all(queued);
    });
});

describe('deterministicUuidFrom', () => {
    it('matches an independently computed UUIDv5-style vector for a fixed errorId', () => {
        // Computed from first principles, independent of ingest.service.ts's
        // implementation: sha1(namespaceBytes || utf8(name)), then force the version
        // nibble to 5 and the variant nibble into the RFC 4122 range, formatted as a
        // UUID string.
        const namespace = 'a3f0c9d4-6b2e-4b7a-9c1d-8e5f2a7b3c60';
        const name = 'fixed-error-id-for-test-vector';
        const namespaceBytes = Buffer.from(namespace.replace(/-/g, ''), 'hex');
        const hash = createHash('sha1').update(namespaceBytes).update(name, 'utf8').digest();
        const bytes = hash.subarray(0, 16);
        bytes[6] = (bytes[6] & 0x0f) | 0x50;
        bytes[8] = (bytes[8] & 0x3f) | 0x80;
        const hex = bytes.toString('hex');
        const expected = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;

        const actual = deterministicUuidFrom(namespace, name);
        expect(actual).toBe(expected);
    });

    it('always derives a valid UUIDv5 (version nibble 5, RFC 4122 variant)', () => {
        const id = deterministicUuidFrom(
            'a3f0c9d4-6b2e-4b7a-9c1d-8e5f2a7b3c60',
            'another-error-id',
        );
        const match = id.match(
            /^[0-9a-f]{8}-[0-9a-f]{4}-([0-9a-f])[0-9a-f]{3}-([0-9a-f])[0-9a-f]{3}-[0-9a-f]{12}$/,
        );
        expect(match).not.toBeNull();
        expect(match?.[1]).toBe('5');
        expect(['8', '9', 'a', 'b']).toContain(match?.[2]);
    });
});

it('decode fingerprints distinguish key paths while other outcomes ignore them', () => {
    const mk = (
        keyPath: string,
        outcome: 'decode' | 'network' = 'decode',
    ): DiagnosticEventInput => ({
        ...env,
        kind: 'api_failures',
        payload: {
            windowStart: Date.now(),
            windowEnd: Date.now(),
            method: 'GET',
            route: '/api/items',
            outcome,
            keyPath,
        },
    });
    expect(fingerprintFor(mk('items.0.url'))).toBe(fingerprintFor(mk('items.0.url')));
    expect(fingerprintFor(mk('items.0.url'))).not.toBe(fingerprintFor(mk('items.0.name')));
    expect(fingerprintFor(mk('a', 'network'))).toBe(fingerprintFor(mk('b', 'network')));
});
