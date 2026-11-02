// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the auto-enrol/refresh loop — the network-facing half of the
 * licensing loop. Proves the fail-safe contract: it only calls out when
 * enforcement is on and the license is not cleanly valid, it stores a fresh key
 * on success, and a server outage (or any error) leaves the existing key in
 * place without throwing. Also the weekly check-in (license-check-in.ts, real
 * module over an in-memory stand-in for Valkey).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generateKeyPair, SignJWT } from 'jose';
import { FREE_TIER_ENTITLEMENTS } from '$lib/server/licensing/entitlements.js';
import { LICENSE_JWT_ALG, LICENSE_JWT_ISSUER } from './public-key.js';

const {
    cfg,
    push,
    saveConfig,
    getStatus,
    verifyLicenseKey,
    clearLicenseCache,
    diag,
    infoLog,
    warnLog,
    debugLog,
} = vi.hoisted(() => ({
    cfg: {
        LICENSE_ENFORCEMENT_ENABLED: true,
        LICENSE_KEY: 'old-key',
        PUSH_RELAY_TOKEN: '',
        PUSH_RELAY_URL: 'https://push.lumastra.org',
        APP_VERSION: 'v0.1.3-4-gabc1234',
        LICENSE_CHECK_IN_ENABLED: true,
        LICENSE_SERVER_CONTACT_ENABLED: true,
    },
    /** Whether push is on and routed through the relay (the selector's half). */
    push: { relayRoute: false },
    saveConfig: vi.fn(async () => {}),
    getStatus: vi.fn(),
    verifyLicenseKey: vi.fn(),
    clearLicenseCache: vi.fn(),
    diag: { disabledRc: 0 },
    infoLog: vi.fn(),
    warnLog: vi.fn(),
    debugLog: vi.fn(),
}));
const isolation = vi.hoisted(() => ({ worker: false }));
/** Config-change listeners the loop registered (saveConfig's reload calls them). */
const configListeners = vi.hoisted(() => new Set<(keys: readonly string[] | null) => void>());
/** Stands in for Valkey: the relay token every process of the install shares. */
const shared = vi.hoisted(() => ({
    value: null as { token: string; expiresAtMs: number } | null,
    /** Runs when a tick reads the shared token (after its own contact check). */
    onLoad: null as (() => void) | null,
    saves: 0,
    clears: 0,
}));

vi.mock('$lib/server/config', () => ({ config: cfg, dev: true }));
vi.mock('./license-server.js', () => ({ LICENSE_SERVER_URL: 'https://example.test' }));
const contactAnswer = vi.hoisted(() => ({ env: false, stored: true }));
vi.mock('$lib/server/config/index.js', () => ({
    saveConfig,
    isEnvOverridden: (key: string) => key === 'LICENSE_SERVER_CONTACT_ENABLED' && contactAnswer.env,
    getConfigState: () => ({
        jsonOverrides: new Set(contactAnswer.stored ? ['LICENSE_SERVER_CONTACT_ENABLED'] : []),
    }),
    onConfigChange: (listener: (keys: readonly string[] | null) => void) => {
        configListeners.add(listener);
        return () => configListeners.delete(listener);
    },
}));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
const setupReady = vi.hoisted(() => ({ ready: vi.fn(async () => false) }));
vi.mock('$lib/server/database/queries/onboarding.queries.js', () => ({
    isFirstRunSetupOlderThan: setupReady.ready,
}));
vi.mock('$lib/server/database/queries/license-install.queries.js', () => ({
    getInstallUuid: async () => '11111111-2222-4333-8444-555555555555',
}));
vi.mock('./license.service.js', () => ({ getStatus, verifyLicenseKey, clearLicenseCache }));
/** Stands in for Valkey under the check-in marker: TTLs follow the (fake) clock. */
const valkey = vi.hoisted(() => ({
    map: new Map<string, { value: unknown; expiresAt: number }>(),
    failing: false,
}));
vi.mock('$lib/server/cache', () => ({
    CACHE_NAMESPACES: { licenseCheckIn: { name: 'license-check-in-v1' } },
    cacheManager: {
        for: () => ({
            async get(key: string): Promise<unknown> {
                if (valkey.failing) throw new Error('valkey down');
                const e = valkey.map.get(key);
                return e && e.expiresAt > Date.now() ? e.value : null;
            },
            async set(key: string, value: unknown, ttlMs: number): Promise<void> {
                if (valkey.failing) throw new Error('valkey down');
                valkey.map.set(key, { value, expiresAt: Date.now() + ttlMs });
            },
        }),
    },
}));
vi.mock('./diagnostics.js', () => ({
    collectInstallDiagnostics: async () => 1,
    collectDisabledDiagnostics: async () => diag.disabledRc,
    statusCorrelationId: (_u: string, _v: string, rc: number) =>
        rc === 8 ? 'MARKER8DISABLED0' : 'aaaabbbbccccdddd',
}));
// The real token store (its renewal rule is part of what is under test); only
// the "push on + relay route" half of the selector is stubbed.
vi.mock('$lib/server/services/push/push-transport-selector.js', async () => {
    const store = await import('$lib/server/services/push/relay-token.store.js');
    return {
        wantsLicenceMintedRelayToken: () => push.relayRoute && store.relayTokenNeedsRenewal(),
    };
});
vi.mock('$lib/server/services/push/relay-token.shared.js', () => ({
    loadSharedRelayToken: async () => {
        shared.onLoad?.();
        return shared.value;
    },
    saveSharedRelayToken: async (token: string, expiresAtMs: number) => {
        shared.saves += 1;
        shared.value = { token, expiresAtMs };
    },
    clearSharedRelayToken: async () => {
        shared.clears += 1;
        shared.value = null;
    },
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info: infoLog, warn: warnLog, error() {}, debug: debugLog }) },
}));
vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => isolation.worker };
});

