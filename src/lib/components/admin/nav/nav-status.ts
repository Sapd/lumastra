// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared status-dot resolution for the admin nav renderers (admin IA redesign,
 * spec §4/§5). The manifest never computes status; renderers resolve a section's
 * `statusKey` against the ONE status payload store and render a dot with these.
 */

import type { AttentionVerdict } from '$lib/schemas/api-attention-responses.js';
import type { AdminNavSection, AdminSectionId } from '$lib/config/admin-nav.js';
import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
import { sectionForItem } from '$lib/shared/attention-section-map.js';
import * as m from '$lib/paraglide/messages.js';
import { resolveActiveNavPath } from '../admin-nav.utils.js';

export interface NavStatusDot {
    /** Tailwind background class for the dot. */
    colorClass: string;
    /** Localized accessible label. */
    label: string;
    /** Whether to show the dot at all (healthy → no dot). */
    show: boolean;
}

/** Map a verdict to a dot descriptor. `healthy` renders no dot (quiet default). */
export function verdictToDot(verdict: AttentionVerdict | undefined): NavStatusDot {
    switch (verdict) {
        case 'critical':
            return { colorClass: 'bg-red-500', label: m.admin_nav_status_critical(), show: true };
        case 'degraded':
            return {
                colorClass: 'bg-amber-400',
                label: m.admin_nav_status_degraded(),
                show: true,
            };
        default:
            return {
                colorClass: 'bg-emerald-500',
                label: m.admin_nav_status_healthy(),
                show: false,
            };
    }
}

/** Resolve a section's current status dot from the live status payload store. */
export function sectionDot(id: AdminSectionId): NavStatusDot {
    const verdict = adminStatus.payload?.sectionStatus?.[id];
    return verdictToDot(verdict);
}

/**
 * Count of open (unacked, unsnoozed) attention items that light a given
 * section's dot — same `sectionForItem` mapping the server uses to derive
 * `sectionStatus`, so this count can never disagree with why the dot is lit.
 * Used for the nav dot's hover tooltip (explain before clicking).
 */
export function sectionAttentionCount(id: AdminSectionId): number {
    const items = adminStatus.payload?.attention.items ?? [];
    let count = 0;
    for (const item of items) {
        if (item.acked || item.snoozed) continue;
        if (sectionForItem(item) === id) count += 1;
    }
    return count;
}

/** A sourceRef's pathname: drops origin, query, hash and a trailing slash. */
function refPath(ref: string): string {
    let path: string;
    try {
        path = new URL(ref, 'http://admin.invalid').pathname;
    } catch {
        path = ref.split(/[?#]/)[0];
    }
    return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** Same rule the server uses for `sectionStatus`: info items never light a dot. */
const SEVERITY_RANK: Record<string, number> = { warning: 1, critical: 2 };

/**
 * Per-page attention dots for one section, keyed by page path. A page gets a
 * dot only when an open attention item that lights THIS section's dot links
 * (`sourceRef`) into that page — the longest-match page wins, so
 * `/admin/tasks/media-probe?tab=failures` lands on Overview. Pages no item
 * points at get no entry; there are no per-page counts to show.
 */
export function pageAttentionDots(section: AdminNavSection): Record<string, NavStatusDot> {
    const items = adminStatus.payload?.attention.items ?? [];
    const paths = section.pages.map((p) => p.path);
    const worst: Record<string, number> = {};
    for (const item of items) {
        if (item.acked || item.snoozed || !item.sourceRef) continue;
        const rank = SEVERITY_RANK[item.severity] ?? 0;
        if (rank === 0 || sectionForItem(item) !== section.id) continue;
        const path = resolveActiveNavPath(refPath(item.sourceRef), paths);
        if (path && rank > (worst[path] ?? 0)) worst[path] = rank;
    }
    const dots: Record<string, NavStatusDot> = {};
    for (const [path, rank] of Object.entries(worst)) {
        dots[path] = verdictToDot(rank === 2 ? 'critical' : 'degraded');
    }
    return dots;
}
