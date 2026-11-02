// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_my_requests` assistant tool.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { toUserId } from '$lib/shared/user-id.js';
import { getMyRequestsTool } from './get-my-requests.tool.js';
import type { AssistantToolContext } from './types.js';
import type { JellyseerrRequest } from '../../jellyseerr.js';

vi.mock('../../jellyseerr.js', () => ({
    jellyseerrClient: { getFulfilledRequestsForUser: vi.fn() },
}));

import { jellyseerrClient } from '../../jellyseerr.js';
import { assistantTestUser } from './test-context.js';

const TEST_CTX_USER_ID = toUserId(randomUUID());

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: TEST_CTX_USER_ID,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        accessCtx: {
            username: 'alice',
            deniedGroupIds: null,
            ageRating: null,
            liveTvAllowed: true,
            showUnavailableMedia: true,
        },
        embedQuery: async () => '[0]',
    };
}

const readyRequest = {
    type: 'movie',
    media: { tmdbId: 603 },
    mediaInfo: { title: 'The Lantern' },
} as unknown as JellyseerrRequest;

describe('getMyRequestsTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it("lists the user's fulfilled (ready) requests", async () => {
        vi.mocked(jellyseerrClient.getFulfilledRequestsForUser).mockResolvedValue([readyRequest]);

        const result = await getMyRequestsTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);

        // `count` → `returnedCount` + an always-present page marker (see
        // result-counts.ts): a bare `count` beside a list kept being relayed as
        // a library total ("wir haben 10 Filme") no matter what the prompt said.
        expect(summary.returnedCount).toBe(1);
        expect(summary.requests[0]).toMatchObject({
            title: 'The Lantern',
            type: 'movie',
            status: 'available',
        });
        // USERNAME, not the users.id UUID: Jellyseerr resolves this argument
        // through getUserByUsername, which a UUID never matches — passing the
        // UUID made the tool return [] for everyone.
        expect(vi.mocked(jellyseerrClient.getFulfilledRequestsForUser).mock.calls[0][0]).toBe(
            'alice',
        );
    });

    it('returns a graceful note when there are no fulfilled requests', async () => {
        vi.mocked(jellyseerrClient.getFulfilledRequestsForUser).mockResolvedValue([]);
        const result = await getMyRequestsTool.execute({}, makeCtx());
        const summary = JSON.parse(result.summaryForModel);
        expect(summary.returnedCount).toBe(0);
        expect(summary.note).toContain('No fulfilled requests');
    });
});
