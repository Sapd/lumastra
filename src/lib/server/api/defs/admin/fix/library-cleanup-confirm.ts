// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * admin/fix/library-cleanup-confirm — "the files really are gone".
 *
 * POST /api/admin/fix/library-cleanup-confirm  { libraryPathId, walked }
 * Auth: admin. Errors: problem+json.
 *
 * The scanner refuses to remove missing files when its walk of a folder found
 * far fewer files than the library knows (or none), because that is what an
 * offline share looks like (`library_cleanup_holds`). This confirms the hold
 * the admin is looking at: `walked` must equal the hold's count, so a newer
 * walk that saw something else is never confirmed by an old page. The next
 * scan of the folder then removes the missing files once.
 *
 * 200 { confirmed: true }. 409 conflict when the hold is gone or changed.
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getAdminDb } from '$lib/server/database/connection.js';
import { confirmCleanupHold } from '$lib/server/database/queries/library-cleanup-holds.queries.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('AdminFixLibraryCleanupConfirm');

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: z.object({
            libraryPathId: z.string().uuid().describe('The held library path'),
            walked: z
                .number()
                .int()
                .min(0)
                .max(2_147_483_647)
                .describe('The file count of the hold being confirmed, as shown to the admin'),
        }),
    },
    handlers: {
        POST: async (event, ctx) => {
            const sql = getAdminDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');
            const { libraryPathId, walked } = ctx.input!.body!;
            const confirmedBy =
                event.locals.user?.username ?? event.locals.principal?.username ?? 'admin';
            const confirmed = await confirmCleanupHold(sql, {
                libraryPathId,
                expectedWalked: walked,
                confirmedBy,
            });
            if (!confirmed) {
                return ApiProblem.conflict(
                    'This folder is no longer held, or a newer scan saw a different number of files. Reload the page.',
                );
            }
            logger.info('Admin confirmed stale cleanup for a held library path', {
                libraryPathId,
                walked,
                confirmedBy,
            });
            return json({ confirmed: true });
        },
    },
});
