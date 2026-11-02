// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';

// Settings → Media & images: the two sections that describe how generated
// media artefacts are produced and stored — `image` (proxy caching, quality,
// formats) and `media` (on-disk location of trickplay/artwork/lyrics). Both
// used to sit near the bottom of the ~275-setting general page, where nothing
// but scroll position related them to each other.
//
// `topshelf` joined from the Playback page: it configures generated
// preview/cinemagraph artefacts for the tvOS Top Shelf, the same kind of thing.
const SECTION_IDS = ['image', 'media', 'topshelf'];

export const load: PageServerLoad = async () => {
    const data = await loadSettingsForSections(SECTION_IDS);
    const exposure = await loadSearchExposure();
    return { ...data, ...exposure, warnings: [] as string[] };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
