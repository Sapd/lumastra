// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_settings_livetv,
    description: m.admin_nav_desc_settings_livetv,
    keywords: kw(m.admin_nav_kw_settings_livetv),
    tabs: [
        {
            id: 'sources',
            title: m.admin_livetv_sources_title,
            keywords: kw(m.admin_nav_kw_tab_livetv_sources),
        },
        {
            id: 'channels',
            title: m.admin_livetv_channels_title,
            keywords: kw(m.admin_nav_kw_tab_livetv_channels),
        },
        {
            id: 'proxy',
            title: m.admin_livetv_proxy_title,
            keywords: kw(m.admin_nav_kw_tab_livetv_proxy),
        },
        {
            id: 'failures',
            title: m.admin_livetv_failures_title,
            keywords: kw(m.admin_nav_kw_tab_livetv_failures),
        },
    ],
};
