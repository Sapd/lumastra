// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { settingsRedirectTarget } from '$lib/config/settings-sections';

export const load: PageLoad = async ({ parent, data }) => {
    const { settingsCtx } = await parent();
    const target = settingsRedirectTarget('home', settingsCtx);
    if (target) redirect(307, target);
    // When a universal load coexists with a server load, the server load's
    // return is exposed only as `data` here — it is NOT auto-merged into the
    // page. Forward the plugin widgets + the user's saved widget order/hidden set
    // (DB-canonical) so the customize UI can list and seed them.
    return {
        pluginWidgets: data.pluginWidgets,
        userWidgetOrder: data.userWidgetOrder,
        userHiddenWidgets: data.userHiddenWidgets,
    };
};
