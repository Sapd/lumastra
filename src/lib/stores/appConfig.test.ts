// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import { appConfig, configLoaded, hydrateAppConfig } from './appConfig';

describe('SSR app config hydration', () => {
    it('hydrates branding and features without a client configuration request', () => {
        hydrateAppConfig({
            branding: { appName: 'My library', appDescription: 'Welcome' },
            features: { watchTogether: true, aiAssistant: true },
        });
        expect(get(configLoaded)).toBe(true);
        expect(get(appConfig).branding.appName).toBe('My library');
        expect(get(appConfig).features.watchTogether).toBe(true);
        expect(get(appConfig).features.aiAssistant).toBe(true);
    });

    it('resets authenticated features when the next SSR payload is anonymous', () => {
        hydrateAppConfig({ features: { watchTogether: true, aiAssistant: true } });
        hydrateAppConfig({ branding: { appName: 'Lumastra' }, features: {} });
        expect(get(appConfig).features.watchTogether).toBe(false);
        expect(get(appConfig).features.aiAssistant).toBe(false);
        expect(get(appConfig).branding.appName).toBe('Lumastra');
    });
});
