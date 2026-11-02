// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_settings_homepage,
    description: m.admin_nav_desc_settings_homepage,
    keywords: kw(m.admin_nav_kw_settings_homepage),
    tabs: [
        {
            id: 'homepage',
            title: m.admin_settings_page_homepage,
            keywords: kw(m.admin_nav_kw_tab_homepage_homepage),
        },
        {
            id: 'navigation',
            title: m.admin_settings_page_navigation,
            keywords: kw(m.admin_nav_kw_tab_homepage_navigation),
        },
        {
            id: 'library-types',
            title: m.admin_settings_page_library_types,
            keywords: kw(m.admin_nav_kw_tab_homepage_library_types),
        },
    ],
};
