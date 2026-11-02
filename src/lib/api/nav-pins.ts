// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin nav pins read — `getNavPins()` only.
 *
 * Split out of `$lib/api/admin` (2026-09-25) so Sidebar.svelte's lazy-fetch
 * of pinned admin nav items (the global dock's Admin icon flyout) doesn't
 * have to pull in the whole admin API client module on every page. Mutating
 * nav-pin actions (`addNavPin` / `removeNavPin`) are admin-only UI and stay
 * in `$lib/api/admin`, which re-exports `getNavPins` so other importers keep
 * working.
 */

import { apiGet } from './client.js';
import { AdminNavPinListResponseSchema } from '$lib/schemas/api-admin-nav-pins.js';

/**
 * List pinned admin nav items. Used by the global dock's Admin icon flyout
 * (lazy-fetched on first hover/focus — see Sidebar.svelte) as well as any
 * admin-side pin management UI.
 */
export function getNavPins() {
    return apiGet('/api/admin/nav-pins', AdminNavPinListResponseSchema);
}
