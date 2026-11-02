// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/library-status
 *
 * Returns a lightweight snapshot of library scan progress, readable by any
 * authenticated user. Intentionally cheap: two COUNT queries, no joins.
 *
 * Response (bare object):
 *   { scanning: boolean, mediaWithFiles: number, totalMediaItems: number }
 *
 * `scanning` is true while an actual in-flight file scan is running (Valkey key).
 * Once the scan completes (or Valkey is unavailable) scanning is false.
 *
 * authz: authenticated-user — any logged-in user may poll library status.
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { getAggregateScanProgress } from '$lib/server/tasks/builtin/native/media-sources/_helpers/file-scanner/progress-store.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('LibraryStatus');

export const libraryStatusDef = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async () => {
            const sql = getDb();

            if (!sql) {
                // 503 so the client treats it as a transient poll error and keeps
                // its generic "setting up" message rather than showing "no media found".
                logger.warn('Database not available for library status');
                return ApiProblem.dependencyUnavailable('Database unavailable');
            }

            const [totalRow, filesRow] = await Promise.all([
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- bare COUNT(*), no title/id/poster/overview or any other per-item field ever leaves this query (verified: the only projection is `count`); nothing here for a library/age predicate to gate. The file's own header states the by-design scope: "readable by any authenticated user".
                sql<[{ count: string }]>`
                    SELECT COUNT(*)::text AS count
                    FROM media_items
                    WHERE status = 'active'
                `,
                // eslint-disable-next-line callback-safety/no-unscoped-media-items -- same justification as the total-count query above: bare COUNT(*), no per-item field returned.
                sql<[{ count: string }]>`
                    SELECT COUNT(*)::text AS count
                    FROM media_items
                    WHERE status = 'active'
                      AND has_files = true
                `,
            ]);

            const totalMediaItems = parseInt(totalRow[0]?.count ?? '0', 10);
            const mediaWithFiles = parseInt(filesRow[0]?.count ?? '0', 10);

            let scanning: boolean;
            try {
                scanning = (await getAggregateScanProgress()) !== null;
            } catch {
                scanning = false;
            }

            return json({ scanning, mediaWithFiles, totalMediaItems });
        },
    },
});
