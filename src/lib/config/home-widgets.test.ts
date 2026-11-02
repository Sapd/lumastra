// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import {
    buildHomeWidgetModel,
    isHolidayWidgetAvailable,
    resolveWidgetName,
    BUILT_IN_WIDGET_IDS,
    type WidgetVisibilityData,
} from './home-widgets';

// A plain user with no admin/arr groups and all features on.
const plainUser: WidgetVisibilityData = {
    user: { userGroups: ['Users'] },
    adminGroups: ['admin'],
    features: {},
    homepage: {},
};

describe('buildHomeWidgetModel', () => {
    test('returns a non-empty widget list for a normal user (regression: was empty)', () => {
        const { allWidgetIds } = buildHomeWidgetModel(plainUser);
        expect(allWidgetIds.length).toBeGreaterThan(0);
        // Widgets without a permission gate are always available.
        expect(allWidgetIds).toContain('for-you');
        expect(allWidgetIds).toContain('trending');
        expect(allWidgetIds).toContain('watchlist');
    });

    test('permission-gated widgets are excluded for a non-privileged user', () => {
        const { allWidgetIds } = buildHomeWidgetModel(plainUser);
        // live-tv needs the live-tv permission.
        expect(allWidgetIds).not.toContain('live-tv');
    });

    test('holiday widget is only offered when features.holidays is true (off by default)', () => {
        expect(buildHomeWidgetModel(plainUser).allWidgetIds).not.toContain(
            'holiday-recommendations',
        );
        const on: WidgetVisibilityData = { ...plainUser, features: { holidays: true } };
        expect(buildHomeWidgetModel(on).allWidgetIds).toContain('holiday-recommendations');
    });

    test('isHolidayWidgetAvailable (also used by the home page) is true only for holidays: true', () => {
        expect(isHolidayWidgetAvailable(undefined)).toBe(false);
        expect(isHolidayWidgetAvailable({})).toBe(false);
        expect(isHolidayWidgetAvailable({ holidays: false })).toBe(false);
        expect(isHolidayWidgetAvailable({ holidays: true })).toBe(true);
    });

    test('admin-disabled widgets are surfaced separately, not in allWidgetIds', () => {
        const withDisabled: WidgetVisibilityData = {
            ...plainUser,
            homepage: { widgetVisibility: { trending: 'disabled' } },
        };
        const { allWidgetIds, adminDisabledWidgets } = buildHomeWidgetModel(withDisabled);
        expect(allWidgetIds).not.toContain('trending');
        expect(adminDisabledWidgets).toContain('trending');
    });

    test('honors the admin-configured order, appending omitted built-ins', () => {
        const ordered: WidgetVisibilityData = {
            ...plainUser,
            homepage: { widgetOrder: ['watchlist', 'for-you'] },
        };
        const { allWidgetIds } = buildHomeWidgetModel(ordered);
        expect(allWidgetIds.indexOf('watchlist')).toBeLessThan(allWidgetIds.indexOf('for-you'));
        // Every permitted built-in still appears.
        expect(allWidgetIds).toContain('trending');
    });

    test('built-in id list is the 9 known widgets', () => {
        expect(BUILT_IN_WIDGET_IDS.length).toBe(9);
        expect(BUILT_IN_WIDGET_IDS).not.toContain('download-client');
    });

    test('plugin widgets are reorderable (appended after built-ins by default)', () => {
        const withPlugin: WidgetVisibilityData = {
            ...plainUser,
            pluginWidgets: [{ id: 'plugin:shoutbox:shoutbox', title: 'Shoutbox' }],
        };
        const { allWidgetIds } = buildHomeWidgetModel(withPlugin);
        expect(allWidgetIds).toContain('plugin:shoutbox:shoutbox');
        // Built-ins come first, plugin widgets after.
        expect(allWidgetIds.indexOf('plugin:shoutbox:shoutbox')).toBeGreaterThan(
            allWidgetIds.indexOf('trending'),
        );
    });

    test('admin-disabled plugin widget is surfaced separately, not reorderable', () => {
        const withDisabledPlugin: WidgetVisibilityData = {
            ...plainUser,
            pluginWidgets: [{ id: 'plugin:shoutbox:shoutbox', title: 'Shoutbox' }],
            homepage: { widgetVisibility: { 'plugin:shoutbox:shoutbox': 'disabled' } },
        };
        const { allWidgetIds, adminDisabledWidgets } = buildHomeWidgetModel(withDisabledPlugin);
        expect(allWidgetIds).not.toContain('plugin:shoutbox:shoutbox');
        expect(adminDisabledWidgets).toContain('plugin:shoutbox:shoutbox');
    });

    test('admin order containing a plugin id is honored without duplication', () => {
        const ordered: WidgetVisibilityData = {
            ...plainUser,
            pluginWidgets: [{ id: 'plugin:shoutbox:shoutbox', title: 'Shoutbox' }],
            homepage: { widgetOrder: ['plugin:shoutbox:shoutbox', 'for-you'] },
        };
        const { allWidgetIds } = buildHomeWidgetModel(ordered);
        expect(allWidgetIds.filter((id) => id === 'plugin:shoutbox:shoutbox')).toHaveLength(1);
        expect(allWidgetIds.indexOf('plugin:shoutbox:shoutbox')).toBeLessThan(
            allWidgetIds.indexOf('for-you'),
        );
    });
});

describe('buildHomeWidgetModel legacy ids', () => {
    // prod's admin order still carried these; /settings/home listed them as raw
    // ids ("download-client", "activity-feed") that switched nothing on or off.
    test('drops admin-order ids that no longer have a widget', () => {
        const data: WidgetVisibilityData = {
            homepage: {
                widgetOrder: ['download-client', 'for-you', 'activity-feed', 'ai-recommendations'],
                widgetVisibility: { 'download-client': 'disabled' },
            },
        };
        const { allWidgetIds, adminDisabledWidgets } = buildHomeWidgetModel(data);
        expect(allWidgetIds).not.toContain('download-client');
        expect(allWidgetIds).not.toContain('activity-feed');
        expect(allWidgetIds).not.toContain('ai-recommendations');
        expect(adminDisabledWidgets).not.toContain('download-client');
        expect(allWidgetIds[0]).toBe('for-you');
    });
});

describe('resolveWidgetName', () => {
    test('resolves a plugin widget title from page data', () => {
        const data: WidgetVisibilityData = {
            pluginWidgets: [{ id: 'plugin:shoutbox:shoutbox', title: 'Shoutbox' }],
        };
        expect(resolveWidgetName('plugin:shoutbox:shoutbox', data)).toBe('Shoutbox');
    });

    test('falls back to the raw id for an unknown plugin widget', () => {
        expect(resolveWidgetName('plugin:unknown:x', {})).toBe('plugin:unknown:x');
    });

    test('built-in names take precedence over plugin lookup', () => {
        const data: WidgetVisibilityData = {
            pluginWidgets: [{ id: 'trending', title: 'Wrong' }],
        };
        // 'trending' is a built-in → its translated name, not the plugin title.
        expect(resolveWidgetName('trending', data)).not.toBe('Wrong');
    });
});
