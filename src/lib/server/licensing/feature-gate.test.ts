// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for feature-gate.ts.
 *
 * Stubs the entitlements provider via the AGPL-core seam
 * (registerEntitlementsProvider + __resetEntitlementsProviderForTests).
 * No DB, no proprietary imports.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('$lib/server/config', () => ({
    config: { LICENSE_ENFORCEMENT_ENABLED: true },
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ info() {}, warn() {}, error() {}, debug() {} }) },
}));

import {
    registerEntitlementsProvider,
    __resetEntitlementsProviderForTests,
    FREE_TIER_ENTITLEMENTS,
    UNLIMITED_ENTITLEMENTS,
    type EntitlementsProvider,
    type LicenseStatus,
    type Entitlements,
} from './entitlements';
import { isModuleLicensed, getSeatState } from './feature-gate';
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

function stubProvider(ent: Entitlements): EntitlementsProvider {
    return {
        getEntitlements: async () => ent,
        getStatus: async () => makeStatus(ent),
    };
}

beforeEach(() => {
    __resetEntitlementsProviderForTests();
    cfg.LICENSE_ENFORCEMENT_ENABLED = true;
});

// ---------------------------------------------------------------------------
// isModuleLicensed
// ---------------------------------------------------------------------------

describe('isModuleLicensed', () => {
    it('returns true for a module present in the licensed set', async () => {
        registerEntitlementsProvider(stubProvider(UNLIMITED_ENTITLEMENTS));
        expect(await isModuleLicensed('ai_assistant')).toBe(true);
        expect(await isModuleLicensed('jellyfin_compat')).toBe(true);
    });

    it('returns false for a module absent from the licensed set (free tier)', async () => {
        registerEntitlementsProvider(stubProvider(FREE_TIER_ENTITLEMENTS));
        expect(await isModuleLicensed('ai_assistant')).toBe(false);
        expect(await isModuleLicensed('branding_removal')).toBe(false);
    });

    it('returns false (free-tier fallback) when enforcement is on but no provider', async () => {
        // No provider registered — should fall back to FREE, not UNLIMITED.
        cfg.LICENSE_ENFORCEMENT_ENABLED = true;
        expect(await isModuleLicensed('ai_assistant')).toBe(false);
    });

    it('returns true when enforcement is OFF regardless of module', async () => {
        cfg.LICENSE_ENFORCEMENT_ENABLED = false;
        // No provider — enforcement off → UNLIMITED.
        expect(await isModuleLicensed('ai_assistant')).toBe(true);
        expect(await isModuleLicensed('assessment')).toBe(true);
    });

    it('returns false (not true) when the provider throws — fail to free, not unlimited', async () => {
        registerEntitlementsProvider({
            getEntitlements: async () => {
                throw new Error('verify exploded');
            },
            getStatus: async () => makeStatus(FREE_TIER_ENTITLEMENTS),
        });
        // IMPORTANT: must be false, not true — error must not grant paid modules.
        expect(await isModuleLicensed('ai_assistant')).toBe(false);
    });

    it('returns true for a module in a pro-tier set', async () => {
        const proEnt: Entitlements = {
            edition: 'pro',
            jellyfinMaxConcurrentStreams: null,
            aiAssistant: true,
            maxSeats: null,
            seatOverflowPolicy: 'observe',
            modules: new Set(['ai_assistant', 'branding_removal', 'jellyfin_compat']),
        };
        registerEntitlementsProvider(stubProvider(proEnt));
        expect(await isModuleLicensed('ai_assistant')).toBe(true);
        expect(await isModuleLicensed('branding_removal')).toBe(true);
        expect(await isModuleLicensed('assessment')).toBe(false);
        expect(await isModuleLicensed('sso_enterprise')).toBe(false);
    });

    it('returns true for all modules in enterprise tier', async () => {
        const entEnt: Entitlements = {
            edition: 'enterprise',
            jellyfinMaxConcurrentStreams: null,
            aiAssistant: true,
            maxSeats: 250,
            seatOverflowPolicy: 'observe',
            modules: new Set([
                'jellyfin_compat',
                'ai_assistant',
                'branding_removal',
                'assessment',
                'showcase',
                'sso_enterprise',
            ]),
        };
        registerEntitlementsProvider(stubProvider(entEnt));
        expect(await isModuleLicensed('assessment')).toBe(true);
        expect(await isModuleLicensed('sso_enterprise')).toBe(true);
        expect(await isModuleLicensed('showcase')).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// getSeatState
// ---------------------------------------------------------------------------

describe('getSeatState', () => {
    it('returns unlimited (no cap) when maxSeats is null', async () => {
        registerEntitlementsProvider(stubProvider(UNLIMITED_ENTITLEMENTS));
        const state = await getSeatState();
        expect(state.allowed).toBe(true);
        expect(state.limit).toBeNull();
    });

    it('returns allowed=true when seatsInUse is within the cap', async () => {
        const ent: Entitlements = {
            ...UNLIMITED_ENTITLEMENTS,
            maxSeats: 250,
            seatOverflowPolicy: 'observe',
        };
        const provider: EntitlementsProvider = {
            getEntitlements: async () => ent,
            getStatus: async () => ({
                ...makeStatus(ent),
                seatsInUse: 100, // within cap
                seatLimit: 250,
            }),
        };
        registerEntitlementsProvider(provider);
        const state = await getSeatState();
        expect(state.allowed).toBe(true);
        expect(state.limit).toBe(250);
        expect(state.inUse).toBe(100);
        expect(state.overflowPolicy).toBe('observe');
    });

    it('returns allowed=false when seatsInUse exceeds the cap', async () => {
        const ent: Entitlements = {
            ...UNLIMITED_ENTITLEMENTS,
            maxSeats: 10,
            seatOverflowPolicy: 'degrade',
        };
        const provider: EntitlementsProvider = {
            getEntitlements: async () => ent,
            getStatus: async () => ({
                ...makeStatus(ent),
                seatsInUse: 15, // over cap
                seatLimit: 10,
            }),
        };
        registerEntitlementsProvider(provider);
        const state = await getSeatState();
        expect(state.allowed).toBe(false);
        expect(state.inUse).toBe(15);
        expect(state.limit).toBe(10);
        expect(state.overflowPolicy).toBe('degrade');
    });

    it('fails open (allowed=true) when seatsInUse is null (count unavailable)', async () => {
        const ent: Entitlements = {
            ...UNLIMITED_ENTITLEMENTS,
            maxSeats: 10,
            seatOverflowPolicy: 'degrade',
        };
        const provider: EntitlementsProvider = {
            getEntitlements: async () => ent,
            getStatus: async () => ({
                ...makeStatus(ent),
                seatsInUse: null, // count unavailable → fail open
                seatLimit: 10,
            }),
        };
        registerEntitlementsProvider(provider);
        const state = await getSeatState();
        expect(state.allowed).toBe(true);
        expect(state.inUse).toBeNull();
    });

    it('surfaces degrade policy from the entitlements', async () => {
        const ent: Entitlements = {
            ...FREE_TIER_ENTITLEMENTS,
            maxSeats: 10,
            seatOverflowPolicy: 'degrade',
        };
        registerEntitlementsProvider(stubProvider(ent));
        const state = await getSeatState();
        expect(state.overflowPolicy).toBe('degrade');
    });

    it('fails open (allowed=true, limit=null) when the provider throws', async () => {
        registerEntitlementsProvider({
            getEntitlements: async () => {
                throw new Error('db down');
            },
            getStatus: async () => makeStatus(FREE_TIER_ENTITLEMENTS),
        });
        const state = await getSeatState();
        expect(state.allowed).toBe(true);
        expect(state.limit).toBeNull();
        expect(state.overflowPolicy).toBe('observe');
    });

    it('fails open when enforcement is on and no provider is registered', async () => {
        // No provider → getEffectiveEntitlements returns FREE (maxSeats=null).
        const state = await getSeatState();
        expect(state.allowed).toBe(true);
        expect(state.limit).toBeNull();
    });
});
