// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { config, features } from '$lib/server/config';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { Logger } from '$lib/server/utils/logger';
import { existsSync, readdirSync } from 'fs';
import { join, extname } from 'path';

const logger = Logger.for('AdminHomepageNav');

const localIconExtensions = new Set(['.svg', '.png', '.webp', '.jpg', '.jpeg']);

// `static/` only exists in the source tree — the adapter copies it to
// `build/client/`, so in the Docker image there is no `static/icons` and this
// scan returned [] for every production install, silently emptying the
// "Built-in images" group of the icon picker. Check the built location too.
function getLocalIconsDir(): string | null {
    const candidates = [
        join(process.cwd(), 'static', 'icons'),
        join(process.cwd(), 'build', 'client', 'icons'),
    ];
    return candidates.find((dir) => existsSync(dir)) ?? null;
}

function getLocalNavigationIcons(): string[] {
    try {
        const iconsDir = getLocalIconsDir();
        if (!iconsDir) return [];

        return readdirSync(iconsDir, { withFileTypes: true })
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((name) => localIconExtensions.has(extname(name).toLowerCase()))
            .sort((a, b) => a.localeCompare(b))
            .map((name) => `/icons/${name}`);
    } catch (error) {
        logger.warn('Failed to scan local navigation icons', { error });
        return [];
    }
}

// Settings → Homepage & navigation (admin IA redesign, spec §3.6): homepage
// widgets and navigation editing are now tabs on ONE page instead of two
// separate routes. Both tabs post to the SAME `?/save` / `?/reload` actions
// (each targets a disjoint set of config keys), so one settings-framework
// load covering all three sections ('homepage', 'trending', 'navigation')
// composes cleanly with both tabs' augmenting data.
//
// `browse` and `hover` joined them (moved off the general settings page): they
// configure the same thing the Homepage tab already configures — what the
// browsing surfaces show and how a card behaves under the pointer. They render
// on the HOMEPAGE tab (HomepageSettingsTab passes the whole loaded schema
// through), NOT the Navigation tab, which is only the custom link-list editor.
export const load: PageServerLoad = async () => {
    const settingsData = await loadSettingsForSections([
        'homepage',
        'trending',
        'navigation',
        'browse',
        'hover',
    ]);
    const exposure = await loadSearchExposure();

    const availableGroups = [
        ...new Set([
            ...config.ADMIN_GROUPS,
            ...config.WATCH_PERMISSION_GROUPS,
            ...config.NAVIGATION_AVAILABLE_GROUPS,
        ]),
    ].filter(Boolean);

    return {
        ...settingsData,
        ...exposure,
        warnings: [] as string[],
        featureFlags: {
            // jellyfinCompat gates the navigation editors' connect quick-adds:
            // both the hero preset and the footer's Quick Connect button lead
            // somewhere that only answers while the /j surface is enabled.
            jellyfinCompat: features.jellyfinCompat,
            watchTogether: features.watchTogether,
            sessions: features.sessions,
            aiRecommendations: features.aiRecommendations,
            calendar: features.calendar,
            trending: features.trending,
        },
        // Plugin-contributed home widgets (e.g. the shoutbox) so the widget config
        // editor can reorder/hide them like built-ins. Generic over all feature
        // plugins; id matches the home page's `plugin:<featureId>:<widgetId>`.
        // Only 'home'-placement plugin widgets are reorderable/hideable in the grid
        // config; 'below-hero' banners (e.g. announcements) are controlled by their
        // own plugin settings, not the widget grid.
        pluginWidgets: taskRegistry.getAllFeatures().flatMap((f) =>
            (f.widgets ?? [])
                // Allowlist, not a denylist — see the user-facing twin in
                // settings/home. A new placement must never leak into the grid.
                .filter((w) => (w.placement ?? 'home') === 'home')
                .map((w) => ({ id: `plugin:${f.id}:${w.id}`, label: w.title })),
        ),
        availableGroups,
        localNavIcons: getLocalNavigationIcons(),
    };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
