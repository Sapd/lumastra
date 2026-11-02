// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `GET /api/assistant/opener` — one proactive suggestion for the chat page.
 *
 * Returns STRUCTURED data, not prose: the client owns the wording so the
 * greeting is localised where the message catalogue lives, and the user's own
 * clock decides the time of day.
 *
 * Cached briefly per user because the chat page can be opened repeatedly in a
 * session and the answer does not meaningfully change minute to minute.
 */
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { buildSearchAccessContext } from '$lib/server/utils/search-access-context';
import {
    buildAssistantOpener,
    type AssistantOpener,
} from '$lib/server/proprietary/assistant-opener.service';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache';
import { scopedCacheKey } from '$lib/server/utils/search-access-context';

/** Short enough to follow a fresh import, long enough to survive tab-hopping. */
const CACHE_TTL_SECONDS = 900;

export const GET: RequestHandler = withErrorHandler(async ({ locals }) => {
    if (!locals.user?.username) return ApiResponses.unauthorized();

    const user = locals.user;
    const sqlDb = getDb();
    if (!sqlDb) return ApiResponses.serviceUnavailable('AI database');
    const sql = sqlDb; // non-nullable after the check

    const accessCtx = await buildSearchAccessContext(sql, user);
    const cache = cacheManager.for(CACHE_NAMESPACES.assistantOpener);

    // Keyed by access SCOPE as well as user: the suggestion names a title, and
    // two callers with different library access must never share one.
    const key = scopedCacheKey(`v1:opener:${user.userId}`, accessCtx);

    const cached = await cache.get<AssistantOpener>(key);
    if (cached) return json(cached);

    const opener = await buildAssistantOpener({ sql, userId: user.userId, accessCtx });
    await cache.set(key, opener, CACHE_TTL_SECONDS);

    return json(opener);
});
