// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import {
    loadSettingsForSections,
    loadSearchExposure,
    saveSettingsAction,
    reloadSettingsAction,
} from '$lib/server/admin/settings-helpers';

// Settings → Task runner: `advanced-tasks` is task-runner tuning and the
// per-task killswitches. It is the configuration counterpart of the operator
// screens under /admin/tasks, and has nothing to do with the branding/feature
// toggles it used to share the general settings page with.
const SECTION_IDS = ['advanced-tasks', 'advanced-tasks-tuning'];

export const load: PageServerLoad = async () => {
    const data = await loadSettingsForSections(SECTION_IDS);
    const exposure = await loadSearchExposure();
    return { ...data, ...exposure, warnings: [] as string[] };
};

export const actions: Actions = {
    save: async ({ request, locals }) => saveSettingsAction(request, locals),
    reload: async ({ locals }) => reloadSettingsAction(locals),
};
