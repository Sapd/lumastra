// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import * as m from '$lib/paraglide/messages.js';
import { kw, type AdminSearchMeta } from '$lib/config/admin-search-meta';

export const searchMeta: AdminSearchMeta = {
    title: m.admin_nav_page_tasks_runs,
    description: m.admin_nav_desc_tasks_runs,
    keywords: kw(m.admin_nav_kw_tasks_runs),
    tabs: [
        {
            id: 'running',
            param: 'status',
            title: m.route_admin_runs_filter_running,
            keywords: kw(m.admin_nav_kw_tab_runs_running),
        },
        {
            id: 'failed',
            param: 'status',
            title: m.route_admin_runs_filter_failed,
            keywords: kw(m.admin_nav_kw_tab_runs_failed),
        },
        {
            id: 'completed',
            param: 'status',
            title: m.route_admin_runs_filter_completed,
            keywords: kw(m.admin_nav_kw_tab_runs_completed),
        },
        {
            id: 'all',
            param: 'status',
            title: m.route_admin_runs_filter_all,
        },
    ],
};
