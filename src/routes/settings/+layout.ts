// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { LayoutLoad } from './$types';
import { enabledSections, type SettingsVisibilityContext } from '$lib/config/settings-sections';

export const load: LayoutLoad = async ({ parent }) => {
    const parentData = (await parent()) as {
        features?: App.PageData['features'];
        authMethod?: string;
        allWidgetIds?: string[];
        malConfigured?: boolean;
    };

    const ctx: SettingsVisibilityContext = {
        features: parentData.features ?? {},
        authMethod: parentData.authMethod,
        // allWidgetIds is not always present on layout data; default to showing
        // Home (the widget list loads inside the Home page in Plan 2).
        hasWidgets: Array.isArray(parentData.allWidgetIds)
            ? parentData.allWidgetIds.length > 0
            : true,
        // Real deployment-level MAL state from the root layout, so a MAL-only
        // install (Jellyfin/Subsonic compat off) still gets the Connections section
        // instead of being redirected away.
        malConfigured: parentData.malConfigured === true,
    };

    return {
        settingsCtx: ctx,
        // Serializable nav model (no icon components cross the load boundary).
        enabledSectionIds: enabledSections(ctx).map((s) => s.id),
    };
};
