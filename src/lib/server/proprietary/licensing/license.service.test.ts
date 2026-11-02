// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for offline license verification — the security-critical core.
 *
 * Uses a TEST keypair (committed, NOT the production key) to sign tokens and
 * verifies them through {@link verifyLicenseKey} with the matching test public
 * key injected. Covers the happy path plus every fail-open path: bad signature,
 * wrong audience, expired (grace + past-grace), malformed, and empty.
 *
 * Also covers the new entitlement mapping: modules array, back-compat
 * aiAssistant flag, seat caps, overflow policy, and edition resolution.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Enforcement ON so the free-tier fallback resolves to FREE (1 stream, no AI),
// making the degrade assertions meaningful.
const cfg = vi.hoisted(() => ({
    LICENSE_ENFORCEMENT_ENABLED: true,
    LICENSE_SERVER_CONTACT_ENABLED: true,
}));
vi.mock('$lib/server/config', () => ({ config: cfg }));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
// Cut the heavy database import chain — verifyLicenseKey never touches the DB directly.
vi.mock('$lib/server/database', () => ({ getDb: () => null }));
// Stub seat count query so unit tests don't need a DB.
vi.mock('$lib/server/database/queries/license-seats.queries.js', () => ({
    countActiveSeats: async () => 0,
}));
// Stub the cache layer — verifyLicenseKey does not use it (only getStatusCached does).
// This also prevents the cache/warming module from pulling in the task registry.
vi.mock('$lib/server/cache', () => ({
    cacheManager: {
        for: () => ({
            get: async () => null,
            set: async () => {},
            delete: async () => {},
        }),
    },
    CACHE_NAMESPACES: {
        licenseSeatCount: { name: 'license-seat-count-v1', l1TTL: 0, l2TTL: 0 },
    },
}));

import { SignJWT, importPKCS8, importSPKI, generateKeyPair } from 'jose';
import { verifyLicenseKey, GRACE_MS, NO_KEY_GRACE_MS, clearLicenseCache } from './license.service';
import { LICENSE_JWT_ALG } from './public-key';
import { FREE_TIER_ENTITLEMENTS, UNLIMITED_ENTITLEMENTS } from '$lib/server/licensing/entitlements';

// TEST-ONLY keypair (ECDSA P-384). Safe to commit — never used in production.
const TEST_PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIG2AgEAMBAGByqGSM49AgEGBSuBBAAiBIGeMIGbAgEBBDCxBPx/6L6KGYHVmL3t
F2kZMdfW7tNsKERi+HvrBQod/RKPPS0Wba1xDVUxnZiX6kuhZANiAASxYhvNqPvn
28/WrslN7GWLeq7nukFIradgLZzxBi6wit0xBnmqZIE0rD6DERd6a0R+q//1drI3
j9bnU+nFYHeN3UWlZagGBYGNPfm2ZBt5hAVQVEzTJ/gBpEMY4iK7cfE=
-----END PRIVATE KEY-----`;
const TEST_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEsWIbzaj759vP1q7JTexli3qu57pBSK2n
YC2c8QYusIrdMQZ5qmSBNKw+gxEXemtEfqv/9XayN4/W51PpxWB3jd1FpWWoBgWB
jT35tmQbeYQFUFRM0yf4AaRDGOIiu3Hx
-----END PUBLIC KEY-----`;

const INSTALL_UUID = '11111111-2222-4333-8444-555555555555';
const SECONDS = (ms: number): number => Math.floor(ms / 1000);

let testPublicKey: CryptoKey;
let testPrivateKey: CryptoKey;

async function sign(opts: {
    aud?: string;
    expSecondsFromNow: number;
    tier?: string;
    ent?: unknown;
    key?: CryptoKey;
}): Promise<string> {
    const now = SECONDS(Date.now());
    return new SignJWT({ tier: opts.tier ?? 'free', ent: opts.ent })
        .setProtectedHeader({ alg: LICENSE_JWT_ALG, typ: 'JWT' })
        .setIssuer('lumastra')
        .setAudience(opts.aud ?? INSTALL_UUID)
        .setSubject(opts.aud ?? INSTALL_UUID)
        .setIssuedAt(now)
        .setExpirationTime(now + opts.expSecondsFromNow)
        .sign(opts.key ?? testPrivateKey);
}

beforeEach(async () => {
    cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
    clearLicenseCache();
    testPublicKey = await importSPKI(TEST_PUBLIC_KEY_PEM, LICENSE_JWT_ALG);
    testPrivateKey = await importPKCS8(TEST_PRIVATE_KEY_PEM, LICENSE_JWT_ALG);
});