import {
    EARLY_REFRESH_MIN_INTERVAL_MS,
    FIRST_TICK_DELAY_MS,
    FIRST_TICK_JITTER_MS,
    REFRESH_INTERVAL_MS,
    RETRY_INTERVAL_MS,
    getLicenseRefreshState,
    jittered,
    maybeRefreshLicense,
    parseRetryAfterMs,
    startLicenseRefreshLoop,
    stopLicenseRefreshLoop,
} from './license-refresh';
import {
    CHECK_IN_FAILURE_BACKOFF_MS,
    CHECK_IN_INTERVAL_MS,
    MIN_UPTIME_BEFORE_CHECK_IN_MS,
    resetLicenseCheckInForTests,
} from './license-check-in';
import {
    getRelayToken,
    invalidateRelayToken,
    setRelayToken,
} from '$lib/server/services/push/relay-token.store.js';

/** An unsigned JWT-shaped token carrying only `exp` (the loop reads it unverified). */
function tokenWithExp(expSeconds: number): string {
    const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${b64({ alg: 'ES384' })}.${b64({ exp: expSeconds })}.sig`;
}

beforeEach(() => {
    // Default: the contact question was answered (stored), so the existing
    // tests see the pre-gate behaviour; setup is young (no fallback).
    contactAnswer.env = false;
    contactAnswer.stored = true;
    setupReady.ready.mockReset().mockResolvedValue(false);
    cfg.LICENSE_ENFORCEMENT_ENABLED = true;
    cfg.LICENSE_KEY = 'old-key';
    cfg.LICENSE_CHECK_IN_ENABLED = true;
    cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
    diag.disabledRc = 0;
    // Default: the install checked in recently, so a valid licence makes no
    // check-in call (the weekly-check-in tests clear this).
    valkey.failing = false;
    valkey.map.clear();
    valkey.map.set('v1:license-check-in', { value: { at: Date.now() }, expiresAt: Infinity });
    resetLicenseCheckInForTests();
    verifyLicenseKey.mockReset();
    verifyLicenseKey.mockResolvedValue({ validity: 'invalid', tier: 'free', expiresAt: null });
    push.relayRoute = false;
    cfg.PUSH_RELAY_TOKEN = '';
    cfg.PUSH_RELAY_URL = 'https://push.lumastra.org';
    setRelayToken(null);
    shared.value = null;
    shared.onLoad = null;
    shared.saves = 0;
    shared.clears = 0;
    saveConfig.mockClear();
    getStatus.mockReset();
    clearLicenseCache.mockClear();
    infoLog.mockClear();
    warnLog.mockClear();
    debugLog.mockClear();
    stopLicenseRefreshLoop(); // resets the failure streak between tests
    vi.restoreAllMocks();
});

describe('maybeRefreshLicense', () => {
    it('makes no network call / stores nothing when enforcement is off', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await maybeRefreshLicense()).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('emits the local status line (no network) when enforcement is off', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        diag.disabledRc = 0; // /j not in active use → benign cid
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await maybeRefreshLicense();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(infoLog).toHaveBeenCalledWith(
            'license status refreshed',
            expect.objectContaining({ cid: 'aaaabbbbccccdddd' }),
        );
    });

    it('carries the enforcement-off marker cid when the /j surface is in active use', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        diag.disabledRc = 8; // RC_DISABLED
        await maybeRefreshLicense();
        expect(infoLog).toHaveBeenCalledWith(
            'license status refreshed',
            expect.objectContaining({ cid: 'MARKER8DISABLED0' }),
        );
    });

    it('does not refresh when the license is cleanly valid', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        expect(await maybeRefreshLicense()).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fetches and stores a new key when unlicensed', async () => {
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ license_key: 'fresh-key' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const result = await maybeRefreshLicense();
        expect(result).toBe(true);
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'fresh-key' });
        expect(clearLicenseCache).toHaveBeenCalled();
    });

    it('keeps the existing key (no degrade) when the server is unreachable', async () => {
        getStatus.mockResolvedValue({ validity: 'expired' });
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));
        const result = await maybeRefreshLicense();
        expect(result).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it.each(['offline', 'free-key'] as const)(
        'an early-access key beyond expiry + grace stays free when refresh is %s',
        async (response) => {
            const verifier =
                await vi.importActual<typeof import('./license.service.js')>(
                    './license.service.js',
                );
            const { publicKey, privateKey } = await generateKeyPair(LICENSE_JWT_ALG);
            const nowMs = Date.now();
            const expiryMs = nowMs - verifier.GRACE_MS - 24 * 60 * 60 * 1000;
            cfg.LICENSE_KEY = await new SignJWT({
                tier: 'early_access',
                ent: {
                    modules: ['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push'],
                    jellyfinMaxConcurrentStreams: null,
                    maxSeats: null,
                },
            })
                .setProtectedHeader({ alg: LICENSE_JWT_ALG })
                .setIssuer(LICENSE_JWT_ISSUER)
                .setAudience('11111111-2222-4333-8444-555555555555')
                .setExpirationTime(Math.floor(expiryMs / 1000))
                .sign(privateKey);
            const oldKey = cfg.LICENSE_KEY;
            // Use the real verifier at the refresh seam; an outage keeps the
            // signed key on disk, but cannot restore its expired entitlements.
            getStatus.mockImplementation(() =>
                verifier.verifyLicenseKey(
                    cfg.LICENSE_KEY,
                    '11111111-2222-4333-8444-555555555555',
                    publicKey,
                    nowMs,
                ),
            );
            const expired = await getStatus();
            expect(expired.validity).toBe('expired');
            expect(expired.verified).toBe(false);
            expect(expired.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);

            const fetchSpy = vi.spyOn(globalThis, 'fetch');
            if (response === 'offline') {
                fetchSpy.mockRejectedValue(new Error('offline'));
                expect(await maybeRefreshLicense()).toBe(false);
                expect(saveConfig).not.toHaveBeenCalled();
                expect(cfg.LICENSE_KEY).toBe(oldKey);
            } else {
                const freeKey = await new SignJWT({
                    tier: 'free',
                    ent: {
                        modules: [...FREE_TIER_ENTITLEMENTS.modules],
                        jellyfinMaxConcurrentStreams:
                            FREE_TIER_ENTITLEMENTS.jellyfinMaxConcurrentStreams,
                        aiAssistant: FREE_TIER_ENTITLEMENTS.aiAssistant,
                    },
                })
                    .setProtectedHeader({ alg: LICENSE_JWT_ALG })
                    .setIssuer(LICENSE_JWT_ISSUER)
                    .setAudience('11111111-2222-4333-8444-555555555555')
                    .setExpirationTime(Math.floor(nowMs / 1000) + 60 * 24 * 60 * 60)
                    .sign(privateKey);
                fetchSpy.mockResolvedValue(okJson({ license_key: freeKey }));
                saveConfig.mockImplementationOnce(async () => {
                    cfg.LICENSE_KEY = freeKey;
                });
                expect(await maybeRefreshLicense()).toBe(true);
                expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: freeKey });
                expect(clearLicenseCache).toHaveBeenCalled();
            }

            expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
                'https://example.test/api/license/refresh',
            );
            const after = await getStatus();
            expect(after.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
        },
    );

    it('does not re-store an unchanged key', async () => {
        getStatus.mockResolvedValue({ validity: 'expiring-soon' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ license_key: 'old-key' }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
        );
        const result = await maybeRefreshLicense();
        expect(result).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('ignores a non-OK response without throwing', async () => {
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }));
        const result = await maybeRefreshLicense();
        expect(result).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('renews a no-key install in its grace window (grace is not "valid")', async () => {
        getStatus.mockResolvedValue({ validity: 'grace', expiresAt: '2026-11-01T00:00:00.000Z' });
        cfg.LICENSE_KEY = '';
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                new Response(JSON.stringify({ license_key: 'early-access-key' }), { status: 200 }),
            );
        expect(await maybeRefreshLicense()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'early-access-key' });
    });

    it('does not store a renewal that does not move exp later (fixed early-access cutoff)', async () => {
        const cutoff = Math.floor(Date.parse('2027-01-31T23:59:59Z') / 1000);
        getStatus.mockResolvedValue({
            validity: 'expiring-soon',
            expiresAt: new Date(cutoff * 1000).toISOString(),
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ license_key: tokenWithExp(cutoff) }), { status: 200 }),
        );
        expect(await maybeRefreshLicense()).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('does not re-store an EXPIRED key whose renewal has the same exp', async () => {
        const cutoff = Math.floor(Date.parse('2027-01-31T23:59:59Z') / 1000);
        getStatus.mockResolvedValue({
            validity: 'expired',
            expiresAt: new Date(cutoff * 1000).toISOString(),
        });
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ license_key: tokenWithExp(cutoff) }), { status: 200 }),
        );
        expect(await maybeRefreshLicense()).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('stores a renewal that extends exp (the cutoff was moved later)', async () => {
        const cutoff = Math.floor(Date.parse('2027-01-31T23:59:59Z') / 1000);
        getStatus.mockResolvedValue({
            validity: 'expiring-soon',
            expiresAt: new Date(cutoff * 1000).toISOString(),
        });
        const later = tokenWithExp(cutoff + 90 * 86400);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            new Response(JSON.stringify({ license_key: later }), { status: 200 }),
        );
        expect(await maybeRefreshLicense()).toBe(true);
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: later });
    });

    it('logs a repeating 404/unreachable failure at warn ONCE, then at debug', async () => {
        getStatus.mockResolvedValue({ validity: 'grace' });
        vi.spyOn(globalThis, 'fetch').mockImplementation(
            async () => new Response('not found', { status: 404 }),
        );
        await maybeRefreshLicense();
        await maybeRefreshLicense();
        await maybeRefreshLicense();
        expect(warnLog).toHaveBeenCalledTimes(1);
        expect(debugLog).toHaveBeenCalledTimes(2);

        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
        await maybeRefreshLicense();
        expect(warnLog).toHaveBeenCalledTimes(1); // same streak — still quiet
    });
});

function okJson(body: unknown): Response {
    return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
    });
}

const RELAY_EXP = () => Math.floor(Date.now() / 1000) + 24 * 3600;

describe('maybeRefreshLicense: the push relay token', () => {
    it('with a VALID license, still calls the server for a due relay token — and does not touch LICENSE_KEY', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okJson({
                license_key: 're-signed-key',
                relayToken: 'relay-1',
                relayTokenExp: RELAY_EXP(),
            }),
        );

        expect(await maybeRefreshLicense()).toBe(false);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(getRelayToken()).toBe('relay-1');
        // The server re-signs the license on every call; storing it would
        // rewrite settings every 6h for nothing.
        expect(saveConfig).not.toHaveBeenCalled();
        expect(clearLicenseCache).not.toHaveBeenCalled();
    });

    it('D-L2: a minted relay token is not handed out for a foreign PUSH_RELAY_URL', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        cfg.PUSH_RELAY_URL = 'https://relay.example';
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okJson({ relayToken: 'relay-1', relayTokenExp: RELAY_EXP() }),
        );

        await maybeRefreshLicense();

        expect(getRelayToken()).toBeNull();
    });

    it('does not call the server while the held relay token is fresh', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        setRelayToken('fresh', RELAY_EXP());
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        await maybeRefreshLicense();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('renews once the held token is past its renewal point (the next 6h tick)', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        // Minted 6h ago: 18h left, under the 20h renewal point.
        setRelayToken('aging', Math.floor(Date.now() / 1000) + 18 * 3600);
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okJson({ license_key: 'k', relayToken: 'relay-2', relayTokenExp: RELAY_EXP() }),
        );

        await maybeRefreshLicense();

        expect(getRelayToken()).toBe('relay-2');
    });

    it('makes no relay call when push does not use the default relay (off, own Apple key, or a configured PUSH_RELAY_TOKEN)', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        push.relayRoute = false;
        await maybeRefreshLicense();

        push.relayRoute = true;
        cfg.PUSH_RELAY_TOKEN = 'operator-token';
        await maybeRefreshLicense();

        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('with enforcement OFF, fetches only the relay token and stores no license', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        diag.disabledRc = 8;
        push.relayRoute = true;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                okJson({ license_key: 'k', relayToken: 'relay-off', relayTokenExp: RELAY_EXP() }),
            );

        expect(await maybeRefreshLicense()).toBe(false);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(getRelayToken()).toBe('relay-off');
        expect(saveConfig).not.toHaveBeenCalled();
        // The enforcement-off diagnostic codes (incl. the local-only 8) never
        // leave the machine: this call carries the install uuid and the app
        // version, nothing else.
        const sent = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body)) as Record<
            string,
            unknown
        >;
        expect(sent).toEqual({
            install_uuid: '11111111-2222-4333-8444-555555555555',
            app_version: 'v0.1.3-4-gabc1234',
        });
    });

    it('stores both the new license and the relay token on a license renewal', async () => {
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        push.relayRoute = true;
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okJson({ license_key: 'fresh-key', relayToken: 'relay-3', relayTokenExp: RELAY_EXP() }),
        );

        expect(await maybeRefreshLicense()).toBe(true);

        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'fresh-key' });
        expect(getRelayToken()).toBe('relay-3');
    });

    it('a failed relay refresh keeps a still-valid token (no degrade) and never throws', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        setRelayToken('still-valid', Math.floor(Date.now() / 1000) + 10 * 3600);
        vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

        await expect(maybeRefreshLicense()).resolves.toBe(false);

        expect(getRelayToken()).toBe('still-valid');
    });

    it('a relay 401 refreshes early, at most once per interval', async () => {
        vi.useFakeTimers();
        try {
            getStatus.mockResolvedValue({ validity: 'valid' });
            push.relayRoute = true;
            setRelayToken('rejected', RELAY_EXP());
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                okJson({
                    license_key: 'k',
                    relayToken: 'replacement',
                    relayTokenExp: RELAY_EXP(),
                }),
            );
            startLicenseRefreshLoop();

            invalidateRelayToken();
            await vi.waitFor(() => expect(getRelayToken()).toBe('replacement'));
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // A relay that rejects every token must not become a request loop.
            invalidateRelayToken();
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // Later, a token held again is rejected again → one more early refresh.
            vi.setSystemTime(Date.now() + EARLY_REFRESH_MIN_INTERVAL_MS + 1);
            setRelayToken('rejected-again', RELAY_EXP());
            invalidateRelayToken();
            await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });
});

describe('startLicenseRefreshLoop in a plugin-isolation worker (B1)', () => {
    it('never starts: no tick, so no saveConfig({ LICENSE_KEY }) from the worker', async () => {
        vi.useFakeTimers();
        isolation.worker = true;
        try {
            getStatus.mockResolvedValue({ validity: 'invalid' });
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(okJson({ license_key: 'worker-sealed-key' }));

            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);

            expect(fetchSpy).not.toHaveBeenCalled();
            expect(saveConfig).not.toHaveBeenCalled();
        } finally {
            isolation.worker = false;
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('control: on the main thread the first tick runs and stores the refreshed key', async () => {
        vi.useFakeTimers();
        try {
            getStatus.mockResolvedValue({ validity: 'invalid' });
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(okJson({ license_key: 'main-key' }));

            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);

            expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'main-key' });
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });
});

describe('relay token shared across processes and restarts (crash loop)', () => {
    it('shares a freshly minted token', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okJson({ license_key: 'k', relayToken: 'minted', relayTokenExp: RELAY_EXP() }),
        );
        await maybeRefreshLicense();
        expect(shared.value?.token).toBe('minted');
    });

    it('a restarted (or sibling) process adopts the shared token and makes NO call', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        shared.value = { token: 'from-previous-boot', expiresAtMs: RELAY_EXP() * 1000 };
        const fetchSpy = vi.spyOn(globalThis, 'fetch');

        // Ten boots in a row: each is a fresh process (nothing held in memory).
        for (let boot = 0; boot < 10; boot++) {
            setRelayToken(null);
            await maybeRefreshLicense();
            expect(getRelayToken()).toBe('from-previous-boot');
        }
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('still renews when the shared token is past its renewal point', async () => {
        getStatus.mockResolvedValue({ validity: 'valid' });
        push.relayRoute = true;
        // 2h left: past the renew-when-<20h point, so the install renews it.
        shared.value = { token: 'old', expiresAtMs: Date.now() + 2 * 3600_000 };
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                okJson({ license_key: 'k', relayToken: 'renewed', relayTokenExp: RELAY_EXP() }),
            );
        await maybeRefreshLicense();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(getRelayToken()).toBe('renewed');
        expect(shared.value?.token).toBe('renewed');
    });

    it('a relay 401 drops the shared copy before refreshing, so it is not adopted back', async () => {
        vi.useFakeTimers();
        try {
            getStatus.mockResolvedValue({ validity: 'valid' });
            push.relayRoute = true;
            setRelayToken('rejected', RELAY_EXP());
            shared.value = { token: 'rejected', expiresAtMs: RELAY_EXP() * 1000 };
            vi.spyOn(globalThis, 'fetch').mockResolvedValue(
                okJson({ license_key: 'k', relayToken: 'replacement', relayTokenExp: RELAY_EXP() }),
            );
            startLicenseRefreshLoop();
            invalidateRelayToken();
            await vi.waitFor(() => expect(getRelayToken()).toBe('replacement'));
            expect(shared.clears).toBe(1);
            expect(shared.value?.token).toBe('replacement');
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });
});

describe('retry scheduling', () => {
    it('jittered() stays within ±fraction', () => {
        expect(jittered(1000, 0.2, () => 0)).toBe(800);
        expect(jittered(1000, 0.2, () => 1)).toBe(1200);
        expect(jittered(1000, 0.2, () => 0.5)).toBe(1000);
    });

    it('parses Retry-After as seconds or an HTTP date', () => {
        expect(parseRetryAfterMs('120')).toBe(120_000);
        expect(parseRetryAfterMs(null)).toBeNull();
        expect(parseRetryAfterMs('soon')).toBeNull();
        const now = Date.parse('2026-10-01T00:00:00Z');
        expect(parseRetryAfterMs('Thu, 01 Oct 2026 01:00:00 GMT', now)).toBe(3600_000);
    });

    it('an unlicensed install retries after ~30 min (jittered), not on every tick or at once', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            getStatus.mockResolvedValue({ validity: 'invalid' });
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockRejectedValue(new Error('ECONNREFUSED'));
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 0.8 - 1_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(RETRY_INTERVAL_MS * 0.4 + 2_000);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('honours a Retry-After longer than the retry delay (capped at the 6h interval)', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            getStatus.mockResolvedValue({ validity: 'invalid' });
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(
                    new Response('{}', { status: 429, headers: { 'retry-after': '7200' } }),
                );
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            await vi.advanceTimersByTimeAsync(2 * 3600_000 - 60_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('a healthy install calls again only on the next ~6h tick', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            getStatus.mockResolvedValue({ validity: 'invalid' });
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockImplementation(async () => okJson({ license_key: `k-${Date.now()}` }));
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 0.9 - 60_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 0.2 + 60_000);
            expect(fetchSpy).toHaveBeenCalledTimes(2);
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });
});

describe('getLicenseRefreshState (admin page)', () => {
    it('reports a failing streak with its cause, then clears it on success', async () => {
        getStatus.mockResolvedValue({ validity: 'invalid' });
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{}', { status: 503 }));
        await maybeRefreshLicense();
        let state = getLicenseRefreshState();
        expect(state.failedAttempts).toBe(1);
        expect(state.lastFailure).toBe('http-503');
        expect(state.failingSince).not.toBeNull();

        vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('ECONNREFUSED'));
        await maybeRefreshLicense();
        state = getLicenseRefreshState();
        expect(state.failedAttempts).toBe(2);
        expect(state.lastFailure).toBe('unreachable');

        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(okJson({ license_key: 'new' }));
        await maybeRefreshLicense();
        state = getLicenseRefreshState();
        expect(state.failedAttempts).toBe(0);
        expect(state.failingSince).toBeNull();
        expect(state.lastSuccessAt).not.toBeNull();
    });
});

describe('weekly check-in', () => {
    const UUID = '11111111-2222-4333-8444-555555555555';
    const EXP = '2027-01-31T23:59:59.000Z';
    const LATER = '2027-06-30T23:59:59.000Z';
    const ENT = {
        edition: 'pro',
        jellyfinMaxConcurrentStreams: null,
        aiAssistant: true,
        maxSeats: null,
        seatOverflowPolicy: 'observe',
        modules: new Set(['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push']),
    };
    const validStatus = {
        validity: 'valid',
        tier: 'early_access',
        expiresAt: EXP,
        entitlements: ENT,
    };
    /** What verifyLicenseKey says about the returned key. */
    const verified = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
        validity: 'valid',
        tier: 'early_access',
        expiresAt: EXP,
        entitlements: ENT,
        ...over,
    });

    function sentBody(spy: { mock: { calls: unknown[][] } }, i = 0): Record<string, unknown> {
        const init = spy.mock.calls[i]?.[1] as RequestInit | undefined;
        return JSON.parse(String(init?.body)) as Record<string, unknown>;
    }
    /** Make the next check-in due again (no marker, no in-process contact). */
    function due(): void {
        valkey.map.clear();
        resetLicenseCheckInForTests();
    }

    beforeEach(() => {
        valkey.map.clear(); // never checked in
    });

    it('a valid licence with no recent contact calls /refresh once, with the app version', async () => {
        getStatus.mockResolvedValue(validStatus);
        verifyLicenseKey.mockResolvedValue(verified());
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'same-exp-key' }));

        expect(await maybeRefreshLicense()).toBe(false);

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
            'https://example.test/api/license/refresh',
        );
        expect(sentBody(fetchSpy)).toEqual({
            install_uuid: UUID,
            rc: 1,
            app_version: 'v0.1.3-4-gabc1234',
        });
        // Same exp → the stored key is left alone (no settings rewrite every week).
        expect(saveConfig).not.toHaveBeenCalled();

        // Contact recorded: the next tick makes no call.
        await maybeRefreshLicense();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('fires about weekly from the 6h loop, not on every tick', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5); // no jitter: exactly 7 d, 6 h
        try {
            getStatus.mockResolvedValue(validStatus);
            verifyLicenseKey.mockResolvedValue(verified());
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockImplementation(async () => okJson({ license_key: 'same-exp-key' }));
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // 27 more 6h ticks (6 d 18 h): none of them calls out.
            await vi.advanceTimersByTimeAsync(27 * REFRESH_INTERVAL_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // The first tick after the marker's 7 days are up checks in again.
            await vi.advanceTimersByTimeAsync(
                CHECK_IN_INTERVAL_MS - 27 * REFRESH_INTERVAL_MS + REFRESH_INTERVAL_MS,
            );
            expect(fetchSpy).toHaveBeenCalledTimes(2);

            // ...and so on, once a week.
            await vi.advanceTimersByTimeAsync(CHECK_IN_INTERVAL_MS + REFRESH_INTERVAL_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(3);
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('no check-in in the first hour of a process (a crash loop never calls out per boot)', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            resetLicenseCheckInForTests(Date.now()); // the process just started
            valkey.failing = true; // and Valkey is down: no shared marker either
            getStatus.mockResolvedValue(validStatus);
            verifyLicenseKey.mockResolvedValue(verified());
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockImplementation(async () => okJson({ license_key: 'same-exp-key' }));
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);
            expect(fetchSpy).not.toHaveBeenCalled();
            expect(MIN_UPTIME_BEFORE_CHECK_IN_MS).toBeLessThan(REFRESH_INTERVAL_MS);

            // The next 6h tick is past the minimum uptime: one check-in.
            await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('a failed check-in keeps the key and entitlements, and waits a day (no 30 min retry)', async () => {
        vi.useFakeTimers();
        vi.spyOn(Math, 'random').mockReturnValue(0.5);
        try {
            getStatus.mockResolvedValue(validStatus);
            const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('offline'));
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect(saveConfig).not.toHaveBeenCalled();
            expect(clearLicenseCache).not.toHaveBeenCalled();

            // Three more 6h ticks (18 h): still backing off.
            await vi.advanceTimersByTimeAsync(3 * REFRESH_INTERVAL_MS);
            expect(fetchSpy).toHaveBeenCalledTimes(1);

            // The first tick a day after the failure tries again; a 503 changes nothing either.
            fetchSpy.mockResolvedValue(new Response('{}', { status: 503 }));
            await vi.advanceTimersByTimeAsync(
                CHECK_IN_FAILURE_BACKOFF_MS - 3 * REFRESH_INTERVAL_MS,
            );
            expect(fetchSpy).toHaveBeenCalledTimes(2);
            expect(saveConfig).not.toHaveBeenCalled();
            expect(cfg.LICENSE_KEY).toBe('old-key');
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('stores a returned key only when it verifies and changes nothing but a later exp', async () => {
        getStatus.mockResolvedValue(validStatus);
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => okJson({ license_key: 'new-key' }));

        // Does not verify for this install → kept.
        verifyLicenseKey.mockResolvedValueOnce({
            validity: 'invalid',
            tier: 'free',
            expiresAt: null,
        });
        expect(await maybeRefreshLicense()).toBe(false);
        // Another tier (e.g. deny-listed → free), even with a later exp → kept.
        due();
        verifyLicenseKey.mockResolvedValueOnce(verified({ tier: 'free', expiresAt: LATER }));
        expect(await maybeRefreshLicense()).toBe(false);
        // Same tier, later exp, but a module fewer → kept.
        due();
        verifyLicenseKey.mockResolvedValueOnce(
            verified({
                expiresAt: LATER,
                entitlements: { ...ENT, modules: new Set(['jellyfin_compat', 'push']) },
            }),
        );
        expect(await maybeRefreshLicense()).toBe(false);
        // Earlier exp → kept.
        due();
        verifyLicenseKey.mockResolvedValueOnce(verified({ expiresAt: '2026-12-01T00:00:00.000Z' }));
        expect(await maybeRefreshLicense()).toBe(false);
        // The verifier throwing → kept.
        due();
        verifyLicenseKey.mockRejectedValueOnce(new Error('boom'));
        expect(await maybeRefreshLicense()).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
        expect(clearLicenseCache).not.toHaveBeenCalled();

        // Same tier and entitlements, later exp (the early-access cutoff was moved) → stored.
        due();
        verifyLicenseKey.mockResolvedValueOnce(verified({ expiresAt: LATER }));
        expect(await maybeRefreshLicense()).toBe(true);
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'new-key' });
        expect(verifyLicenseKey).toHaveBeenLastCalledWith('new-key', UUID);
        expect(fetchSpy).toHaveBeenCalledTimes(6);
    });

    it('does not overwrite a key an admin pasted while the check-in was in flight', async () => {
        getStatus.mockResolvedValue(validStatus);
        verifyLicenseKey.mockResolvedValue(verified({ expiresAt: LATER }));
        vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            cfg.LICENSE_KEY = 'pasted-by-admin';
            return okJson({ license_key: 'new-key' });
        });
        expect(await maybeRefreshLicense()).toBe(false);
        expect(saveConfig).not.toHaveBeenCalled();
    });

    it('no check-in when enforcement is off (no automatic licence calls; push off)', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        await maybeRefreshLicense();
        await maybeRefreshLicense();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('switched off (LICENSE_CHECK_IN_ENABLED=false): no weekly call, renewal and relay token still work', async () => {
        cfg.LICENSE_CHECK_IN_ENABLED = false;
        getStatus.mockResolvedValue(validStatus);
        // A fresh Response per call: a body can only be read once.
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
            okJson({
                license_key: 'renewed',
                relayToken: 'relay-1',
                relayTokenExp: RELAY_EXP(),
            }),
        );
        await maybeRefreshLicense();
        await maybeRefreshLicense();
        expect(fetchSpy).not.toHaveBeenCalled();

        // The relay token is still fetched while push needs it...
        push.relayRoute = true;
        await maybeRefreshLicense();
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        // ...and a key near expiry is still renewed.
        push.relayRoute = false;
        getStatus.mockResolvedValue({ validity: 'expiring-soon', expiresAt: EXP });
        expect(await maybeRefreshLicense()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(2);
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'renewed' });
    });

    it('switched off: an install without a key still enrols via /issue, and an expired key still renews', async () => {
        cfg.LICENSE_CHECK_IN_ENABLED = false;
        cfg.LICENSE_KEY = '';
        let fetchCalls = 1;
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            // A new key per call (the server re-signs on every request).
            .mockImplementation(async () => okJson({ license_key: `k${fetchCalls++}` }));
        expect(await maybeRefreshLicense()).toBe(true);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://example.test/api/license/issue');

        cfg.LICENSE_KEY = 'k1';
        getStatus.mockResolvedValue({ validity: 'expired', expiresAt: EXP });
        expect(await maybeRefreshLicense()).toBe(true);
        expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
            'https://example.test/api/license/refresh',
        );
    });

    it('switched back on: the next tick checks in (the marker is not refreshed while off)', async () => {
        cfg.LICENSE_CHECK_IN_ENABLED = false;
        getStatus.mockResolvedValue(validStatus);
        verifyLicenseKey.mockResolvedValue(verified());
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockImplementation(async () => okJson({ license_key: 'same-exp-key' }));
        await maybeRefreshLicense();
        expect(fetchSpy).not.toHaveBeenCalled();
        cfg.LICENSE_CHECK_IN_ENABLED = true;
        await maybeRefreshLicense();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
            'https://example.test/api/license/refresh',
        );
    });

    it('a push relay-token call counts as the check-in, and adopts a moved cutoff too', async () => {
        getStatus.mockResolvedValue(validStatus);
        push.relayRoute = true;
        verifyLicenseKey.mockResolvedValue(verified({ expiresAt: LATER }));
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
            okJson({
                license_key: 'later-key',
                relayToken: 'relay-1',
                relayTokenExp: RELAY_EXP(),
            }),
        );
        expect(await maybeRefreshLicense()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        expect(saveConfig).toHaveBeenCalledWith({ LICENSE_KEY: 'later-key' });

        push.relayRoute = false;
        await maybeRefreshLicense();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('with Valkey down (cache throws), a process still checks in only once a week', async () => {
        valkey.failing = true;
        getStatus.mockResolvedValue(validStatus);
        verifyLicenseKey.mockResolvedValue(verified());
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'same-exp-key' }));
        await maybeRefreshLicense();
        await maybeRefreshLicense();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('with Valkey down as the real cache reports it (get → null, set dropped), still once a week', async () => {
        getStatus.mockResolvedValue(validStatus);
        verifyLicenseKey.mockResolvedValue(verified());
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
            const res = okJson({ license_key: 'same-exp-key' });
            return res;
        });
        const setSpy = vi.spyOn(valkey.map, 'set').mockImplementation(() => valkey.map);
        try {
            await maybeRefreshLicense();
            await maybeRefreshLicense();
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            setSpy.mockRestore();
        }
    });

    it('a renewal sends the app version, and an install with no key enrols via /issue', async () => {
        cfg.LICENSE_KEY = '';
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'first-key' }));
        expect(await maybeRefreshLicense()).toBe(true);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://example.test/api/license/issue');
        expect(sentBody(fetchSpy).app_version).toBe('v0.1.3-4-gabc1234');

        cfg.LICENSE_KEY = 'first-key';
        getStatus.mockResolvedValue({ validity: 'expiring-soon', expiresAt: EXP });
        fetchSpy.mockResolvedValue(okJson({ license_key: 'second-key' }));
        await maybeRefreshLicense();
        expect(String(fetchSpy.mock.calls[1]?.[0])).toBe(
            'https://example.test/api/license/refresh',
        );
        expect(sentBody(fetchSpy, 1).app_version).toBe('v0.1.3-4-gabc1234');
    });
});

describe('LICENSE_SERVER_CONTACT_ENABLED off: no call to the licensing server at all', () => {
    const UUID = '11111111-2222-4333-8444-555555555555';
    const ENT = {
        edition: 'pro',
        jellyfinMaxConcurrentStreams: null,
        aiAssistant: true,
        maxSeats: null,
        seatOverflowPolicy: 'observe',
        modules: new Set(['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push']),
    };

    beforeEach(() => {
        cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        // Every trigger armed: check-in due, push wants a relay token.
        valkey.map.clear();
        push.relayRoute = true;
    });

    /** Every fetch, whatever the URL: none may happen. */
    function spyFetch() {
        return vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(
                okJson({ license_key: 'k', relayToken: 'r', relayTokenExp: RELAY_EXP() }),
            );
    }

    it.each([
        ['no key (enrolment)', '', { validity: 'free-tier' }],
        ['an invalid key', 'bad', { validity: 'free-tier' }],
        ['an expired key', 'old-key', { validity: 'expired', expiresAt: '2026-01-01T00:00:00Z' }],
        [
            'a key expiring soon (renewal)',
            'old-key',
            { validity: 'expiring-soon', expiresAt: '2099-01-01T00:00:00Z' },
        ],
        [
            'a valid key (check-in due, relay token due)',
            'old-key',
            { validity: 'valid', tier: 'early_access', expiresAt: '2099-01-01T00:00:00Z' },
        ],
    ] as const)('%s: no fetch, nothing stored', async (_name, key, status) => {
        cfg.LICENSE_KEY = key;
        getStatus.mockResolvedValue({ entitlements: ENT, ...status });
        const fetchSpy = spyFetch();

        expect(await maybeRefreshLicense()).toBe(false);

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(saveConfig).not.toHaveBeenCalled();
        expect(getRelayToken()).toBeNull();
        // The routine local status line is still written.
        expect(infoLog).toHaveBeenCalledWith(
            'license status refreshed',
            expect.objectContaining({ install: UUID }),
        );
        // Not a failure: no retry is scheduled and the admin page shows none.
        expect(getLicenseRefreshState().failedAttempts).toBe(0);
    });

    it('enforcement off: not even the push relay token', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        const fetchSpy = spyFetch();
        await maybeRefreshLicense();
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(getRelayToken()).toBeNull();
    });

    it('the loop: first tick, retry timer and a relay 401 make no call', async () => {
        vi.useFakeTimers();
        try {
            cfg.LICENSE_KEY = '';
            getStatus.mockResolvedValue({ validity: 'free-tier' });
            const fetchSpy = spyFetch();
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS + 1);
            setRelayToken('rejected', RELAY_EXP());
            invalidateRelayToken();
            await vi.advanceTimersByTimeAsync(REFRESH_INTERVAL_MS * 2);
            expect(getStatus).toHaveBeenCalled(); // the ticks ran
            expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('switched off mid-tick: the request never leaves, and it is not counted as a failure', async () => {
        cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
        cfg.LICENSE_KEY = '';
        // The admin saves "off" after the tick's own check: only the backstop
        // in postRefresh stops the call.
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        shared.onLoad = () => {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
        };
        const fetchSpy = spyFetch();
        expect(await maybeRefreshLicense()).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(getLicenseRefreshState().failedAttempts).toBe(0);
        expect(warnLog).not.toHaveBeenCalled();
    });

    it('switched off: the held relay token is dropped at once', async () => {
        vi.useFakeTimers();
        try {
            cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
            getStatus.mockResolvedValue({ validity: 'valid' });
            spyFetch();
            startLicenseRefreshLoop();
            setRelayToken('minted', RELAY_EXP());
            shared.value = { token: 'minted', expiresAtMs: Date.now() + 3600_000 };

            cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
            for (const listener of configListeners) listener(['LICENSE_SERVER_CONTACT_ENABLED']);
            await vi.advanceTimersByTimeAsync(0);

            expect(getRelayToken()).toBeNull();
            expect(shared.value).toBeNull();
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });

    it('switched back on: the loop enrols within the first-tick jitter, not at the next 6h tick', async () => {
        vi.useFakeTimers();
        try {
            cfg.LICENSE_KEY = '';
            getStatus.mockResolvedValue({ validity: 'free-tier' });
            const fetchSpy = spyFetch();
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS + 1);
            expect(fetchSpy).not.toHaveBeenCalled();

            cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
            for (const listener of configListeners) listener(['LICENSE_SERVER_CONTACT_ENABLED']);
            // Within the first-tick jitter, so replicas do not all call at once.
            await vi.advanceTimersByTimeAsync(FIRST_TICK_JITTER_MS + 1);
            await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
            expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
                'https://example.test/api/license/issue',
            );
            expect(clearLicenseCache).toHaveBeenCalled();

            // Another save that leaves it on does not tick again.
            for (const listener of configListeners) listener(['APP_NAME']);
            await vi.advanceTimersByTimeAsync(1_000);
            expect(fetchSpy).toHaveBeenCalledTimes(1);
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
        expect(configListeners.size).toBe(0); // stop unsubscribes
    });
});

describe('the first call waits for the answer to "contact lumastra.org?"', () => {
    const EXPIRES = '2027-01-31T23:59:59.000Z';

    it('no key and no answer: nothing is sent; once the answer is stored, it enrols', async () => {
        cfg.LICENSE_KEY = '';
        contactAnswer.stored = false;
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'k' }));

        expect(await maybeRefreshLicense()).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
        // The fallback asked about is a day.
        expect(setupReady.ready).toHaveBeenCalledWith(expect.anything(), 24 * 60 * 60 * 1000);

        contactAnswer.stored = true;
        expect(await maybeRefreshLicense()).toBe(true);
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('https://example.test/api/license/issue');
    });

    it('an answer set in the environment counts', async () => {
        cfg.LICENSE_KEY = '';
        contactAnswer.stored = false;
        contactAnswer.env = true;
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'k' }));
        expect(await maybeRefreshLicense()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('without an answer, an install whose first admin is a day old enrols (no-wizard installs)', async () => {
        cfg.LICENSE_KEY = '';
        contactAnswer.stored = false;
        setupReady.ready.mockResolvedValue(true);
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'k' }));
        expect(await maybeRefreshLicense()).toBe(true);
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('a setup query that fails counts as not yet: nothing is sent', async () => {
        cfg.LICENSE_KEY = '';
        contactAnswer.stored = false;
        setupReady.ready.mockRejectedValue(new Error('db down'));
        getStatus.mockResolvedValue({ validity: 'free-tier' });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'k' }));
        expect(await maybeRefreshLicense()).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('CONTROL: an install that already has a key renews without an answer', async () => {
        cfg.LICENSE_KEY = 'old-key';
        contactAnswer.stored = false;
        getStatus.mockResolvedValue({ validity: 'expiring-soon', expiresAt: EXPIRES });
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ license_key: 'new-key' }));
        await maybeRefreshLicense();
        expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
            'https://example.test/api/license/refresh',
        );
    });

    it('enforcement off, no key, no answer: not even the relay-token call', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        cfg.LICENSE_KEY = '';
        contactAnswer.stored = false;
        push.relayRoute = true;
        const fetchSpy = vi
            .spyOn(globalThis, 'fetch')
            .mockResolvedValue(okJson({ relay_token: 'r' }));
        await maybeRefreshLicense();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('the loop: the stored answer starts the first call at once, no 30-minute wait', async () => {
        vi.useFakeTimers();
        try {
            cfg.LICENSE_KEY = '';
            contactAnswer.stored = false;
            getStatus.mockResolvedValue({ validity: 'free-tier' });
            const fetchSpy = vi
                .spyOn(globalThis, 'fetch')
                .mockResolvedValue(okJson({ license_key: 'k' }));
            startLicenseRefreshLoop();
            await vi.advanceTimersByTimeAsync(FIRST_TICK_DELAY_MS + FIRST_TICK_JITTER_MS + 1);
            expect(fetchSpy).not.toHaveBeenCalled();
            // Waiting is retried, not left to the 6h interval.
            const next = getLicenseRefreshState().nextAttemptAt;
            expect(next).not.toBeNull();
            expect(Date.parse(next ?? '') - Date.now()).toBeLessThan(60 * 60 * 1000);

            // The wizard stores "on" (the default): the value does not change.
            contactAnswer.stored = true;
            for (const listener of configListeners) listener(['LICENSE_SERVER_CONTACT_ENABLED']);
            await vi.advanceTimersByTimeAsync(FIRST_TICK_JITTER_MS + 1);
            await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(1));
            expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
                'https://example.test/api/license/issue',
            );
        } finally {
            stopLicenseRefreshLoop();
            vi.useRealTimers();
        }
    });
});
