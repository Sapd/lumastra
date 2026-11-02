// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Unit tests for the `get_active_streams` assistant tool.
 *
 * The tool must NOT reimplement visibility — it defers to the shared
 * getVisibleActiveSessions() helper, which is mocked here.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getActiveStreamsTool } from './get-active-streams.tool.js';
import { toUserId } from '$lib/shared/user-id.js';
import type { AssistantToolContext } from './types.js';
import type { StreamSession } from '../../types.js';

const ALICE = toUserId('a1ce0000-0000-4000-a000-000000000000');

vi.mock('../../services/active-sessions-view.service.js', () => ({
    getVisibleActiveSessions: vi.fn(),
}));

import { getVisibleActiveSessions } from '../../services/active-sessions-view.service.js';
import { assistantTestUser } from './test-context.js';

function makeCtx(): AssistantToolContext {
    return {
        sql: {} as never,
        userId: ALICE,
        userIsAdmin: false,
        user: assistantTestUser(),
        writesAllowed: false,
        userGroups: ['users'],
        hasWatchPermission: true,
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

const sessions = [
    {
        username: 'bob',
        title: 'The Lantern',
        mediaType: 'movie',
        playIsPlaying: true,
        streamProgress: 42.7,
        playItemDuration: 7200, // 120 min
        playCurrentTime: 1800, // 30 min in → 90 min left
        clientApp: 'iOS',
    },
    {
        username: 'carol',
        title: 'Pilot',
        seriesName: 'Starhaven',
        seasonNumber: 1,
        episodeNumber: 1,
        mediaType: 'episode',
        playIsPlaying: false,
    },
] as unknown as StreamSession[];

describe('getActiveStreamsTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('passes the viewer through and summarizes visible streams', async () => {
        vi.mocked(getVisibleActiveSessions).mockResolvedValue({
            sessions,
            cacheTimestamp: 123,
            visible: true,
        });

        const result = await getActiveStreamsTool.execute({}, makeCtx());

        // Reuses the shared helper with the caller's viewer identity.
        expect(getVisibleActiveSessions).toHaveBeenCalledWith({
            // The caller's own access context (library groups + age), not a default.
            access: { library: { kind: 'all' }, age: { kind: 'any' } },
            userId: ALICE,
            username: 'alice',
            userGroups: ['users'],
            isAdmin: false,
            hasWatchPermission: true,
            hasLiveTvPermission: true,
        });

        const d = JSON.parse(result.summaryForModel);
        expect(d.available).toBe(true);
        // A visible-session TOTAL, renamed apart from the page counts other
        // tools emit so the model cannot confuse the two.
        expect(d.activeStreamCount).toBe(2);
        expect(d.streams[0].user).toBe('bob');
        expect(d.streams[0].nowPlaying).toBe('The Lantern');
        expect(d.streams[0].progressPercent).toBe(43);
        // ETA so the model can answer "when does Bob finish his movie".
        expect(d.streams[0].remainingMinutes).toBe(90);
        expect(typeof d.streams[0].estimatedFinish).toBe('string');
        expect(d.streams[1].nowPlaying).toBe('Starhaven S1E1 — Pilot');
        expect(d.streams[1].paused).toBe(true);
        // No duration → no ETA fields.
        expect(d.streams[1].remainingMinutes).toBeUndefined();
    });

    it('reports unavailable when the helper denies visibility', async () => {
        vi.mocked(getVisibleActiveSessions).mockResolvedValue({
            sessions: [],
            cacheTimestamp: 0,
            visible: false,
        });
        const result = await getActiveStreamsTool.execute({}, makeCtx());
        expect(JSON.parse(result.summaryForModel).available).toBe(false);
    });

    it('reports nobody streaming when visible but empty', async () => {
        vi.mocked(getVisibleActiveSessions).mockResolvedValue({
            sessions: [],
            cacheTimestamp: 1,
            visible: true,
        });
        const result = await getActiveStreamsTool.execute({}, makeCtx());
        const d = JSON.parse(result.summaryForModel);
        expect(d.available).toBe(true);
        expect(d.activeStreamCount).toBe(0);
        expect(d.note).toMatch(/Nobody/i);
    });
});
