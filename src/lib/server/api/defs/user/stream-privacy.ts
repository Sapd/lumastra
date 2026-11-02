// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/user/stream-privacy.ts — GET /user/stream-privacy
 *                                POST /user/stream-privacy
 *
 * Replaces the createPreferenceHandlers factory route.
 * Returns stream privacy plus the reciprocal coarse-listening opt-in.
 * Auth: {kind:'user'} — self-scoped.
 * Errors: problem+json.
 */

import { typedJson } from '$lib/server/utils/typed-response.js';
import {
    StreamPrivacyResponseSchema,
    type StreamPrivacyResponse,
} from '$lib/schemas/api-user-responses.js';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/connection.js';
import { features } from '$lib/server/config.js';
import { isSocialSharingConfigured } from '$lib/server/database/queries/builders/social-visibility.builder.js';

export const StreamPrivacyBody = StreamPrivacyResponseSchema.omit({
    listeningCircleConfigured: true,
})
    .partial()
    .refine(
        (body) =>
            body.hideFromOthers !== undefined ||
            body.shareListeningActivity !== undefined ||
            body.shareAudiobookActivity !== undefined,
        { message: 'At least one privacy field is required' },
    );

/**
 * Shape a stored row for the client.
 *
 * Takes a REQUIRED row on purpose. Defaulting a missing row to "sharing on"
 * meant a failed SELECT rendered the settings toggles in the permissive state —
 * a privacy control must never report a value it did not actually read. Callers
 * surface the read failure instead.
 */
function privacyResponse(row: {
    hide_streams: boolean;
    share_listening_activity: boolean;
    share_audiobook_activity: boolean;
}): StreamPrivacyResponse {
    return {
        hideFromOthers: row.hide_streams,
        shareListeningActivity: row.share_listening_activity,
        shareAudiobookActivity: row.share_audiobook_activity,
        listeningCircleConfigured: features.social && isSocialSharingConfigured(),
    };
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    request: {
        body: StreamPrivacyBody,
    },
    handlers: {
        /**
         * GET /user/stream-privacy
         * Returns the authenticated user's stream privacy setting.
         */
        GET: async (event, _ctx) => {
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            const rows = await sql<
                {
                    hide_streams: boolean;
                    share_listening_activity: boolean;
                    share_audiobook_activity: boolean;
                }[]
            >`
                SELECT hide_streams, share_listening_activity, share_audiobook_activity
                FROM users
                WHERE username = ${username}
            `.catch(() => null);

            // Distinguish "could not read" from "read a row". Both used to
            // collapse into a permissive default; only the second is safe to
            // render as the user's actual privacy state.
            if (rows === null) return ApiProblem.dependencyUnavailable('Database is unavailable');
            const row = rows[0];
            if (!row) return ApiProblem.notFound('User not found');

            return typedJson(StreamPrivacyResponseSchema, privacyResponse(row));
        },

        /**
         * POST /user/stream-privacy
         * Updates the authenticated user's stream privacy setting.
         */
        POST: async (event, ctx) => {
            const username = event.locals.principal?.username ?? event.locals.user?.username;
            if (!username) return ApiProblem.unauthorized();

            const body = ctx.input?.body as
                | {
                      hideFromOthers?: boolean;
                      shareListeningActivity?: boolean;
                      shareAudiobookActivity?: boolean;
                  }
                | undefined;
            if (body === undefined) {
                return ApiProblem.validationFailed([
                    { field: 'body', message: 'At least one privacy field is required' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database is unavailable');

            // Users always have an existing row in `users`; a plain UPDATE suffices.
            //
            // Protect this self-service choice from later admin default applications.
            // Keep the historical timestamp for compatibility with older migrations.
            const rows = await sql<
                {
                    hide_streams: boolean;
                    share_listening_activity: boolean;
                    share_audiobook_activity: boolean;
                }[]
            >`
                UPDATE users
                SET hide_streams = coalesce(${body.hideFromOthers ?? null}, hide_streams),
                    share_listening_activity = coalesce(
                        ${body.shareListeningActivity ?? null},
                        share_listening_activity
                    ),
                    share_audiobook_activity = coalesce(
                        ${body.shareAudiobookActivity ?? null},
                        share_audiobook_activity
                    ),
                    sharing_explicitly_set_by_user = true,
                    privacy_prefs_updated_at = now()
                WHERE username = ${username}
                RETURNING hide_streams, share_listening_activity, share_audiobook_activity
            `;

            const row = rows[0];
            if (!row) return ApiProblem.notFound('User not found');
            return typedJson(StreamPrivacyResponseSchema, privacyResponse(row));
        },
    },
});
