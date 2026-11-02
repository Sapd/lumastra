// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_developer_embeddings,
    description: m.admin_nav_desc_developer_embeddings,
    keywords: kw(m.admin_nav_kw_developer_embeddings),
    permission: { devOnly: true },
    tabs: [
        {
            id: 'video',
            title: m.route_admin_embeddings_tab_video,
            keywords: kw(m.admin_nav_kw_tab_embeddings_video),
        },
        {
            id: 'music',
            title: m.route_admin_embeddings_tab_music,
            keywords: kw(m.admin_nav_kw_tab_embeddings_music),
        },
    ],
};
