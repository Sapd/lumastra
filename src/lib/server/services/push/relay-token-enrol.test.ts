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
vi.mock('$lib/server/database', () => ({ getDb: () => (h.dbNull ? null : { sql: true }) }));
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
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
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
        // The shared copy was dropped first, so the tick did not adopt it back.
        expect(h.cleared).toBe(1);
        expect(h.fetch).toHaveBeenCalledTimes(2);

        // A relay that keeps rejecting cannot turn this into a request loop.
        invalidateRelayToken();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.fetch).toHaveBeenCalledTimes(2);

        // (The rejected token is gone; the relay would hand out a new one at the
        // next tick. Here a token arrives some other way and is rejected again.)
        await vi.advanceTimersByTimeAsync(EARLY_REFRESH_MIN_INTERVAL_MS + 1000);
        setRelayToken(jwt(), Math.floor(Date.now() / 1000) + 24 * 3600);
        invalidateRelayToken();
        await vi.advanceTimersByTimeAsync(10);
        expect(h.fetch).toHaveBeenCalledTimes(3);
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
