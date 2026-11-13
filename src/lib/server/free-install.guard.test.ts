// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard: an install with NO licence key is a full install.
 *
 * Lumastra is AGPL-3.0 with no paid parts. Nothing about /j streams, the AI
 * assistant or operator branding may depend on a key, a licence server or an
 * enforcement switch. These tests run the real config and the real gates with
 * nothing registered, which is exactly what a key-less install looks like.
 */

import { describe, expect, it, vi } from 'vitest';

// Real config, but a custom operator branding so the branding test can tell
// "applied" from "defaults".
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

import { features } from '$lib/server/config.js';
import { getServerBranding, getServerFeatures } from '$lib/server/server-branding.js';

describe('free install (no licence key)', () => {
    it('lets the AI assistant follow its own settings, nothing else', async () => {
        expect((await getServerFeatures()).aiAssistant).toBe(features.aiAssistant);
    });

    it('allows operator branding (name and logos)', async () => {
        expect(await getServerBranding()).toMatchObject({
            appName: 'My Own Server',
            appDescription: 'Family media',
            logoSmall: '/logo-small.png',
            logoFull: '/logo-full.png',
            logoPlay: '/logo-play.png',
            backgroundImage: '/bg.png',
        });
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
