// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard: an install with NO licence key is a full install.
 *
 * Lumastra is AGPL-3.0 with no paid parts. Nothing about /j streams, the AI
 * assistant or operator branding may depend on a key, a licence server or an
 * enforcement switch. These tests run the real entitlements registry and the
 * real config (no entitlement mock), with the optional licensing module
 * replaced by an inert stand-in, which is exactly what "no key" looks like to
 * the core: no provider ever vouches for the install.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// Real config, but a custom operator branding so the branding test can tell
// "applied" from "defaults". Everything else (including the enforcement flag
// the entitlements registry reads) comes from the real module.
vi.mock('$lib/server/config', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config')>();
    const overrides: Record<string, unknown> = {
        APP_NAME: 'My Own Server',
        APP_DESCRIPTION: 'Family media',
        APP_LOGO_SMALL: '/logo-small.png',
        APP_LOGO_FULL: '/logo-full.png',
        APP_LOGO_PLAY: '/logo-play.png',
        APP_BACKGROUND_IMAGE: '/bg.png',
    };
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get: (target, prop, receiver) =>
                typeof prop === 'string' && prop in overrides
                    ? overrides[prop]
                    : Reflect.get(target, prop, receiver),
        }),
    };
});
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => null }));
// "No key": the optional licensing module never registers a provider.
vi.mock('$lib/server/proprietary/licensing/init', () => ({
    initProprietaryLicensing: () => {},
}));

import { __resetEntitlementsProviderForTests, getEffectiveEntitlements } from './entitlements';
import { isModuleLicensed } from './feature-gate';
import { getServerBranding } from '$lib/server/server-branding.js';

beforeEach(() => {
    __resetEntitlementsProviderForTests();
});

describe('free install (no licence key)', () => {
    it('allows more than 2 concurrent /j streams', async () => {
        const { jellyfinMaxConcurrentStreams: cap } = await getEffectiveEntitlements();
        // `null` is "unlimited"; a number must at least clear the old free cap.
        expect(cap === null || cap > 2).toBe(true);
    });

    it('has the AI assistant available (module and entitlement)', async () => {
        expect((await getEffectiveEntitlements()).aiAssistant).toBe(true);
        expect(await isModuleLicensed('ai_assistant')).toBe(true);
    });

    it('allows operator branding (name and logos)', async () => {
        expect(await isModuleLicensed('branding_removal')).toBe(true);
        expect(await getServerBranding()).toMatchObject({
            appName: 'My Own Server',
            appDescription: 'Family media',
            logoSmall: '/logo-small.png',
            logoFull: '/logo-full.png',
            logoPlay: '/logo-play.png',
            backgroundImage: '/bg.png',
        });
    });

    it('keeps push available', async () => {
        expect(await isModuleLicensed('push')).toBe(true);
    });
});

describe('free install: runAssistant is not refused for licence reasons', () => {
    it('does not throw the supporter-tier / licence error', async () => {
        const { runAssistant } = await import('$lib/server/proprietary/assistant-service.js');
        let message = '';
        try {
            await runAssistant(
                { message: 'hello' },
                {
                    user: {
                        userId: '00000000-0000-0000-0000-0000000000aa',
                        username: 'u',
                        groups: 'members',
                        userGroups: ['members'],
                        hasWatchPermission: true,
                        hasLiveTvPermission: false,
                        hasRequestPermission: false,
                        ownerIsAdmin: false,
                        maxAgeRating: null,
                        isAgeRestricted: false,
                        isModerator: false,
                        liveTvPriority: 'normal',
                    } as never,
                    sql: {} as never,
                    admission: { release: async () => {} },
                },
            );
        } catch (err) {
            // Anything else (no provider configured in a unit test, no DB) is fine.
            message = err instanceof Error ? err.message : String(err);
        }
        expect(message).not.toMatch(/supporter tier|active license|Admin → Licensing/i);
    });
});
