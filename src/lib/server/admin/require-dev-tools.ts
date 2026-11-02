// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Guard for the Developer section (admin IA redesign, spec §3.7): every
 * `/admin/developer/*` page's `+page.server.ts` load fn calls this first
 * (after the standard `locals.user?.isAdmin` check the shared
 * `/admin/+layout.server.ts` already performs). Direct navigation to a
 * Developer route while "Show developer tools" is off 404s instead of
 * silently rendering — the nav manifest already hides the entries
 * (`devOnly` + `visibleNav`), this closes the direct-URL bypass.
 *
 * `SHOW_DEVELOPER_TOOLS` is the same admin setting that feeds
 * `data.devToolsEnabled` in the layout (Settings → General → "Show
 * developer tools"), read here independently since route `load` functions
 * don't have access to sibling layout data before it resolves.
 */

import { error } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';

export function requireDevTools(): void {
    if (!config.SHOW_DEVELOPER_TOOLS) {
        error(404, 'Not found');
    }
}
