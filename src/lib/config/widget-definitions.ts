// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Homepage widget definitions and feature-flag helpers.
 *
 * Split out of `$lib/config/schema` (2026-09-25) so pages that only need the
 * homepage widget list don't pull in the full, much heavier settings schema
 * on their client critical path. `schema.ts` re-exports everything here so
 * existing importers are unaffected.
 */

// ============================================================================
// Type Definitions
// ============================================================================

// All available homepage widget IDs
export const HOMEPAGE_WIDGET_IDS = [
    'watch-parties',
    'streaming-sessions',
    'for-you',
    'trending',
    'watchlist',
    'upcoming-episodes',
    'calendar',
] as const;

export type HomepageWidgetId = (typeof HOMEPAGE_WIDGET_IDS)[number];

// Widget metadata for admin UI
export interface WidgetDefinition {
    id: HomepageWidgetId;
    label: string;
    icon: string;
    featureFlag?: string; // Optional feature flag dependency
    permissionNote?: string; // e.g., "Admin only"
}

// Widget definitions with labels and metadata
export const WIDGET_DEFINITIONS: WidgetDefinition[] = [
    {
        id: 'watch-parties',
        label: 'Watch Parties',
        icon: 'users',
        featureFlag: 'FEATURE_WATCH_TOGETHER',
    },
    {
        id: 'streaming-sessions',
        label: 'Streaming Sessions',
        icon: 'tv',
        featureFlag: 'FEATURE_SESSIONS',
    },
    { id: 'for-you', label: 'For You', icon: 'sparkles' },
    {
        id: 'trending',
        label: 'Trending',
        icon: 'fire',
        featureFlag: 'FEATURE_TRENDING',
    },
    { id: 'watchlist', label: 'Watchlist', icon: 'bookmark' },
    { id: 'upcoming-episodes', label: 'Upcoming Episodes', icon: 'calendar' },
    {
        id: 'calendar',
        label: 'Calendar',
        icon: 'calendar-days',
        featureFlag: 'FEATURE_CALENDAR',
    },
];

/**
 * `FEATURE_WATCH_TOGETHER` -> `watchTogether`, the key that flag takes in the
 * `features` object exposed to the client.
 */
export function featureKeyForFlag(flag: string): string {
    return flag
        .replace(/^FEATURE_/, '')
        .toLowerCase()
        .replace(/_(.)/g, (_, c: string) => c.toUpperCase());
}

/**
 * The `features` key a homepage widget depends on, or undefined when it has no
 * flag.
 *
 * Derived from WIDGET_DEFINITIONS on purpose. Both the home page and the admin
 * widget editor used to hand-maintain their own flag lists, and they drifted:
 * the admin editor knew `trending` was off and greyed it out, while the home
 * page had no entry for it and rendered the widget anyway.
 */
export function widgetFeatureKey(widgetId: string): string | undefined {
    const flag = WIDGET_DEFINITIONS.find((w) => w.id === widgetId)?.featureFlag;
    return flag ? featureKeyForFlag(flag) : undefined;
}
