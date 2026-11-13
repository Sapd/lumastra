// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Assistant conversation history (GET /api/assistant/history)
 *
 * Every assistant chat turn is already persisted by `runAssistant` via
 * `insertChatExchange` (see assistant.queries.ts) — but the chat UI only ever
 * held the transcript in client-side memory, so a page reload silently
 * dropped the visible conversation even though the rows were still in
 * `assistant_messages`. This route is a thin read-only endpoint the frontend
 * can hydrate from on mount.
 *
 * Text-only: recommendation cards attached to an assistant reply are NOT
 * persisted alongside `content`, so a rehydrated transcript restores the
 * back-and-forth text but not the card UI that accompanied it.
 */
import type { RequestHandler } from './$types';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { AssistantHistoryResponseSchema } from '$lib/schemas/api-ai-responses.js';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { parseInteger } from '$lib/utils/data-extraction.js';
import { getRecentAssistantConversation } from '$lib/server/database/queries/assistant.queries.js';

const logger = Logger.for('AIAssistantHistory');

const DEFAULT_LIMIT = 50;
const MIN_LIMIT = 1;
const MAX_LIMIT = 100;

export const GET: RequestHandler = withErrorHandler(async ({ locals, url }) => {
    try {
        if (!locals.user?.username) {
            return ApiResponses.unauthorized('Authentication required');
        }

        const sqlDb = getDb();
        if (!sqlDb) {
            return ApiResponses.serviceUnavailable('AI database');
        }
        const sql = sqlDb; // Non-nullable after check

        const rawLimit = parseInteger(url.searchParams.get('limit')) ?? DEFAULT_LIMIT;
        const limit = Math.min(Math.max(MIN_LIMIT, rawLimit), MAX_LIMIT);

        const rawAfter = url.searchParams.get('after');
        let after: Date | undefined;
        if (rawAfter !== null && rawAfter !== '') {
            const parsed = new Date(rawAfter);
            if (Number.isNaN(parsed.getTime())) {
                return ApiResponses.badRequest(
                    'Invalid "after" query parameter',
                    'Expected an ISO-8601 timestamp',
                );
            }
            after = parsed;
        }

        const messages = await getRecentAssistantConversation(sql, locals.user.userId, {
            limit,
            after,
        });

        return typedJson(AssistantHistoryResponseSchema, { messages });
    } catch (err) {
        logger.error('History fetch error', err instanceof Error ? err : new Error(String(err)));

        if (err instanceof Response) {
            return err;
        }

        return ApiResponses.error('Internal server error', err instanceof Error ? err : undefined);
    }
});
