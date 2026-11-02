// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { getDb } from '$lib/server/database/connection.js';
import { getWidgetOrder } from '$lib/server/database/queries/index.js';

/**
 * Surface plugin-contributed home widgets to the /settings/home customize UI so
 * users can reorder/hide them alongside built-ins. Mirrors the home page's
 * `plugin:<featureId>:<widgetId>` id. Only 'home'-placement widgets are
 * reorderable; 'below-hero' banners (e.g. announcements) are controlled by their
 * own plugin settings, not the widget grid. Per-viewer access gating still
 * happens inside each plugin's own routes.
 *
 * Also loads the user's saved widget order/hidden set from the DB (canonical
 * source — localStorage is no longer used) so the customize UI seeds its
 * editable list from the same place the home page SSRs from.
 */
export const load: PageServerLoad = async ({ locals }) => {
    const pluginWidgets = taskRegistry.getAllFeatures().flatMap((f) =>
        (f.widgets ?? [])
            // Allowlist, NOT a below-hero denylist: this editor configures the
            // home GRID, so every placement that isn't 'home' (detail, player,
            // settings-user, …) must stay out of it. A denylist silently leaks
            // each new placement into this list the day it is added.
            .filter((w) => (w.placement ?? 'home') === 'home')
            .map((w) => ({ id: `plugin:${f.id}:${w.id}`, title: w.title })),
    );

    let userWidgetOrder: string[] | null = null;
    let userHiddenWidgets: string[] | null = null;
    const userId = locals.user?.userId;
    if (userId) {
        const sql = getDb();
        if (sql) {
            const row = await getWidgetOrder.one(sql, { userId }).catch(() => null);
            userWidgetOrder = row?.widget_order ?? null;
            userHiddenWidgets = row?.hidden_widgets ?? null;
        }
    }

    return { pluginWidgets, userWidgetOrder, userHiddenWidgets };
};
