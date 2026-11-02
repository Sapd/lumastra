// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_tasks_pipeline,
    description: m.admin_nav_desc_tasks_pipeline,
    keywords: kw(m.admin_nav_kw_tasks_pipeline),
    tabs: [
        {
            id: 'flow',
            param: 'view',
            title: m.admin_pipeline_tab_flow,
            keywords: kw(m.admin_nav_kw_tab_pipeline_flow),
        },
        {
            id: 'completion',
            param: 'view',
            title: m.admin_pipeline_tab_completion,
            keywords: kw(m.admin_nav_kw_tab_pipeline_completion),
        },
    ],
};
