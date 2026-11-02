// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/database/index.js';
import { getSimpleMode } from '$lib/server/services/livetv/simple-mode.service.js';

// The /livetv layout gates Live TV permission; awaiting it keeps that gate in
// force for a __data.json request that skips the layout load.
export const load: PageServerLoad = async ({ locals, parent }) => {
    const layout = await parent();
    if (layout.liveTvDisabled) throw error(404, 'Live TV is not enabled');
    const sql = getDb();
    if (!sql || !locals.user) throw error(503, 'Database is unavailable');
    return { setupMode: await getSimpleMode(sql, locals.user.userId) };
};
