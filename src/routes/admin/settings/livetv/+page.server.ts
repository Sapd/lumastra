// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { loadLiveTvProxyTabData } from '$lib/server/admin/livetv-proxy-data';
import { loadLiveTvFailuresTabData } from '$lib/server/admin/livetv-failures-data';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminSettingsLiveTv');

// Settings → Live TV (admin IA redesign, spec §3.6): sources, channels,
// proxy, and radio are tabs on ONE page instead of four separate routes.
// The Channels and Radio tabs are entirely client-fetching (self-contained
// components, no server data needed) — only Sources (settings framework)
// and Proxy (one conditional status call) need a server load, so both are
// fetched here eagerly; it's cheap and keeps the page a single round trip.
// Failures joins Proxy on the eager list for the same reason: it is one bounded
// query (30 rows) plus a Valkey drain, and an operator lands on this page BECAUSE a
// channel is dead — making the incident that explains it a second round trip away
// would be the wrong trade.
export const load: PageServerLoad = async () => {
    const [settingsData, proxy, failures] = await Promise.all([
        loadSettingsForSections(['livetv']),
        loadLiveTvProxyTabData(),
        // A diagnostics tab must not take the whole page (and its Sources
        // settings form) down with a 500 when Valkey or the table hiccups.
        loadLiveTvFailuresTabData().catch((error: unknown) => {
            logger.warn('Live TV failures could not be loaded', error as Error);
            return {
                incidents: [],
                roots: { libraryRoots: [], transcodeRoot: '' },
                loadError: error instanceof Error ? error.message : String(error),
            };
        }),
    ]);
    return { ...settingsData, warnings: [] as string[], proxy, failures };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
