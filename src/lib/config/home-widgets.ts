// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages';

/**
 * Built-in homepage widgets in their default order. Single source of truth for
 * both the homepage and the /settings/home customize UI. Keep in sync with the
 * widget renderers on `src/routes/+page.svelte`.
 */
export const BUILT_IN_WIDGET_IDS = [
    'watch-parties',
    'streaming-sessions',
    'for-you',
    'trending',
    'holiday-recommendations',
    'live-tv',
    'watchlist',
    'upcoming-episodes',
    'calendar',
] as const;

/** Translated, human-readable widget name (falls back to the raw id). */
export function getWidgetName(id: string): string {
    const names: Record<string, string> = {
        'watch-parties': m.widget_watch_parties(),
        'streaming-sessions': m.widget_streaming_sessions(),
        'for-you': m.widget_for_you(),
        trending: m.widget_trending(),
        'holiday-recommendations': m.widget_holiday_recommendations(),
        watchlist: m.widget_watchlist(),
        'upcoming-episodes': m.widget_upcoming_episodes(),
        'live-tv': m.widget_live_tv(),
        calendar: m.widget_series_calendar(),
    };
    return names[id] ?? id;
}

/**
 * Resolve a widget's display name, including plugin-contributed widgets whose
 * titles live in `data.pluginWidgets`. Built-in names win; plugin titles are the
 * fallback; the raw id is the last resort.
 */
export function resolveWidgetName(id: string, data: WidgetVisibilityData): string {
    const builtIn = getWidgetName(id);
    if (builtIn !== id) return builtIn;
    const plugin = (data.pluginWidgets ?? []).find((w) => w.id === id);
    return plugin?.title ?? id;
}

/** Plugin-contributed home widget, surfaced to the customize UI. */
export interface PluginWidgetRef {
    /** Composite id matching the home page: `plugin:<featureId>:<widgetId>`. */
    id: string;
    /** Display name (the widget's declared title). */
    title?: string;
}

/** Minimal `$page.data` shape needed to resolve widget visibility. */
export interface WidgetVisibilityData {
    user?: { userGroups?: string[]; hasLiveTvPermission?: boolean } | null;
    adminGroups?: string[];
    features?: Record<string, boolean>;
    homepage?: { widgetOrder?: string[]; widgetVisibility?: Record<string, string> };
    /**
     * Plugin-contributed home-placement widgets (e.g. the shoutbox). Supplied by
     * the route's server load so the customize UI can reorder/hide them like
     * built-ins. Below-hero banners are excluded upstream (controlled by their
     * own plugin settings, not the widget grid).
     */
    pluginWidgets?: PluginWidgetRef[];
}

/**
 * The holiday widget is off unless the admin turned it on
 * (DISABLE_HOLIDAY_RECOMMENDATIONS, default true). `=== true` so a missing
 * flag means off. Shared by the home page and the customize UI.
 */
export function isHolidayWidgetAvailable(features: Record<string, boolean> | undefined): boolean {
    return features?.holidays === true;
}

function groupMatch(userGroups: string[] = [], allowed: string[] = []): boolean {
    const lower = userGroups.map((g) => g.toLowerCase());
    return allowed.some((g) => lower.includes(g.toLowerCase()));
}

/** Admin force-disabled a widget for everyone. */
export function isWidgetAdminDisabled(id: string, data: WidgetVisibilityData): boolean {
    return data.homepage?.widgetVisibility?.[id] === 'disabled';
}

/**
 * Resolve the widget model for the customize UI, mirroring the homepage's
 * permission + admin-visibility rules:
 *  - `allWidgetIds`: widgets the user may see and reorder (permission-filtered,
 *    admin order honored), excluding admin-disabled ones.
 *  - `adminDisabledWidgets`: admin force-disabled widgets, surfaced separately so
 *    the UI can show them greyed/non-interactive.
 */
export function buildHomeWidgetModel(data: WidgetVisibilityData): {
    allWidgetIds: string[];
    adminDisabledWidgets: string[];
} {
    const features = data.features ?? {};
    const isAdmin = groupMatch(data.user?.userGroups, data.adminGroups);
    const permissionChecks: Record<string, () => boolean> = {
        'streaming-sessions': () =>
            features.sessions !== false && (features.sessionsPublic !== false || isAdmin),
        'watch-parties': () => features.watchTogether !== false,
        'live-tv': () => data.user?.hasLiveTvPermission ?? false,
        calendar: () => features.calendar !== false,
        'holiday-recommendations': () => isHolidayWidgetAvailable(features),
    };

    // Candidate ids = built-ins + plugin-contributed widgets. Plugin widgets
    // follow built-ins by default, mirroring the home page's getAllWidgetIds()
    // (`[...builtIns, ...pluginIds]`).
    const pluginIds = (data.pluginWidgets ?? []).map((w) => w.id);

    // Admin-configured order first (may already contain plugin ids), then any
    // built-ins it omits, then any plugin widgets it omits. Matches the
    // homepage's getDefaultWidgetIds().
    // Legacy ids an old admin config may still carry ('ai-recommendations',
    // 'activity-feed', a removed download-client widget) have no widget behind
    // them. The home page already drops them (getDefaultWidgetIds in
    // routes/+page.svelte); this list did not, so /settings/home showed them
    // as raw ids that toggled nothing.
    const known = new Set<string>([...BUILT_IN_WIDGET_IDS, ...pluginIds]);
    const adminOrder = (data.homepage?.widgetOrder ?? []).filter((id) => known.has(id));
    const ordered =
        adminOrder.length > 0
            ? [
                  ...adminOrder,
                  ...BUILT_IN_WIDGET_IDS.filter((id) => !adminOrder.includes(id)),
                  ...pluginIds.filter((id) => !adminOrder.includes(id)),
              ]
            : [...BUILT_IN_WIDGET_IDS, ...pluginIds];

    const allWidgetIds: string[] = [];
    const adminDisabledWidgets: string[] = [];
    const seen = new Set<string>();
    for (const id of ordered) {
        if (seen.has(id)) continue; // dedup: an id present in both adminOrder and a candidate list
        seen.add(id);
        if (isWidgetAdminDisabled(id, data)) {
            adminDisabledWidgets.push(id);
            continue;
        }
        const check = permissionChecks[id];
        if (check && !check()) continue; // not permitted -> not available to configure
        allWidgetIds.push(id);
    }
    return { allWidgetIds, adminDisabledWidgets };
}
