// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/database/connection';
import { handleTraktCallback } from './trakt-callback.js';

export const GET: RequestHandler = async ({ url, locals }) => {
    const user =
        locals.user?.username && locals.user?.userId
            ? { username: locals.user.username, userId: locals.user.userId }
            : null;
    const { redirectTo } = await handleTraktCallback({ url, user, sql: getDb() });
    throw redirect(302, redirectTo);
};
