// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_developer_sonic_embeddings,
    description: m.admin_nav_desc_developer_sonic_embeddings,
    keywords: kw(m.admin_nav_kw_developer_sonic_embeddings),
    permission: { devOnly: true },
};
