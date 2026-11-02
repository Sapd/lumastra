// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_system_transcode_failures,
    description: m.admin_nav_desc_system_transcode_failures,
    keywords: kw(m.admin_nav_kw_system_transcode_failures),
};
