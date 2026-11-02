// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The registry → page-data projection of plugin widgets.
 *
 * Extracted from the home page's own load once a second surface needed it. The
 * detail modal opens from EVERY route, so its widget metadata has to come from
 * the root layout load rather than from `+page.server.ts` — and the moment two
 * loads build the same list, the de-duplication below has to be shared or the
 * two surfaces disagree about which widget won a collision.
 */

import { registry as taskRegistry } from '$lib/server/tasks/registry.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PluginWidgets');

/** One widget, flattened for the client. */
export interface PluginWidgetMeta {
    /** Host-wide id, `plugin:<featureId>:<widgetId>`. */
    id: string;
    featureId: string;
    widgetId: string;
    title: string;
    entry: string;
    placement: string;
    defaultVisible: boolean;
    /** Detail placement only: which media types this widget mounts for. */
    forMediaTypes?: string[];
    minHeightPx?: number;
    chrome?: boolean;
    /**
     * Player placement only: which region of the overlay to mount in.
     *
     * Omitting this from the projection made the `player` placement doubly
     * dead — even once the region was mounted, every widget arrived without a
     * region and fell into the `panel` default, so `top-right` could never be
     * selected at all.
     */
    playerRegion?: string;
}

/**
 * Every registered plugin widget, across all placements.
 *
 * Duplicate ids are DROPPED, first declaration wins. A duplicate is not
 * hypothetical — two features declaring the same `w.id`, or one feature
 * registered twice — and it reaches the keyed `{#each … (widget.id)}` on the
 * home page, where Svelte's `each_key_duplicate` takes down the entire page
 * rather than the offending widget. Callers filter by placement afterwards.
 */
export function listPluginWidgets(): PluginWidgetMeta[] {
    const seen = new Set<string>();
    return taskRegistry.getAllFeatures().flatMap((f) =>
        (f.widgets ?? []).flatMap((w): PluginWidgetMeta[] => {
            const id = `plugin:${f.id}:${w.id}`;
            if (seen.has(id)) {
                logger.warn(`Dropping duplicate plugin widget id "${id}"`);
                return [];
            }
            seen.add(id);
            return [
                {
                    id,
                    featureId: f.id,
                    widgetId: w.id,
                    title: w.title,
                    entry: w.entry,
                    placement: w.placement ?? 'home',
                    defaultVisible: w.defaultVisible ?? true,
                    ...(w.forMediaTypes ? { forMediaTypes: [...w.forMediaTypes] } : {}),
                    ...(w.minHeightPx !== undefined ? { minHeightPx: w.minHeightPx } : {}),
                    ...(w.chrome !== undefined ? { chrome: w.chrome } : {}),
                    ...(w.playerRegion ? { playerRegion: w.playerRegion } : {}),
                },
            ];
        }),
    );
}

/**
 * Widgets for one placement.
 *
 * Always an allowlist on the placement itself — never "everything except X".
 * A denylist admits each newly-invented placement into whichever surface used
 * it, which is exactly the bug the home grid and both of its config editors
 * shipped with.
 */
export function listPluginWidgetsFor(placement: string): PluginWidgetMeta[] {
    return listPluginWidgets().filter((w) => w.placement === placement);
}

/** A plugin page projected into the sidebar's MenuItem shape. */
export interface PluginNavEntry {
    label: string;
    url: string;
    icon: string;
    section?: string;
    displayOrder?: number;
    /** Stable identity for keyed rendering — index-composed keys reshuffle. */
    key: string;
}

/**
 * Sidebar entries for plugin pages this viewer may open.
 *
 * Filtered here as well as in the page load, and the page load is the one that
 * matters: hiding a nav entry is cosmetic, and a viewer who guesses the URL
 * must still be refused. This exists so the sidebar does not advertise doors
 * that will 404.
 */
export function listPluginNavEntries(user: {
    isAdmin?: boolean;
    userGroups?: string[];
}): PluginNavEntry[] {
    const groups = new Set(user.userGroups ?? []);
    return taskRegistry.getAllFeatures().flatMap((f) =>
        (f.pages ?? []).flatMap((page): PluginNavEntry[] => {
            if (!page.nav) return [];
            const access = page.access;
            if (access?.adminOnly && user.isAdmin !== true) return [];
            if (access?.groups?.length && !access.groups.some((g) => groups.has(g))) return [];
            return [
                {
                    label: page.title,
                    url: page.id === 'index' ? `/p/${f.id}` : `/p/${f.id}/${page.id}`,
                    icon: page.nav.icon ?? 'puzzle-piece',
                    ...(page.nav.section ? { section: page.nav.section } : {}),
                    ...(page.nav.displayOrder !== undefined
                        ? { displayOrder: page.nav.displayOrder }
                        : {}),
                    key: `plugin:${f.id}:${page.id}`,
                },
            ];
        }),
    );
}
