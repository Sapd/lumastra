// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The push relay token enrolment loop: when it calls lumastra.org (and when it
 * must not), what it sends, and how it renews.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    cfg: {
        FEATURE_PUSH_NOTIFICATIONS: true,
        LICENSE_SERVER_CONTACT_ENABLED: true,
        PUSH_RELAY_TOKEN: '',
        PUSH_RELAY_URL: 'https://push.lumastra.org',
        APP_VERSION: '0.2.0-test',
    },
    transport: 'relay' as 'relay' | 'direct',
    answered: true,
    setupOld: true,
    setupThrows: false,
    worker: false,
    dbNull: false,
    shared: null as { token: string; expiresAtMs: number } | null,
    saved: [] as Array<{ token: string; expiresAtMs: number }>,
    cleared: 0,
    getDbCalls: 0,
    lockHeld: false,
    /** Runs when the lock is taken: a sibling storing a token just before us. */
    onAcquire: null as null | (() => void),
    info: vi.fn(),
    configListeners: [] as Array<() => void>,
    fetch: vi.fn(),
}));

vi.mock('$lib/server/config.js', () => ({ config: h.cfg }));
vi.mock('$lib/server/config/index.js', () => ({
    getConfigState: () => ({
        jsonOverrides: { has: () => h.answered },
    }),
    isEnvOverridden: () => false,
    onConfigChange: (fn: () => void) => {
        h.configListeners.push(fn);
        return () => {
            h.configListeners = h.configListeners.filter((l) => l !== fn);
        };
    },
}));
vi.mock('$lib/server/database', () => ({
    getDb: () => {
        h.getDbCalls += 1;
        return h.dbNull ? null : { sql: true };
    },
}));
vi.mock('$lib/server/database/queries/install-identity.queries.js', () => ({
    getInstallUuid: async () => 'install-uuid-1',
}));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    isFirstRunSetupOlderThan: async () => {
        if (h.setupThrows) throw new Error('db down');
        return h.setupOld;
    },
}));
vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>()),
    isIsolationWorker: () => h.worker,
}));
vi.mock('./push-transport-selector.js', () => ({
    currentPushTransportSelection: () => ({ kind: h.transport, reason: 'no-signing-key' }),
}));
vi.mock('./relay-token.shared.js', () => ({
    loadSharedRelayToken: async () => h.shared,
    saveSharedRelayToken: async (token: string, expiresAtMs: number) => {
        h.saved.push({ token, expiresAtMs });
    },
    clearSharedRelayToken: async () => {
        h.cleared += 1;
        h.shared = null;
    },
    clearSharedRelayTokenIfEquals: async (rejected: string | null) => {
        if (!h.shared) return;
        if (rejected !== null && h.shared.token !== rejected) return;
        h.cleared += 1;
        h.shared = null;
    },
    acquireEnrolLock: async () => {
        if (h.lockHeld) return null;
        h.lockHeld = true;
        h.onAcquire?.();
        return 'lock-1';
    },
    releaseEnrolLock: async () => {
        h.lockHeld = false;
    },
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: h.info, warn() {}, error() {}, debug() {} }) },
}));

import {
    RELAY_TOKEN_ENDPOINT,
    EARLY_REFRESH_MIN_INTERVAL_MS,
    FIRST_TICK_DELAY_MS,
    FIRST_TICK_JITTER_MS,
    REFRESH_INTERVAL_MS,
    enrolRelayTokenOnce,
    isRelayTokenEnrolLoopRunning,
    relayTokenEnrolEligible,
    startRelayTokenEnrolLoop,
    stopRelayTokenEnrolLoop,
} from './relay-token-enrol.js';
import {
    getRelayToken,
    hasLiveMintedRelayToken,
    invalidateRelayToken,
    setRelayToken,
} from './relay-token.store.js';

function jwt(): string {
    // Opaque to the store: it only reads `exp` when the server gives none.
    return 'header.payload.signature';
}

