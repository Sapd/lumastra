// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad, Actions } from './$types';
import { createSettingsPageServer } from '$lib/server/admin/settings-helpers';
import { listAdminProviders } from '$lib/server/plugins/runtime/admin-providers-listing';
import { hasHealthCheck } from '$lib/server/admin/provider-health';

const base = createSettingsPageServer(['foryou', 'ai-assistant']);

// The AI service cards (status + live check) used to sit on the Providers page,
// away from the keys that configure them — which live here.
export const load: PageServerLoad = async () => {
    const [data, providers] = await Promise.all([base.load(), listAdminProviders()]);
    const aiProviders = providers.filter((p) => p.category === 'ai');
    return {
        ...data,
        aiProviders,
        aiCheckableIds: aiProviders
            .filter((p) => hasHealthCheck(p.provider))
            .map((p) => p.provider),
    };
};

export const actions: Actions = base.actions;
