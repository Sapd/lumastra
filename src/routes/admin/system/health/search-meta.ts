// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_system_health,
    description: m.admin_nav_desc_system_health,
    keywords: kw(m.admin_nav_kw_system_health),
    destinations: [
        {
            id: 'cluster',
            param: 'tab',
            hash: 'hardware-encoder-check',
            title: m.admin_hardware_diagnostics,
            description: m.admin_hardware_diagnostics_description,
            keywords: kw(m.admin_hardware_keywords),
        },
    ],
    tabs: [
        {
            id: 'overview',
            param: 'view',
            title: m.admin_redesign_health_overview,
            keywords: kw(m.admin_nav_kw_tab_health_overview),
        },
        {
            id: 'diagnostics',
            param: 'view',
            title: m.admin_redesign_health_diagnostics,
            keywords: kw(m.admin_nav_kw_tab_health_diagnostics),
        },
        {
            id: 'history',
            param: 'view',
            title: m.admin_redesign_health_history,
            keywords: kw(m.admin_nav_kw_tab_health_history),
        },
        {
            id: 'cluster',
            param: 'tab',
            title: m.admin_health_tab_cluster,
            description: m.admin_nav_tabdesc_health_cluster,
            keywords: kw(m.admin_nav_kw_tab_health_cluster),
        },
    ],
};