function answer(token = jwt(), exp = Math.floor(Date.now() / 1000) + 24 * 3600): Response {
    return new Response(JSON.stringify({ relayToken: token, relayTokenExp: exp }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

beforeEach(() => {
    stopRelayTokenEnrolLoop();
    setRelayToken(null);
    Object.assign(h.cfg, {
        FEATURE_PUSH_NOTIFICATIONS: true,
        LICENSE_SERVER_CONTACT_ENABLED: true,
        PUSH_RELAY_TOKEN: '',
        PUSH_RELAY_URL: 'https://push.lumastra.org',
    });
    h.transport = 'relay';
    h.answered = true;
    h.setupOld = true;
    h.setupThrows = false;
    h.worker = false;
    h.dbNull = false;
    h.shared = null;
    h.saved = [];
    h.cleared = 0;
    h.getDbCalls = 0;
    h.lockHeld = false;
    h.onAcquire = null;
    h.info.mockClear();
    h.configListeners = [];
    h.fetch.mockReset().mockImplementation(async () => answer());
    vi.stubGlobal('fetch', h.fetch);
});

afterEach(() => {
    stopRelayTokenEnrolLoop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('enrolRelayTokenOnce: when it must not call', () => {
    it('push off: no call', async () => {
        h.cfg.FEATURE_PUSH_NOTIFICATIONS = false;
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('contact off: no call', async () => {
        h.cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('own relay URL: no call', async () => {
        h.cfg.PUSH_RELAY_URL = 'https://push.example.org';
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('own PUSH_RELAY_TOKEN: no call', async () => {
        h.cfg.PUSH_RELAY_TOKEN = 'operator-token';
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('own Apple signing key (direct delivery): no call', async () => {
        h.transport = 'direct';
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('a live token is held: no call', async () => {
        setRelayToken(jwt(), Math.floor(Date.now() / 1000) + 24 * 3600);
        expect(await enrolRelayTokenOnce()).toBe('fresh');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('a sibling process shared a fresh token: adopted, no call', async () => {
        h.shared = { token: 'from-sibling', expiresAtMs: Date.now() + 23 * 3600 * 1000 };
        expect(await enrolRelayTokenOnce()).toBe('fresh');
        expect(h.fetch).not.toHaveBeenCalled();
        expect(getRelayToken()).toBe('from-sibling');
    });

    it('contact question unanswered and setup young: waits, no call', async () => {
        h.answered = false;
        h.setupOld = false;
        expect(await enrolRelayTokenOnce()).toBe('waiting-for-answer');
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('contact question unanswered, setup state unknown: waits, no call', async () => {
        h.answered = false;
        h.setupThrows = true;
        expect(await enrolRelayTokenOnce()).toBe('waiting-for-answer');
        expect(h.fetch).not.toHaveBeenCalled();
    });
});

describe('enrolRelayTokenOnce: the call', () => {
    it('sends only the install uuid and the app version, once, and stores the token', async () => {
        const exp = Math.floor(Date.now() / 1000) + 24 * 3600;
        h.fetch.mockResolvedValueOnce(answer('minted.jwt.value', exp));

        expect(await enrolRelayTokenOnce()).toBe('minted');

        expect(h.fetch).toHaveBeenCalledTimes(1);
        const [url, init] = h.fetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe(RELAY_TOKEN_ENDPOINT);
        expect(url).toBe('https://lumastra.org/api/push/relay-token');
        expect(init.method).toBe('POST');
        expect(JSON.parse(init.body as string)).toEqual({
            install_uuid: 'install-uuid-1',
            app_version: '0.2.0-test',
        });
        expect(getRelayToken()).toBe('minted.jwt.value');
        // Shared through Valkey for the other processes.
        expect(h.saved).toHaveLength(1);
        expect(h.saved[0]!.token).toBe('minted.jwt.value');
    });

    it('an answered unanswered-question install calls once the setup is a day old', async () => {
        h.answered = false;
        h.setupOld = true;
        expect(await enrolRelayTokenOnce()).toBe('minted');
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it('a non-OK answer is a failure and stores nothing', async () => {
        h.fetch.mockResolvedValueOnce(new Response('nope', { status: 503 }));
        expect(await enrolRelayTokenOnce()).toBe('failed');
        expect(hasLiveMintedRelayToken()).toBe(false);
        expect(h.saved).toHaveLength(0);
    });

    it('an answer without a token is a failure', async () => {
        h.fetch.mockResolvedValueOnce(new Response('{}', { status: 200 }));
        expect(await enrolRelayTokenOnce()).toBe('failed');
        expect(hasLiveMintedRelayToken()).toBe(false);
    });

    it('a network error is a failure, never a throw', async () => {
        h.fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
        expect(await enrolRelayTokenOnce()).toBe('failed');
    });

    it('eligibility is pure config', () => {
        expect(relayTokenEnrolEligible()).toBe(true);
        h.cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        expect(relayTokenEnrolEligible()).toBe(false);
    });
});

describe('enrolRelayTokenOnce: one minter across processes', () => {
    it('two enrolments with an empty shared store make exactly one request', async () => {
        let release: (() => void) | null = null;
        h.fetch.mockImplementation(
            () =>
                new Promise<Response>((resolve) => {
                    release = () => resolve(answer());
                }),
        );

        const first = enrolRelayTokenOnce();
        // Let the first one reach the request while it holds the lock.
        await vi.waitFor(() => expect(h.fetch).toHaveBeenCalledTimes(1));
        const second = await enrolRelayTokenOnce();
        expect(second).toBe('busy');

        release!();
        expect(await first).toBe('minted');
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(h.lockHeld).toBe(false);
    });

    it('a token a sibling stored while this process waited for the lock is adopted, no request', async () => {
        h.onAcquire = () => {
            h.shared = { token: 'from-sibling', expiresAtMs: Date.now() + 23 * 3600 * 1000 };
        };
        expect(await enrolRelayTokenOnce()).toBe('fresh');
        expect(h.fetch).not.toHaveBeenCalled();
        expect(getRelayToken()).toBe('from-sibling');
        expect(h.lockHeld).toBe(false);
    });

    it('the lock is released when the request fails', async () => {
        h.fetch.mockRejectedValueOnce(new Error('offline'));
        expect(await enrolRelayTokenOnce()).toBe('failed');
        expect(h.lockHeld).toBe(false);
    });
});

describe('enrolRelayTokenOnce: plugin-isolation worker', () => {
    it('refuses itself: no request, no database, no lock', async () => {
        h.worker = true;
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(h.fetch).not.toHaveBeenCalled();
        expect(h.getDbCalls).toBe(0);
        expect(h.lockHeld).toBe(false);
    });
});

describe('enrolRelayTokenOnce: the answer is validated', () => {
    const soon = () => Math.floor(Date.now() / 1000);

    it.each([
        ['already expired', () => soon() - 60],
        ['about to expire', () => soon() + 30],
        ['a week away', () => soon() + 7 * 24 * 3600],
        ['not a number', () => 'tomorrow' as unknown as number],
    ])('an expiry that is %s is a failure and nothing is kept or shared', async (_name, exp) => {
        h.fetch.mockResolvedValueOnce(answer('x.y.z', exp()));
        expect(await enrolRelayTokenOnce()).toBe('failed');
        expect(hasLiveMintedRelayToken()).toBe(false);
        expect(h.saved).toHaveLength(0);
    });

    it('a body bigger than 16 KB is refused', async () => {
        h.fetch.mockResolvedValueOnce(
            new Response(JSON.stringify({ relayToken: 'a'.repeat(20_000) }), { status: 200 }),
        );
        expect(await enrolRelayTokenOnce()).toBe('failed');
        expect(hasLiveMintedRelayToken()).toBe(false);
    });

    it('a failed attempt without a token arms a retry', async () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        h.fetch.mockResolvedValueOnce(answer('x.y.z', soon() - 60));
        await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS + 1);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(hasLiveMintedRelayToken()).toBe(true);
    });

    it('never follows a redirect', async () => {
        await enrolRelayTokenOnce();
        const init = h.fetch.mock.calls[0]![1] as RequestInit;
        expect(init.redirect).toBe('error');
    });
});

describe('enrolRelayTokenOnce: the opt-out', () => {
    it('a switch flipped while the request is in flight stores nothing', async () => {
        h.fetch.mockImplementationOnce(async () => {
            h.cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
            return answer();
        });
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(hasLiveMintedRelayToken()).toBe(false);
        expect(h.saved).toHaveLength(0);
    });

    it('with contact off, a held token and the shared copy are dropped', async () => {
        setRelayToken(jwt(), Math.floor(Date.now() / 1000) + 24 * 3600);
        h.shared = { token: jwt(), expiresAtMs: Date.now() + 23 * 3600 * 1000 };
        h.cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        expect(await enrolRelayTokenOnce()).toBe('ineligible');
        expect(hasLiveMintedRelayToken()).toBe(false);
        expect(h.shared).toBeNull();
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('names why it does not call once, not on every tick', async () => {
        h.cfg.FEATURE_PUSH_NOTIFICATIONS = false;
        await enrolRelayTokenOnce();
        await enrolRelayTokenOnce();
        expect(h.info).toHaveBeenCalledTimes(1);
        expect(String(h.info.mock.calls[0]![0])).toContain('push notifications are off');
        h.cfg.FEATURE_PUSH_NOTIFICATIONS = true;
        h.cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        await enrolRelayTokenOnce();
        expect(h.info).toHaveBeenCalledTimes(2);
    });
});

describe('the loop', () => {
    async function firstTick(): Promise<void> {
        await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS + 1);
    }

    it('does not start inside a plugin-isolation worker', () => {
        h.worker = true;
        startRelayTokenEnrolLoop();
        expect(isRelayTokenEnrolLoopRunning()).toBe(false);
    });

    it('is idempotent', () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        startRelayTokenEnrolLoop();
        expect(isRelayTokenEnrolLoopRunning()).toBe(true);
        expect(h.configListeners).toHaveLength(1);
        stopRelayTokenEnrolLoop();
        expect(isRelayTokenEnrolLoopRunning()).toBe(false);
        expect(h.configListeners).toHaveLength(0);
    });

    it('one call on the first tick, one more on the next 6 h tick, no extras in between', async () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        expect(h.fetch).not.toHaveBeenCalled();

        await firstTick();
        expect(h.fetch).toHaveBeenCalledTimes(1);

        // A token minted for 24 h is not renewed for the next ~4 h.
        await vi.advanceTimersByTimeAsync(2 * 3600 * 1000);
        expect(h.fetch).toHaveBeenCalledTimes(1);

        // The next scheduled tick (about 6 h after the first) renews it: one call.
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 1.15);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it('push off: ticks make no call at all', async () => {
        vi.useFakeTimers();
        h.cfg.FEATURE_PUSH_NOTIFICATIONS = false;
        startRelayTokenEnrolLoop();
        await firstTick();
        await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2);
        expect(h.fetch).not.toHaveBeenCalled();
    });

    it('a relay 401 (token invalidated) triggers an early refresh, rate limited', async () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        await firstTick();
        expect(h.fetch).toHaveBeenCalledTimes(1);
        h.shared = { token: jwt(), expiresAtMs: Date.now() + 23 * 3600 * 1000 };

        invalidateRelayToken(); // what RelayTransport does on a 401
        await vi.advanceTimersByTimeAsync(10);
        // The shared copy was the rejected token, so it was dropped first and the
        // tick did not adopt it back.
        expect(h.cleared).toBe(1);
        expect(h.fetch).toHaveBeenCalledTimes(2);

        // A relay that keeps rejecting cannot turn this into a request loop.
        setRelayToken(jwt(), Math.floor(Date.now() / 1000) + 24 * 3600);
        invalidateRelayToken();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.fetch).toHaveBeenCalledTimes(2);
    });

    it('a 401 inside the rate-limit window is not lost: it runs when the window ends', async () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        await firstTick();
        invalidateRelayToken();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.fetch).toHaveBeenCalledTimes(2);

        setRelayToken(jwt(), Math.floor(Date.now() / 1000) + 24 * 3600);
        invalidateRelayToken();
        await vi.advanceTimersByTimeAsync(EARLY_REFRESH_MIN_INTERVAL_MS - 60_000);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(61_000);
        expect(h.fetch).toHaveBeenCalledTimes(3);
    });

    it('a 401 only drops the shared copy when it is the rejected token', async () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        await firstTick();
        // A sibling already stored a newer token than the one this process was rejected on.
        h.shared = { token: 'newer-from-sibling', expiresAtMs: Date.now() + 23 * 3600 * 1000 };
        invalidateRelayToken();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.cleared).toBe(0);
        // ...and the tick adopted it instead of calling lumastra.org again.
        expect(getRelayToken()).toBe('newer-from-sibling');
        expect(h.fetch).toHaveBeenCalledTimes(1);
    });

    it('the first answer to the contact question fetches after the jitter, not 30 minutes later', async () => {
        vi.useFakeTimers();
        h.answered = false;
        h.setupOld = false;
        startRelayTokenEnrolLoop();
        await firstTick();
        expect(h.fetch).not.toHaveBeenCalled();

        h.answered = true; // the operator saved the switch (enabled unchanged)
        for (const l of h.configListeners) l();
        await vi.advanceTimersByTimeAsync(FIRST_TICK_JITTER_MS + 1);
        expect(h.fetch).toHaveBeenCalledTimes(1);
        expect(hasLiveMintedRelayToken()).toBe(true);
    });

    it('a failed first call without a token is retried soon, not in 6 h', async () => {
        vi.useFakeTimers();
        h.fetch.mockRejectedValueOnce(new Error('offline'));
        startRelayTokenEnrolLoop();
        await firstTick();
        expect(h.fetch).toHaveBeenCalledTimes(1);
        // 30 min +- 20 %: well before the next 6 h tick.
        await vi.advanceTimersByTimeAsync(40 * 60 * 1000);
        expect(h.fetch).toHaveBeenCalledTimes(2);
        expect(hasLiveMintedRelayToken()).toBe(true);
    });

    it('contact switched off drops the held token and its shared copy; on again calls soon', async () => {
        vi.useFakeTimers();
        startRelayTokenEnrolLoop();
        await firstTick();
        expect(hasLiveMintedRelayToken()).toBe(true);

        h.cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        for (const l of h.configListeners) l();
        expect(hasLiveMintedRelayToken()).toBe(false);
        expect(h.cleared).toBe(1);
        const calls = h.fetch.mock.calls.length;

        h.cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
        for (const l of h.configListeners) l();
        await vi.advanceTimersByTimeAsync(FIRST_TICK_JITTER_MS + 1);
        expect(h.fetch.mock.calls.length).toBe(calls + 1);
        expect(hasLiveMintedRelayToken()).toBe(true);
    });
});
