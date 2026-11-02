// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Jellyfin Connect — Connected Clients
 *
 * GET - List the Jellyfin-compatible clients (Swiftfin, Findroid, Streamyfin, …)
 *       currently signed in as the calling user.
 *
 * Every `/j/Users/AuthenticateByName` or Quick Connect approval mints a
 * 30-day compat session distinct from both the web login and the OAuth/device
 * tokens on `/settings/sessions`. Before this endpoint those sessions were
 * invisible and individually unrevokable — the only lever was deleting the
 * whole client password, which signs out every client at once.
 *
 * Sessions carry no server-side "last seen", so the list reports pairing time
 * (`createdAt`) rather than last activity.
 */

import type { RequestHandler } from './$types';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { withValkeyRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { features } from '$lib/server/config.js';
import { listSessionsForUser } from '$lib/server/proprietary/jellyfin-compat/auth.js';
import { Database } from '$lib/server/database/connection.js';
import { getUserByUsername } from '$lib/server/database/queries/users.queries.js';
import { JellyfinClientSessionsResponseSchema } from '$lib/schemas/api-user-responses.js';

const ENDPOINT = '/api/jellyfin-connect/sessions';

// Rate limited despite being a read: the FIRST call for a user (before the
// backfill marker is set) runs a full `jfcompat:session:*` SCAN against the
// shared noeviction coordination instance. Without a cap, repeated loads before
// that marker lands can stack concurrent SCANs. 30/min is far above any real
// settings-page usage and bounds the amplification.
export const GET: RequestHandler = withValkeyRateLimit(
    30,
    60,
)(
    requireAuth(
        withErrorHandler(async ({ locals }) => {
            if (!features.jellyfinCompat) {
                return ApiResponses.notFound('Feature', ENDPOINT);
            }

            const db = new Database();
            const sql = db.getSql();

            const userRow = await getUserByUsername(sql, locals.user.username);
            if (!userRow) {
                return ApiResponses.notFound('User', ENDPOINT);
            }

            return typedJson(JellyfinClientSessionsResponseSchema, {
                items: await listSessionsForUser(userRow.id),
            });
        }),
    ),
);
