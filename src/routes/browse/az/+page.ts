// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A filter is not the A-Z mode — send `/browse/az?tag=…` to the results view.
 *
 * A load function rather than an onMount check, so it applies to SSR entry,
 * client-side navigation and browser back alike, before any component mounts.
 * Bare `/browse/az` falls through untouched and still renders A-Z.
 *
 * `/browse/az` does not inherit `/browse/+page.server.ts` (page server loads
 * are per-route); its own server loader carries the watching policy signal.
 */

import { redirect } from '@sveltejs/kit';
import { appPath } from '$lib/shared/api-urls.js';
import { filterRedirectTarget } from '$lib/shared/browse-filter-route.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ url, data }) => {
    const target = filterRedirectTarget(url);
    // appPath, not resolve: `resolve()` emits a RELATIVE url during SSR
    // (kit.paths.relative defaults true), which is right for markup but not for
    // a redirect Location — see the note in $lib/paths. Matches every other
    // redirect in the app.
    if (target) redirect(307, appPath(target));
    return data;
};
