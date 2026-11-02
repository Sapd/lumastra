// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_library_fix_matches,
    description: m.admin_nav_desc_library_fix_matches,
    keywords: kw(m.admin_nav_kw_library_fix_matches),
    tabs: [
        {
            id: 'never',
            param: 'view',
            title: m.admin_fix_matches_tab_never,
            keywords: kw(m.admin_nav_kw_tab_fix_matches_never),
        },
        {
            id: 'broken',
            param: 'view',
            title: m.admin_fix_matches_tab_broken,
            keywords: kw(m.admin_nav_kw_tab_fix_matches_broken),
        },
    ],
};
