// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServerFeaturesSchema } from '$lib/schemas/server-info.js';

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: {
            APP_NAME: 'Custom',
            APP_DESCRIPTION: 'Custom description',
            APP_LOGO_SMALL: 'small',
            APP_LOGO_FULL: 'full',
            APP_LOGO_PLAY: 'play',
            APP_BACKGROUND_IMAGE: 'background',
            RATING_LOGO_IMDB: 'imdb',
            RATING_LOGO_ROTTEN_TOMATOES: 'rt',
            FEATURE_MEDIA_HOVER_VIDEO_PREVIEW: true,
            FEATURE_TOPSHELF_PREVIEWS: true,
            FEATURE_MEDIA_DOWNLOAD: true,
            FEATURE_DOWNLOAD_RENDITIONS: true,
        },
        features: {
            ...Object.fromEntries(Object.keys(actual.features).map((key) => [key, true])),
            backendOnly: true,
        },
        BACKEND_ONLY_FEATURES: new Set(['backendOnly']),
    };
});
const { licensed, radio } = vi.hoisted(() => ({ licensed: vi.fn(), radio: vi.fn() }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/licensing/feature-gate.js', () => ({ isModuleLicensed: licensed }));
vi.mock('$lib/server/services/music/radio-configured.service.js', () => ({ isRadioConfigured: radio }));
import { getServerBranding, getServerFeatures, _resetServerFeaturesCache } from './server-branding.js';

beforeEach(() => {
    _resetServerFeaturesCache();
    licensed.mockReset().mockResolvedValue(true);
    radio.mockReset().mockResolvedValue(true);
});

describe('shared server branding and features', () => {
    it('uses licensed branding', async () => {
        expect(await getServerBranding()).toEqual({ appName: 'Custom', appDescription: 'Custom description',
            logoSmall: 'small', logoFull: 'full', logoPlay: 'play', backgroundImage: 'background',
            ratingLogoImdb: 'imdb', ratingLogoRottenTomatoes: 'rt' });
    });
    it('uses default branding without a license', async () => {
        licensed.mockResolvedValue(false);
        expect(await getServerBranding()).toEqual({ appName: 'Lumastra', appDescription: 'Media Dashboard',
            logoSmall: '', logoFull: '', logoPlay: '', backgroundImage: '', ratingLogoImdb: '', ratingLogoRottenTomatoes: '' });
    });
    it('filters backend flags and disables unlicensed AI', async () => {
        licensed.mockResolvedValue(false);
        const output = await getServerFeatures();
        expect(output).not.toHaveProperty('backendOnly');
        expect(output.aiAssistant).toBe(false);
    });
    it.each([false, true])('musicRadio follows isRadioConfigured=%s', async (configured) => {
        radio.mockResolvedValue(configured);
        expect((await getServerFeatures()).musicRadio).toBe(configured);
    });
    it('contains every schema feature key', async () => {
        const output = await getServerFeatures();
        for (const key of Object.keys(ServerFeaturesSchema.shape)) {
            expect(output, key).toHaveProperty(key);
            expect(typeof output[key], key).toBe('boolean');
        }
    });
    it('memoizes each call kind and refreshes licensing within five seconds', async () => {
        const now = vi.spyOn(Date, 'now').mockReturnValue(1000);
        try {
            expect((await getServerFeatures()).aiAssistant).toBe(true);
            licensed.mockResolvedValue(false);
            expect((await getServerFeatures()).aiAssistant).toBe(true);
            expect(licensed).toHaveBeenCalledTimes(1);
            expect((await getServerFeatures('discovery')).aiAssistant).toBe(false);
            now.mockReturnValue(4001);
            expect((await getServerFeatures()).aiAssistant).toBe(false);
        } finally {
            now.mockRestore();
        }
    });
    it('retries after a failed computation', async () => {
        licensed.mockRejectedValueOnce(new Error('offline'));
        await expect(getServerFeatures()).rejects.toThrow('offline');
        expect((await getServerFeatures()).aiAssistant).toBe(true);
    });
});
