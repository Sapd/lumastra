// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the core entitlements registry — the AGPL/proprietary boundary.
 * Verifies the fail-open contract: enforcement off → unlimited; enforcement on
 * with a valid provider → its entitlements; any provider failure → free tier.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({
    config: { LICENSE_ENFORCEMENT_ENABLED: false },
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));
const h = vi.hoisted(() => ({ worker: false, initProprietaryLicensing: vi.fn() }));
vi.mock('$lib/server/tasks/isolation/isolation-context.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/tasks/isolation/isolation-context.js')>();
    return { ...actual, isIsolationWorker: () => h.worker };
});
// The optional proprietary module the registry loads through import.meta.glob.
vi.mock('$lib/server/proprietary/licensing/init', () => ({
    initProprietaryLicensing: h.initProprietaryLicensing,
}));

import {
    ensureProprietaryLoaded,
    getEffectiveEntitlements,
    registerEntitlementsProvider,
    __resetEntitlementsProviderForTests,
    FREE_TIER_ENTITLEMENTS,
    UNLIMITED_ENTITLEMENTS,
    type EntitlementsProvider,
    type Entitlements,
    type LicenseStatus,
} from './entitlements';
import { config } from '$lib/server/config';

const cfg = config as unknown as { LICENSE_ENFORCEMENT_ENABLED: boolean };

function makeStatus(ent: Entitlements): LicenseStatus {
    return {
        enforcementEnabled: true,
        tier: ent.edition,
        validity: 'valid',
        expiresAt: null,
        entitlements: ent,
        reason: '',
        verified: true,
        seatsInUse: null,
        seatLimit: ent.maxSeats,
    };
}

function provider(over: Partial<EntitlementsProvider>): EntitlementsProvider {
    return {
        getEntitlements: async () => UNLIMITED_ENTITLEMENTS,
        getStatus: async () => makeStatus(UNLIMITED_ENTITLEMENTS),
        ...over,
    };
}

beforeEach(() => {
    __resetEntitlementsProviderForTests();
    cfg.LICENSE_ENFORCEMENT_ENABLED = false;
    h.worker = false;
    h.initProprietaryLicensing.mockClear();
});

describe('FREE_TIER_ENTITLEMENTS shape', () => {
    it('has edition free', () => {
        expect(FREE_TIER_ENTITLEMENTS.edition).toBe('free');
    });
    it('caps jellyfinMaxConcurrentStreams at 2', () => {
        expect(FREE_TIER_ENTITLEMENTS.jellyfinMaxConcurrentStreams).toBe(2);
    });
    it('has aiAssistant false', () => {
        expect(FREE_TIER_ENTITLEMENTS.aiAssistant).toBe(false);
    });
    it('grants push and nothing else', () => {
        expect([...FREE_TIER_ENTITLEMENTS.modules]).toEqual(['push']);
    });
    it('has maxSeats null (seats not capped on free)', () => {
        expect(FREE_TIER_ENTITLEMENTS.maxSeats).toBeNull();
    });
    it('has seatOverflowPolicy observe', () => {
        expect(FREE_TIER_ENTITLEMENTS.seatOverflowPolicy).toBe('observe');
    });
});

describe('UNLIMITED_ENTITLEMENTS shape', () => {
    it('has edition unlimited', () => {
        expect(UNLIMITED_ENTITLEMENTS.edition).toBe('unlimited');
    });
    it('has no stream cap', () => {
        expect(UNLIMITED_ENTITLEMENTS.jellyfinMaxConcurrentStreams).toBeNull();
    });
    it('has aiAssistant true', () => {
        expect(UNLIMITED_ENTITLEMENTS.aiAssistant).toBe(true);
    });
    it('has all modules', () => {
        expect(UNLIMITED_ENTITLEMENTS.modules.has('ai_assistant')).toBe(true);
        expect(UNLIMITED_ENTITLEMENTS.modules.has('jellyfin_compat')).toBe(true);
        expect(UNLIMITED_ENTITLEMENTS.modules.has('assessment')).toBe(true);
        expect(UNLIMITED_ENTITLEMENTS.modules.has('sso_enterprise')).toBe(true);
    });
});

describe('getEffectiveEntitlements', () => {
    it('returns unlimited when enforcement is off (provider ignored)', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        registerEntitlementsProvider(
            provider({
                getEntitlements: async () => {
                    throw new Error('should not be called');
                },
            }),
        );
        expect(await getEffectiveEntitlements()).toEqual(UNLIMITED_ENTITLEMENTS);
    });

    it("returns the provider's entitlements when enforcement is on", async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = true;
        const ent: Entitlements = {
            edition: 'pro',
            jellyfinMaxConcurrentStreams: null,
            aiAssistant: true,
            maxSeats: null,
            seatOverflowPolicy: 'observe',
            modules: new Set(['ai_assistant', 'jellyfin_compat']),
        };
        registerEntitlementsProvider(provider({ getEntitlements: async () => ent }));
        const result = await getEffectiveEntitlements();
        expect(result.edition).toBe('pro');
        expect(result.aiAssistant).toBe(true);
        expect(result.modules.has('ai_assistant')).toBe(true);
    });

    it('fails open to the free tier when the provider throws (enforcement on)', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = true;
        registerEntitlementsProvider(
            provider({
                getEntitlements: async () => {
                    throw new Error('verify exploded');
                },
            }),
        );
        expect(await getEffectiveEntitlements()).toEqual(FREE_TIER_ENTITLEMENTS);
    });
});

describe('push module', () => {
    it('is granted when enforcement is off', () => {
        expect(UNLIMITED_ENTITLEMENTS.modules.has('push')).toBe(true);
    });

    it('is granted on the free tier too — push is in every tier', () => {
        expect(FREE_TIER_ENTITLEMENTS.modules.has('push')).toBe(true);
    });
});

describe('proprietary licensing load inside a plugin-isolation worker (B1)', () => {
    it('never loads/initialises the proprietary module (its refresh loop writes LICENSE_KEY)', async () => {
        h.worker = true;
        cfg.LICENSE_ENFORCEMENT_ENABLED = true;

        await ensureProprietaryLoaded();
        const ent = await getEffectiveEntitlements();

        expect(h.initProprietaryLicensing).not.toHaveBeenCalled();
        // Reads still resolve, exactly as with no provider registered.
        expect(ent).toEqual(FREE_TIER_ENTITLEMENTS);
    });

    it('control: on the main thread the module IS loaded and initialised', async () => {
        await ensureProprietaryLoaded();

        expect(h.initProprietaryLicensing).toHaveBeenCalledTimes(1);
    });
});
