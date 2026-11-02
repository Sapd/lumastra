// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
    SETTINGS_SECTIONS,
    enabledSections,
    isSectionEnabled,
    firstEnabledSectionId,
    settingsRedirectTarget,
    type SettingsVisibilityContext,
} from './settings-sections';

const fullAccess: SettingsVisibilityContext = {
    features: {
        avatarUpload: true,
        userPats: true,
        deviceAuth: true,
        jellyfinCompat: true,
        subsonicCompat: true,
        dockToggle: true,
    },
    authMethod: 'session',
    hasWidgets: true,
    malConfigured: true,
};

const forwardAuthMinimal: SettingsVisibilityContext = {
    features: {
        avatarUpload: false,
        userPats: false,
        deviceAuth: false,
        jellyfinCompat: false,
        subsonicCompat: false,
    },
    authMethod: 'forward',
    hasWidgets: false,
    malConfigured: false,
};

describe('settings section registry', () => {
    test('exposes 10 sections in stable order', () => {
        expect(SETTINGS_SECTIONS.map((s) => s.id)).toEqual([
            'account',
            'sessions',
            'connections',
            'display',
            'privacy',
            'playback',
            'subtitles',
            'home',
            'about',
            'data',
        ]);
    });

    test('full-access user sees every section', () => {
        expect(enabledSections(fullAccess).map((s) => s.id)).toEqual([
            'account',
            'sessions',
            'connections',
            'display',
            'privacy',
            'playback',
            'subtitles',
            'home',
            'about',
            'data',
        ]);
    });

    test('forward-auth minimal user loses account/connections/home (sessions & data are universal)', () => {
        expect(enabledSections(forwardAuthMinimal).map((s) => s.id)).toEqual([
            'sessions',
            'display',
            'privacy',
            'playback',
            'subtitles',
            'about',
            'data',
        ]);
    });

    test('display/privacy/playback/subtitles/about are always enabled', () => {
        // 'privacy' is universal on purpose: hide_streams applies on every install
        // regardless of feature flags, so there is no configuration where this
        // section would have nothing to show.
        for (const id of ['display', 'privacy', 'playback', 'subtitles', 'about']) {
            expect(isSectionEnabled(id, forwardAuthMinimal)).toBe(true);
        }
    });

    test('MAL-only deployment (both compat off, MAL configured) still gets Connections', () => {
        const malOnly: SettingsVisibilityContext = {
            ...forwardAuthMinimal,
            malConfigured: true,
        };
        expect(isSectionEnabled('connections', malOnly)).toBe(true);
        expect(enabledSections(malOnly).map((s) => s.id)).toContain('connections');
    });

    test('firstEnabledSectionId returns the first visible section', () => {
        expect(firstEnabledSectionId(fullAccess)).toBe('account');
        expect(firstEnabledSectionId(forwardAuthMinimal)).toBe('sessions');
    });

    test('settingsRedirectTarget returns null when enabled, else first enabled path', () => {
        expect(settingsRedirectTarget('account', fullAccess)).toBeNull();
        expect(settingsRedirectTarget('account', forwardAuthMinimal)).toBe('/settings/sessions');
    });
});
