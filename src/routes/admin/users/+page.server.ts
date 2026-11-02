// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/users/+page.server.ts
import { config } from '$lib/server/config.js';
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { LocalUser } from '$lib/schemas/api-admin-responses';
import { Logger } from '$lib/server/utils/logger';
import { appPath } from '$lib/shared/api-urls.js';
import { getDb } from '$lib/server/database/connection.js';
import { listUsers } from '$lib/server/database/queries/users.queries.js';
import {
    countUnratedLibraryTitles,
    type UnratedTitleCount,
} from '$lib/server/database/queries/age-rating-source.queries.js';
import { mapUserToApi } from '$lib/server/mappers/user.mapper.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminUsers');

/**
 * Admin-gated load. We seed the initial user list server-side so the first
 * render shows data instead of an empty-then-populate flash. The client
 * keeps its own refresh path (Refresh button + post-mutation reloads) for
 * everything after hydration.
 *
 * NOT via an internal `event.fetch` self-request to this app's own API (the
 * original shape here) — that does not work. Confirmed via prod logs: this
 * app's auth is forward-auth HEADERS (USERHEADER/GROUPHEADER), not a session
 * cookie, and SvelteKit's internal self-fetch for a relative URL does not
 * carry those headers onto the synthetic sub-request — every such self-fetch
 * reaches `resolveAuth` with no authentication headers present and 401s. This
 * was the source pattern `/admin/notifications/+page.server.ts` and
 * `/admin/settings/access/+page.server.ts` copied; all three had the same
 * bug, just with different visibility (an empty user list here degrades
 * quietly, which is why it went unnoticed until the notifications page's
 * failure was visible enough to investigate).
 *
 * Fix: call the same query/mapper `GET /api/admin/users` itself calls
 * (`defs/users/index.ts`), directly, in-process — no HTTP hop, no auth
 * boundary to cross. On any failure we fall back to an empty list and let the
 * client's own (browser-originated, properly-authenticated) fetch kick in —
 * the page still renders.
 */
export const load: PageServerLoad = async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    let initialUsers: LocalUser[] = [];
    let unratedTitles: UnratedTitleCount | null = null;
    const sql = getDb();
    if (!sql) {
        logger.warn('admin/users load: database unavailable');
    } else {
        try {
            const users = await listUsers(sql);
            initialUsers = users.map((row) =>
                mapUserToApi(row as Parameters<typeof mapUserToApi>[0]),
            );
        } catch (e) {
            logger.warn('admin/users load: failed to seed initial users', { error: e });
        }
        // Shown next to the age limit: titles without a rating are hidden from
        // age-limited users. A failure only drops the line.
        try {
            unratedTitles = await countUnratedLibraryTitles(sql);
        } catch (e) {
            logger.warn('admin/users load: failed to count unrated titles', { error: e });
        }
    }

    return {
        initialUsers,
        nativeLoginEnabled: config.AUTH_NATIVE_LOGIN_ENABLED,
        unratedTitles,
        unratedContentVisible: config.UNRATED_CONTENT_VISIBLE,
    };
};
