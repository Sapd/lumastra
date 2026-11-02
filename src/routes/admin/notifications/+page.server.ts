// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// src/routes/admin/notifications/+page.server.ts
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import type { LocalUser } from '$lib/schemas/api-admin-responses';
import type { AdminBroadcast } from '$lib/schemas/admin-broadcasts';
import { Logger } from '$lib/server/utils/logger';
import { appPath } from '$lib/shared/api-urls.js';
import { getDb } from '$lib/server/database/connection.js';
import { listBroadcasts } from '$lib/server/database/queries/admin-broadcasts.queries.js';
import { listUsers } from '$lib/server/database/queries/users.queries.js';
import { mapUserToApi } from '$lib/server/mappers/user.mapper.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';

const logger = Logger.for('AdminBroadcasts');

/**
 * Admin-gated load, seeding BOTH lists server-side.
 *
 * NOT via an internal `event.fetch` self-request to this app's own API — that
 * was the original shape (mirroring `/admin/users/+page.server.ts`) and it does
 * not work: confirmed via prod logs that SvelteKit's internal self-fetch for a
 * relative URL does not carry this app's forward-auth identity headers
 * (USERHEADER/GROUPHEADER) onto the synthetic sub-request at all — every such
 * self-fetch reaches `resolveAuth` with NO authentication headers present and
 * 401s, independent of whether the two fetches run sequentially or
 * concurrently (an earlier fix tried de-parallelizing them; the 401s persisted
 * unchanged). `/admin/users/+page.server.ts`'s own single self-fetch almost
 * certainly has the identical bug — it just goes unnoticed there because an
 * empty initial user list degrades quietly instead of visibly breaking a
 * workflow. Do not use that page as a "self-fetch works" precedent.
 *
 * The actual fix: call the same query/mapper functions the API route handlers
 * themselves call, directly, in-process — no HTTP hop, no auth boundary to
 * cross, same as how the homepage's own `+page.server.ts` already seeds its
 * data (`getWidgetOrder.one(sql, ...)` etc., never `event.fetch` to its own
 * API). `listBroadcasts`/`AdminBroadcastRow` already match the `AdminBroadcast`
 * wire shape field-for-field (verified against `admin-broadcasts.ts`), so no
 * extra mapping is needed there. The user list re-runs the exact
 * `listUsers` + `mapUserToApi` pair `GET /api/admin/users` uses internally
 * (`defs/users/index.ts`) so this can never drift from what that endpoint
 * returns.
 *
 * A failure on either side degrades to an empty array rather than an error
 * page — the page still renders and the client can retry via its own
 * (browser-originated, properly-authenticated) fetch path.
 */
export const load: PageServerLoad = async ({ locals }) => {
    if (!localsIsAdmin(locals)) {
        throw redirect(302, appPath('/'));
    }

    const sql = getDb();
    if (!sql) {
        logger.warn('admin/notifications load: database unavailable');
        return { initialBroadcasts: [] as AdminBroadcast[], initialUsers: [] as LocalUser[] };
    }

    let initialBroadcasts: AdminBroadcast[] = [];
    try {
        initialBroadcasts = await listBroadcasts(sql);
    } catch (e) {
        logger.warn('admin/notifications load: failed to seed broadcasts', { error: e });
    }

    let initialUsers: LocalUser[] = [];
    try {
        const users = await listUsers(sql);
        initialUsers = users.map((row) => mapUserToApi(row as Parameters<typeof mapUserToApi>[0]));
    } catch (e) {
        logger.warn('admin/notifications load: failed to seed users', { error: e });
    }

    return { initialBroadcasts, initialUsers };
};
