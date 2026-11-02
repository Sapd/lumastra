// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_settings_music,
    description: m.admin_nav_desc_settings_music,
    keywords: kw(m.admin_nav_kw_settings_music),
    tabs: [
        {
            id: 'settings',
            title: m.admin_nav_page_settings_music,
            keywords: kw(m.admin_nav_kw_tab_music_settings),
        },
        {
            id: 'quick-picks',
            title: m.admin_musicpicks_title,
            keywords: kw(m.admin_nav_kw_tab_music_quick_picks),
        },
        {
            id: 'radio',
            title: m.admin_radio_page_title,
            keywords: kw(m.admin_nav_kw_tab_music_radio),
        },
    ],
};
