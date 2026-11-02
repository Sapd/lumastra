// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { LayoutServerLoad } from './$types';
import { config } from '$lib/server/config';
import { appPath } from '$lib/shared/api-urls.js';

/**
 * Server-side gate for the whole `/admin/developer/*` section (admin IA
 * redesign, spec §3.7: the Developer section is "hidden" behind the "Show
 * developer tools" setting). `devOnly` in `$lib/config/admin-nav.ts` only
 * hides the section from the nav renderers — it does not stop a direct URL
 * from rendering the page, unlike `enterpriseOnly` pages which each have a
 * real per-route server check on the route itself. This
 * layout closes that gap for the whole section in one place rather than
 * requiring every current and future Developer route to remember its own
 * check (edge case hunter finding 2026-07-10 #5).
 *
 * Admin auth itself is already enforced by the parent `/admin/+layout.server.ts`
 * — this only adds the feature-flag gate on top.
 */
export const load: LayoutServerLoad = () => {
    if (!config.SHOW_DEVELOPER_TOOLS) {
        redirect(303, appPath('/admin'));
    }
};
