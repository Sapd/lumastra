// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { config } from '$lib/server/config.js';
import { getLicenseStatus } from '$lib/server/licensing/entitlements';
import { Logger } from '$lib/server/utils/logger.js';
import type { LicenseStatusSummary } from '$lib/components/admin/settings/license-status-summary';

const logger = Logger.for('AdminSettingsGeneral');

/**
 * What the Licensing section shows next to the key field: whether the key that
 * is set actually verified, and what it unlocks. Without it the section was a
 * bare text box — an operator pasting a key had no way to tell whether it
 * took. Full details (install ID, seats) stay on /admin/system/instance.
 */
async function loadLicenseSummary(): Promise<LicenseStatusSummary | null> {
    try {
        const status = await getLicenseStatus();
        return {
            validity: status.validity,
            edition: status.entitlements.edition,
            tier: status.tier,
            enforcementEnabled: status.enforcementEnabled,
            expiresAt: status.expiresAt,
            modules: [...status.entitlements.modules],
            reason: status.reason,
            serverContact: config.LICENSE_SERVER_CONTACT_ENABLED,
        };
    } catch (error) {
        logger.warn('Could not resolve license status for the settings page', error as Error);
        return null;
    }
}

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
 * instance license key.
 *
 * `licensing` had no page at all before this — LICENSE_KEY could only be set by
 * env var or by hand-editing settings.json.
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
    const [exposure, licenseSummary] = await Promise.all([
        loadSearchExposure(),
        loadLicenseSummary(),
    ]);
    return { ...data, ...exposure, licenseSummary, warnings: [] as string[] };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
