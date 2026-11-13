// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';

/**
 * Section IDs that belong on the general settings page.
 *
 * Kept deliberately short: this page used to render all 13 config sections
 * (~275 settings) and was the de-facto dumping ground for anything without a
 * home. Everything with a natural owner now lives on that owner's page —
 * groups/auth/social → /admin/settings/access, browse/hover →
 * /admin/settings/homepage, sync → /admin/settings/providers, image/media →
 * /admin/settings/media, advanced-tasks → /admin/settings/tasks. What remains
 * is genuinely instance-wide: identity (branding), the cross-cutting feature
 * switchboard, global runtime defaults, the enterprise module flags, and the
 * lumastra.org contact switches.
 *
 * `src/lib/config/admin-settings-pages.ts` mirrors this split for deep links;
 * the two must stay in sync (its unit test enforces single ownership).
 */
const SECTION_IDS = [
    'branding',
    'features',
    'localization',
    'diagnostics',
    'advanced',
    'enterprise',
    'licensing',
];

export const load: PageServerLoad = async () => {
    const data = await loadSettingsForSections(SECTION_IDS);
    const exposure = await loadSearchExposure();
    return { ...data, ...exposure, warnings: [] as string[] };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
