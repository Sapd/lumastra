// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Widget Guard Utility
 *
 * Provides utilities for checking if homepage widgets are enabled/disabled by admin.
 * Used by sensitive homepage widget API routes (sessions, watch-together, calendar, upcoming)
 * to return empty data when a widget is admin-disabled.
 *
 * Non-sensitive endpoints (for-you, ai-suggestions, trending, etc.) don't need guards
 * because the frontend already hides disabled widgets (component doesn't mount = no API call).
 *
 * Sensitive endpoints use guards because:
 * - /api/sessions - Privacy: shows who's watching what
 * - /api/watch-together/* - Privacy: session data with participants
 * - /api/calendar - Security: reveals if Sonarr/Radarr are configured
 * - /api/upcoming - Security: reveals if Sonarr is configured
 * - /api/for-you/new-episodes - follows the 'upcoming-episodes' widget (the banner is part of it)
 */

import { get as getConfigValue } from '$lib/server/config/config.service.js';
import type { WidgetVisibility } from '$lib/config/schema';

/**
 * Get the current widget visibility configuration from admin settings
 */
function getWidgetVisibilityConfig(): Record<string, WidgetVisibility> {
    const config = getConfigValue<Record<string, string>>('HOMEPAGE_WIDGET_VISIBILITY');
    return (config ?? {}) as Record<string, WidgetVisibility>;
}

/**
 * Check if a specific widget is enabled (not admin-disabled)
 * @param widgetId - The widget ID to check
 * @returns true if the widget is enabled, false if admin-disabled
 */
export function isWidgetEnabled(widgetId: string): boolean {
    const visibility = getWidgetVisibilityConfig();
    return visibility[widgetId] !== 'disabled';
}

/**
 * Check if a widget is admin-disabled
 * @param widgetId - The widget ID to check
 * @returns true if the widget is admin-disabled
 */
export function isWidgetDisabled(widgetId: string): boolean {
    const visibility = getWidgetVisibilityConfig();
    return visibility[widgetId] === 'disabled';
}

/**
 * Create a response for a disabled widget with custom data shape.
 *
 * IMPORTANT: Pass the appropriate empty data shape for your endpoint:
 * - createDisabledWidgetResponse({ sessions: [] }) - for /api/sessions
 * - createDisabledWidgetResponse([]) - for endpoints returning arrays
 *
 * @param data - The empty data structure matching your endpoint's normal response
 */
export function createDisabledWidgetResponse<T = unknown>(data: T = [] as T): Response {
    return new Response(
        JSON.stringify({
            success: true,
            data,
            message: 'Widget disabled by administrator',
        }),
        {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
        },
    );
}

/**
 * Create a disabled response for non-ApiResponses endpoints (using json() directly)
 * Used by: watch-together/parties, etc.
 *
 * @param data - The raw response object (not wrapped in { success, data })
 */
export function createDisabledRawResponse<T>(data: T): Response {
    return new Response(JSON.stringify(data), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
    });
}
