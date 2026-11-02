// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared, localized rendering for dependency-check findings — used by both the
 * first-run wizard's "System checks" panel and the admin health page's
 * DependencyChecksPanel, so the two never drift.
 *
 * Client-safe: defines its own view type (does NOT import the server module, which
 * pulls in node:fs / postgres) and only touches paraglide messages.
 */

import * as m from '$lib/paraglide/messages.js';

/** Client view of a server `DependencyFinding` (kept in sync by shape, not import). */
export interface DependencyFindingView {
    id: string;
    name: string;
    status: 'pass' | 'warn';
    url?: string;
    count?: number;
}

/** Localized one-line description of a dependency finding. */
export function dependencyCheckText(c: DependencyFindingView): string {
    if (c.id === 'config-dir') {
        return c.status === 'pass'
            ? m.setup_dep_configdir_ok()
            : m.setup_dep_configdir_warn({ path: c.url ?? '' });
    }
    if (c.id === 'media-paths-ok') {
        return m.setup_dep_mediapaths_ok({ count: String(c.count ?? 0) });
    }
    if (c.id.startsWith('media-path:')) {
        return m.setup_dep_mediapath_warn({ path: c.url ?? c.name });
    }
    return c.status === 'pass'
        ? m.setup_dep_reachable({ name: c.name })
        : m.setup_dep_unreachable({ name: c.name, url: c.url ?? '' });
}
