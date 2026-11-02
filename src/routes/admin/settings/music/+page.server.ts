// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';
import { loadMusicQuickPicksData } from '$lib/server/admin/music-quick-picks-data';

// Settings → Music (admin IA redesign, spec §3.6): music settings (which
// already absorbed Music Alchemy's fields — see the deleted
// /admin/music-alchemy redirect stub) and the Quick Picks inspector are now
// tabs on ONE page instead of three separate routes. Both loads are cheap
// (cached bucket stats + a couple of indexed queries), so both tabs' data is
// fetched eagerly rather than per-tab-lazy — simplest correct option for a
// low-traffic admin settings page.
export const load: PageServerLoad = async ({ url }) => {
    const [settingsData, quickPicks] = await Promise.all([
        loadSettingsForSections(['music']),
        loadMusicQuickPicksData(url.searchParams.get('userId')),
    ]);
    const exposure = await loadSearchExposure();
    return { ...settingsData, ...exposure, warnings: [] as string[], quickPicks };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