// ---------------------------------------------------------------------------
// Core verification (existing tests updated for new shape)
// ---------------------------------------------------------------------------

describe('verifyLicenseKey', () => {
    it('accepts a valid token and extracts entitlements (new modules format)', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60, // 60 days
            tier: 'pro',
            ent: {
                jellyfinMaxConcurrentStreams: null,
                modules: ['ai_assistant', 'jellyfin_compat', 'branding_removal'],
                maxSeats: null,
                seatOverflowPolicy: 'observe',
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('valid');
        expect(status.verified).toBe(true);
        expect(status.tier).toBe('pro');
        expect(status.entitlements.edition).toBe('pro');
        expect(status.entitlements.aiAssistant).toBe(true);
        expect(status.entitlements.modules.has('ai_assistant')).toBe(true);
        expect(status.entitlements.modules.has('branding_removal')).toBe(true);
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBeNull();
    });

    it('treats a null stream cap as unlimited', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            ent: {
                jellyfinMaxConcurrentStreams: null,
                modules: ['jellyfin_compat', 'ai_assistant'],
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBeNull();
        expect(status.entitlements.aiAssistant).toBe(true);
    });

    it('flags a token near expiry as expiring-soon', async () => {
        const token = await sign({ expSecondsFromNow: 7 * 24 * 60 * 60 }); // 7 days
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('expiring-soon');
        expect(status.verified).toBe(true);
    });

    it('honours an expired token within the grace window', async () => {
        const token = await sign({
            expSecondsFromNow: -2 * 24 * 60 * 60, // expired 2 days ago
            ent: {
                jellyfinMaxConcurrentStreams: 3,
                modules: ['ai_assistant', 'jellyfin_compat'],
                maxSeats: null,
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('expired');
        expect(status.verified).toBe(true);
        // Still honoured — entitlements carried through the grace window.
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBe(3);
        expect(status.entitlements.aiAssistant).toBe(true);
    });

    it('degrades to free once past the grace window', async () => {
        const past = -(SECONDS(GRACE_MS) + 24 * 60 * 60); // grace + 1 day ago
        const token = await sign({ expSecondsFromNow: past });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('expired');
        expect(status.verified).toBe(false);
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('rejects a token minted for a different install (wrong audience) → free', async () => {
        const token = await sign({
            aud: '99999999-8888-4777-8666-555555555555',
            expSecondsFromNow: 60 * 24 * 60 * 60,
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.verified).toBe(false);
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('rejects a token signed by the wrong key (bad signature) → free', async () => {
        // A different, unrelated keypair forges a token the real public key rejects.
        const { privateKey: wrongKey } = await generateKeyPair(LICENSE_JWT_ALG, {
            extractable: true,
        });
        const token = await sign({ expSecondsFromNow: 60 * 24 * 60 * 60, key: wrongKey });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.verified).toBe(false);
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('rejects a malformed token → free', async () => {
        const status = await verifyLicenseKey('not-a-jwt', INSTALL_UUID, testPublicKey);
        expect(status.verified).toBe(false);
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('returns free tier for an empty key', async () => {
        const status = await verifyLicenseKey('', INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('free-tier');
        expect(status.verified).toBe(false);
    });

    // Expiry is evaluated against the supplied reference time, not the live clock.
    describe('reference-time (effectiveNowMs) handling', () => {
        const DAY = 24 * 60 * 60;

        it('treats a token as expired once the reference time passes exp + grace', async () => {
            const token = await sign({ expSecondsFromNow: 10 * DAY });
            const ref = Date.now() + 40 * DAY * 1000; // past exp(10d) + grace(14d)
            const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey, ref);
            expect(status.validity).toBe('expired');
            expect(status.verified).toBe(false);
            expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
        });

        it('still honours the token when the reference time is past exp but within grace', async () => {
            const token = await sign({
                expSecondsFromNow: 10 * DAY,
                ent: {
                    jellyfinMaxConcurrentStreams: 4,
                    modules: ['ai_assistant', 'jellyfin_compat'],
                    maxSeats: null,
                },
            });
            const ref = Date.now() + 18 * DAY * 1000; // 8 days past exp, < 14d grace
            const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey, ref);
            expect(status.validity).toBe('expired');
            expect(status.verified).toBe(true);
            expect(status.entitlements.jellyfinMaxConcurrentStreams).toBe(4);
        });
    });
});

// ---------------------------------------------------------------------------
// New: module-based entitlement mapping
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Launch behaviour: no-key build grace + early-access keys
// ---------------------------------------------------------------------------

/** The exact `ent` claim lumastra.org issues during early access (tiers.ts). */
const EARLY_ACCESS_ENT = {
    modules: ['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push'],
    jellyfinMaxConcurrentStreams: null,
    maxSeats: null,
    seatOverflowPolicy: 'observe',
    seatWindowDays: 30,
    aiAssistant: true,
};
const DAY_MS = 24 * 60 * 60 * 1000;

describe('no key: grace window anchored to the image build time', () => {
    const BUILT = Date.parse('2026-10-01T12:00:00Z');

    it('within the grace window → full early-access entitlements (unlimited /j, AI)', async () => {
        const now = BUILT + 10 * DAY_MS;
        const status = await verifyLicenseKey('', INSTALL_UUID, testPublicKey, now, BUILT);
        expect(status.validity).toBe('grace');
        expect(status.tier).toBe('grace');
        expect(status.verified).toBe(false);
        expect(status.expiresAt).toBe(new Date(BUILT + NO_KEY_GRACE_MS).toISOString());
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBeNull();
        expect(status.entitlements.aiAssistant).toBe(true);
        expect(status.entitlements.modules.has('jellyfin_compat')).toBe(true);
        expect(status.entitlements.modules.has('ai_assistant')).toBe(true);
        // Enterprise modules are never part of early access.
        expect(status.entitlements.modules.has('assessment')).toBe(false);
    });

    it('after the grace window → free tier (1 /j stream, no AI)', async () => {
        const now = BUILT + NO_KEY_GRACE_MS + 1;
        const status = await verifyLicenseKey('', INSTALL_UUID, testPublicKey, now, BUILT);
        expect(status.validity).toBe('free-tier');
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('the window is 30 days, so pinning an old image cannot extend it', async () => {
        expect(NO_KEY_GRACE_MS).toBe(30 * DAY_MS);
        // An image built 31 days before "now" is past its window whatever the install date.
        const status = await verifyLicenseKey(
            '',
            INSTALL_UUID,
            testPublicKey,
            BUILT + 31 * DAY_MS,
            BUILT,
        );
        expect(status.entitlements.aiAssistant).toBe(false);
    });

    it('unknown build time → no grace, free tier', async () => {
        const status = await verifyLicenseKey('', INSTALL_UUID, testPublicKey, BUILT, null);
        expect(status.validity).toBe('free-tier');
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('a key that is present but INVALID gets no build grace → free tier', async () => {
        const status = await verifyLicenseKey(
            'not.a.jwt',
            INSTALL_UUID,
            testPublicKey,
            BUILT + DAY_MS,
            BUILT,
        );
        expect(status.validity).toBe('free-tier');
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });
});

describe('LICENSE_SERVER_CONTACT_ENABLED off: free tier at once, a stored key until it expires', () => {
    const BUILT = Date.parse('2026-10-01T12:00:00Z');
    const EA_ENT = {
        modules: ['jellyfin_compat', 'ai_assistant', 'branding_removal', 'push'],
        jellyfinMaxConcurrentStreams: null,
        maxSeats: null,
    };

    beforeEach(() => {
        cfg.LICENSE_SERVER_CONTACT_ENABLED = false;
    });

    it('no key, inside the no-key grace window → free tier anyway (no later surprise drop)', async () => {
        const status = await verifyLicenseKey(
            '',
            INSTALL_UUID,
            testPublicKey,
            BUILT + DAY_MS,
            BUILT,
        );
        expect(status.validity).toBe('free-tier');
        expect(status.reasonCode).toBe('contact-off-free');
        expect(status.expiresAt).toBeNull();
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
        // What the operator loses, spelled out.
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBe(2);
        expect(status.entitlements.aiAssistant).toBe(false);
        expect(status.entitlements.modules.has('branding_removal')).toBe(false);
    });

    it('the config value is the default: same answer without the explicit argument', async () => {
        const status = await verifyLicenseKey(
            '',
            INSTALL_UUID,
            testPublicKey,
            BUILT + DAY_MS,
            BUILT,
        );
        expect(status.reasonCode).toBe('contact-off-free');
        cfg.LICENSE_SERVER_CONTACT_ENABLED = true;
        const on = await verifyLicenseKey('', INSTALL_UUID, testPublicKey, BUILT + DAY_MS, BUILT);
        expect(on.validity).toBe('grace');
    });

    it('a valid stored key keeps its entitlements until exp, and says it is not renewed', async () => {
        const token = await sign({
            expSecondsFromNow: 5 * 24 * 60 * 60, // inside the renewal window
            tier: 'early_access',
            ent: EA_ENT,
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('expiring-soon');
        expect(status.verified).toBe(true);
        expect(status.reasonCode).toBe('contact-off-key-until-expiry');
        expect(status.entitlements.aiAssistant).toBe(true);
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBeNull();
    });

    it('a key just past exp gets no renewal grace → free tier', async () => {
        const token = await sign({
            expSecondsFromNow: -60 * 60, // expired an hour ago
            tier: 'early_access',
            ent: EA_ENT,
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('expired');
        expect(status.verified).toBe(false);
        expect(status.reasonCode).toBe('contact-off-expired-free');
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('enforcement off: nothing is gated either way', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        try {
            const status = await verifyLicenseKey(
                '',
                INSTALL_UUID,
                testPublicKey,
                BUILT + DAY_MS,
                BUILT,
            );
            expect(status.entitlements).toEqual(UNLIMITED_ENTITLEMENTS);
        } finally {
            cfg.LICENSE_ENFORCEMENT_ENABLED = true;
        }
    });
});

describe('early-access keys (the launch license)', () => {
    it('a valid early-access key → unlimited /j streams + AI assistant', async () => {
        const token = await sign({
            expSecondsFromNow: 120 * 24 * 60 * 60,
            tier: 'early_access',
            ent: EARLY_ACCESS_ENT,
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('valid');
        expect(status.verified).toBe(true);
        expect(status.tier).toBe('early_access');
        expect(status.entitlements.edition).toBe('pro');
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBeNull();
        expect(status.entitlements.aiAssistant).toBe(true);
        expect(status.entitlements.maxSeats).toBeNull();
        for (const m of EARLY_ACCESS_ENT.modules) {
            expect(status.entitlements.modules.has(m as never)).toBe(true);
        }
    });

    it('an expired early-access key past the key grace → free tier', async () => {
        const token = await sign({
            expSecondsFromNow: -Math.ceil((GRACE_MS + DAY_MS) / 1000),
            tier: 'early_access',
            ent: EARLY_ACCESS_ENT,
        });
        // Even inside a build grace window, a present-but-expired key degrades.
        const status = await verifyLicenseKey(
            token,
            INSTALL_UUID,
            testPublicKey,
            Date.now(),
            Date.now() - DAY_MS,
        );
        expect(status.validity).toBe('expired');
        expect(status.entitlements).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('an early-access key just past exp stays unlocked through the key grace', async () => {
        const token = await sign({
            expSecondsFromNow: -3600,
            tier: 'early_access',
            ent: EARLY_ACCESS_ENT,
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.validity).toBe('expired');
        expect(status.entitlements.aiAssistant).toBe(true);
    });
});

describe('entitlementsFromClaim — modules array (new format)', () => {
    it('maps enterprise modules correctly', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'enterprise',
            ent: {
                modules: [
                    'jellyfin_compat',
                    'ai_assistant',
                    'branding_removal',
                    'assessment',
                    'showcase',
                    'sso_enterprise',
                ],
                maxSeats: 250,
                seatOverflowPolicy: 'observe',
                jellyfinMaxConcurrentStreams: null,
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.edition).toBe('enterprise');
        expect(status.entitlements.modules.has('assessment')).toBe(true);
        expect(status.entitlements.modules.has('sso_enterprise')).toBe(true);
        expect(status.entitlements.maxSeats).toBe(250);
        expect(status.entitlements.seatOverflowPolicy).toBe('observe');
        expect(status.seatLimit).toBe(250);
        expect(typeof status.seatsInUse === 'number' || status.seatsInUse === null).toBe(true);
    });

    it('maps pro modules correctly', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'pro',
            ent: {
                modules: ['ai_assistant', 'jellyfin_compat', 'branding_removal'],
                jellyfinMaxConcurrentStreams: null,
                maxSeats: null,
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.edition).toBe('pro');
        expect(status.entitlements.modules.has('ai_assistant')).toBe(true);
        expect(status.entitlements.modules.has('branding_removal')).toBe(true);
        expect(status.entitlements.modules.has('assessment')).toBe(false);
        expect(status.entitlements.maxSeats).toBeNull();
    });

    it('grants push module when present in license', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'enterprise',
            ent: {
                modules: ['push', 'ai_assistant', 'jellyfin_compat'],
                jellyfinMaxConcurrentStreams: null,
                maxSeats: null,
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.edition).toBe('enterprise');
        expect(status.entitlements.modules.has('push')).toBe(true);
        expect(status.entitlements.modules.has('ai_assistant')).toBe(true);
        expect(status.entitlements.modules.has('jellyfin_compat')).toBe(true);
    });

    it('filters out unknown module strings (unknown modules are silently dropped)', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'pro',
            ent: {
                modules: ['ai_assistant', 'totally_fake_module', 'jellyfin_compat'],
                jellyfinMaxConcurrentStreams: null,
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.modules.has('ai_assistant')).toBe(true);
        expect(status.entitlements.modules.has('totally_fake_module' as never)).toBe(false);
    });

    it('degrade overflow policy is surfaced', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'enterprise',
            ent: {
                modules: ['ai_assistant'],
                maxSeats: 10,
                seatOverflowPolicy: 'degrade',
            },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.seatOverflowPolicy).toBe('degrade');
    });
});

// ---------------------------------------------------------------------------
// New: back-compat mapping (old aiAssistant boolean flag)
// ---------------------------------------------------------------------------

describe('entitlementsFromClaim — back-compat (old aiAssistant boolean)', () => {
    it('grants ai_assistant + jellyfin_compat when aiAssistant=true and no modules array', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'supporter',
            ent: { jellyfinMaxConcurrentStreams: 5, aiAssistant: true },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.aiAssistant).toBe(true);
        expect(status.entitlements.modules.has('ai_assistant')).toBe(true);
        expect(status.entitlements.modules.has('jellyfin_compat')).toBe(true);
        expect(status.entitlements.jellyfinMaxConcurrentStreams).toBe(5);
    });

    it('grants empty module set when aiAssistant=false and no modules array', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'free',
            ent: { jellyfinMaxConcurrentStreams: 1, aiAssistant: false },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.aiAssistant).toBe(false);
        expect(status.entitlements.modules.size).toBe(0);
    });

    it('no-ent token → UNLIMITED_ENTITLEMENTS (migration grace for pre-module-era keys)', async () => {
        // A signed token with no `ent` claim predates the module-era. The service
        // grants UNLIMITED_ENTITLEMENTS (as it always did) so existing prod deployments
        // do not lose access to licensed modules on upgrade. A warning is logged and
        // operators should rotate to a new key with ent.modules.
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'pro',
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.verified).toBe(true);
        // Entitlements are UNLIMITED — same as before this PR, for migration safety.
        expect(status.entitlements).toEqual(UNLIMITED_ENTITLEMENTS);
    });

    it('grants EMPTY module set when ent exists but aiAssistant is omitted (not false, just absent)', async () => {
        // A "stream-only" key: ent block exists, but aiAssistant key is not present.
        // Old guard (aiAssistant !== false) would silently grant ai_assistant + jellyfin_compat
        // because undefined !== false. Fix: must use === true so omitting the field → empty set.
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'pro',
            ent: { jellyfinMaxConcurrentStreams: 5 }, // no aiAssistant field
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.entitlements.aiAssistant).toBe(false);
        expect(status.entitlements.modules.has('ai_assistant')).toBe(false);
        expect(status.entitlements.modules.has('jellyfin_compat')).toBe(false);
        expect(status.entitlements.modules.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// seatsInUse / seatLimit in status
// ---------------------------------------------------------------------------

describe('seat count fields in LicenseStatus', () => {
    it('seatsInUse is null when maxSeats is null (no cap)', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'pro',
            ent: { modules: ['ai_assistant'], maxSeats: null },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.seatsInUse).toBeNull();
        expect(status.seatLimit).toBeNull();
    });

    it('seatLimit reflects maxSeats from the claim', async () => {
        const token = await sign({
            expSecondsFromNow: 60 * 24 * 60 * 60,
            tier: 'enterprise',
            ent: { modules: ['sso_enterprise'], maxSeats: 100 },
        });
        const status = await verifyLicenseKey(token, INSTALL_UUID, testPublicKey);
        expect(status.seatLimit).toBe(100);
        // seatsInUse may be a number (from the stub → 0) or null on DB error.
        expect(typeof status.seatsInUse === 'number' || status.seatsInUse === null).toBe(true);
    });
});
