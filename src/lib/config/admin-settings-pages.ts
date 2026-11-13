// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Canonical mapping of config sections to the admin settings PAGE that renders
 * a highlightable, anchored copy of them. Single source of truth for cross-page
 * search deep-links — replaces the old hardcoded SECTION_PAGE_MAP.
 *
 * A section may be rendered on more than one page (e.g. `branding` also renders
 * on the appearance page as a hidden custom editor); its CANONICAL home here is
 * the page where a real, scrollable `SettingInput` exists.
 */
import * as m from '$lib/paraglide/messages.js';

export interface AdminSettingsPageDef {
    href: string;
    label: () => string;
    /** Sections whose canonical deep-link home is this page. */
    sectionIds: string[];
    /** Sections gated behind a tab on this page: sectionId -> ?tab= value. */
    tabForSection?: Record<string, string>;
}

// Every `label` is the SAME message the settings nav (admin-nav.ts) uses for
// that href: search results group matches under this label, and a result
// group called "Live TV Sources" under a nav entry called "Live TV" read as
// two different places.
export const ADMIN_SETTINGS_PAGES: AdminSettingsPageDef[] = [
    {
        href: '/admin/settings',
        label: m.admin_nav_page_settings_general,
        // Instance-wide only. This page used to claim all 13 sections; each of the
        // others now sits with the subject it configures (see the individual page
        // loaders — a section's entry here MUST name the page whose `+page.server.ts`
        // actually loads it, or the deep-link lands on a page without the row).
        sectionIds: [
            'branding',
            'features',
            'localization',
            'diagnostics',
            'advanced',
            'enterprise',
            'licensing',
        ],
    },
    {
        href: '/admin/settings/access',
        label: m.admin_nav_page_settings_access,
        // `deviceAuth` (who may use the token API), `push` (where push
        // notifications are delivered) and `network` (CORS, /metrics) answer the
        // same question as the rest of this page: who/what may reach it.
        sectionIds: ['groups', 'auth', 'social', 'deviceAuth', 'push', 'network'],
    },
    {
        href: '/admin/settings/media',
        label: m.admin_nav_page_settings_media,
        sectionIds: ['image', 'media', 'topshelf'],
    },
    {
        href: '/admin/settings/tasks',
        label: m.admin_nav_page_settings_tasks,
        // Two sections, deliberately: `advanced-tasks` holds the switches an
        // operator may legitimately want (per-task on/off, retention windows,
        // cache warming), while `advanced-tasks-tuning` holds worker
        // concurrency, queue-depth caps, orchestrator TTLs and stall
        // thresholds — knobs that can wedge background processing in ways
        // that are hard to diagnose. They were one flat ~100-key accordion,
        // which put "stop analysing my music" one row away from the BullMQ
        // lock duration. Both are claimed here so the ownership check in
        // admin-settings-pages.test.ts stays satisfied.
        sectionIds: ['advanced-tasks', 'advanced-tasks-tuning'],
    },
    {
        href: '/admin/settings/connections',
        label: m.admin_nav_page_settings_connections,
        // One section per external service (they were one flat "services"
        // list). `requests` = the Jellyseerr connection + the request policy it
        // drives; `sync` = background-sync intervals for these connections.
        sectionIds: [
            'conn-jellyfin',
            'conn-audiobookshelf',
            'conn-kavita',
            'conn-sonarr',
            'conn-radarr',
            'requests',
            'conn-trakt',
            'conn-mal',
            'sync',
        ],
    },
    {
        href: '/admin/settings/providers',
        label: m.admin_nav_page_settings_providers,
        sectionIds: ['metadata'],
    },
    {
        href: '/admin/settings/playback',
        label: m.admin_nav_page_settings_playback,
        sectionIds: [
            'player',
            'streaming',
            'downloads',
            'ffmpeg',
            'ffmpeg-hardware',
            'watchTogether',
        ],
    },
    {
        href: '/admin/settings/livetv',
        label: m.admin_nav_page_settings_livetv,
        sectionIds: ['livetv'],
    },
    {
        href: '/admin/settings/ai',
        label: m.admin_nav_page_settings_ai,
        sectionIds: ['foryou', 'ai-assistant'],
    },
    {
        href: '/admin/settings/homepage',
        label: m.admin_nav_page_settings_homepage,
        sectionIds: ['homepage', 'trending', 'navigation', 'browse', 'hover'],
        // `navigation` deliberately maps to the HOMEPAGE tab, not the Navigation
        // tab. The Navigation tab renders only the custom link-list editor for the
        // five hidden array keys (SIDEBAR_LINKS, …); the navigation section's
        // *visible* rows (FEATURE_SIDEBAR, SHOW_FOOTER, NAVIGATION_AVAILABLE_GROUPS,
        // FEATURE_DOCK_TOGGLE) are rendered by HomepageSettingsTab, which passes the
        // whole loaded schema through. Pointing at ?tab=navigation landed the user on
        // a tab where the highlighted row does not exist.
        //
        // `browse` and `hover` moved here off the general settings page; they are
        // rendered by the same HomepageSettingsTab (whole-schema passthrough), so
        // they map to the homepage tab for the identical reason.
        tabForSection: {
            homepage: 'homepage',
            trending: 'homepage',
            navigation: 'homepage',
            browse: 'homepage',
            hover: 'homepage',
        },
    },
    {
        href: '/admin/settings/music',
        label: m.admin_nav_page_settings_music,
        sectionIds: ['music'],
        tabForSection: { music: 'settings' },
    },
];

/**
 * Sections that exist in the schema but have no settings page (no route loads
 * them). They are intentionally not reachable via search deep-links.
 *
 * Now empty, and it should stay that way. `requests` used to sit here, which
 * meant the Jellyseerr URL/API key were settable only via environment variable
 * or by hand-editing settings.json. An
 * entry here is a config surface an operator cannot reach: add one only when a
 * section is deliberately not operator-facing, never to paper over a page that
 * forgot to load it.
 */
export const ORPHAN_SECTION_IDS: ReadonlySet<string> = new Set<string>();

const sectionIndex: Map<string, { href: string; label: () => string; tab?: string }> = new Map();
for (const page of ADMIN_SETTINGS_PAGES) {
    for (const id of page.sectionIds) {
        sectionIndex.set(id, {
            href: page.href,
            label: page.label,
            tab: page.tabForSection?.[id],
        });
    }
}

export function getPageForSection(
    sectionId: string,
): { href: string; label: string; tab?: string } | undefined {
    const entry = sectionIndex.get(sectionId);
    if (!entry) return undefined;
    return { href: entry.href, label: entry.label(), tab: entry.tab };
}
