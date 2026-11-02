// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Settings → Connections: one section per external service (URL, key, Test
 * connection, the feature switches that depend on it), plus the request
 * policy (Jellyseerr) and the background-sync intervals for these services.
 * These keys used to sit in one flat 36-setting "Service Connections" list on
 * the Providers page.
 */

import { redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { CONNECTION_SERVICES, connectionStatuses } from '$lib/server/admin/connection-status';
import { appPath } from '$lib/shared/api-urls.js';
import { getDb } from '$lib/server/database/connection.js';
import { features } from '$lib/server/config.js';
import { getJellyfinPairingStatus } from '$lib/server/services/jellyfin-pairing-status.service.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

export const load: PageServerLoad = async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }
    const [settingsData, exposure] = await Promise.all([
        loadSettingsForSections([...CONNECTION_SERVICES.map((s) => s.section), 'sync']),
        loadSearchExposure(),
    ]);
    const sql = getDb();
    const jellyfinPairing = features.jellyfinSync
        ? sql
            ? await getJellyfinPairingStatus(sql).catch(() => null)
            : null
        : { count: 0, examples: [] };
    return { ...settingsData, ...exposure, connections: connectionStatuses(), jellyfinPairing };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
