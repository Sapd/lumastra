// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * `get_my_requests` tool — the user's OWN media requests that are now
 * available ("your requests are ready").
 *
 * Backed by the Jellyseerr client, which resolves the request list for THIS
 * user and is internally guarded by `isConfigured()` (returns [] when
 * Jellyseerr is not set up — common for OSS installs). TEXT-ONLY.
 *
 * @module server/proprietary/assistant-tools/get-my-requests.tool
 */

import {
    getMyRequestsArgsSchema,
    ASSISTANT_TOOL_NAMES,
    type GetMyRequestsArgs,
} from '../../../schemas/assistant-tools.js';
import { jellyseerrClient } from '../../jellyseerr.js';
import type { AssistantTool, AssistantToolContext, AssistantToolExecuteResult } from './types.js';
import { resultCounts } from './result-counts.js';

/**
 * Mirrors the hard `take: 100` in jellyseerr.ts's request fetch. Kept as a named
 * constant so the count helper cannot silently drift from the page size.
 */
const JELLYSEERR_PAGE_SIZE = 100;

export const getMyRequestsTool: AssistantTool<GetMyRequestsArgs> = {
    name: ASSISTANT_TOOL_NAMES.GET_MY_REQUESTS,
    description:
        'List the user\'s OWN media requests that have become available to watch ("are my requests ready?"). Returns the titles the user requested that are now available. If request management is not configured, this returns nothing.',
    argsSchema: getMyRequestsArgsSchema,

    async execute(
        _args: GetMyRequestsArgs,
        ctx: AssistantToolContext,
    ): Promise<AssistantToolExecuteResult> {
        // USERNAME, not the users.id UUID. `getFulfilledRequestsForUser` resolves
        // its argument through `getUserByUsername`, which matches against
        // Jellyseerr's jellyfinUsername / username / displayName — a UUID matches
        // none of them, so this returned [] on the "expected, not an error" path
        // and the model told every user they had no requests ready.
        const username = ctx.accessCtx.username ?? ctx.user.username;
        const requests = await jellyseerrClient.getFulfilledRequestsForUser(username);

        const summaryForModel = JSON.stringify({
            // NOT a total. jellyseerr.ts passes a hard `take: 100` and never
            // pages, then post-filters that page down to the fulfilled ones — so
            // a user with 140 approved requests gets the first 100 filtered to
            // whatever is available, and calling it complete let the model say
            // "du hast insgesamt 30 erfüllte Anfragen". The client also swallows
            // errors and returns [], so a Jellyseerr outage would otherwise be
            // reported as a confident zero.
            ...resultCounts(requests.length, JELLYSEERR_PAGE_SIZE),
            note:
                requests.length === 0
                    ? 'No fulfilled requests found (or request management is not configured).'
                    : undefined,
            requests: requests.map((r) => ({
                title: r.mediaInfo?.title ?? r.mediaInfo?.name ?? `tmdb:${r.media?.tmdbId}`,
                type: r.type,
                status: 'available',
            })),
        });

        ctx.logger?.debug('get_my_requests executed', {
            username,
            ready: requests.length,
        });

        return { summaryForModel };
    },
};
