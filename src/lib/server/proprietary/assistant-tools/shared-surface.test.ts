// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * The shared surface (plugin `ctx.ai` bridge: the shoutbox bot answers in a
 * room everyone reads) must expose no tool that reads or changes the asker's
 * personal state. This test enumerates EVERY tool name: a new tool fails it
 * until someone decides which side of the line it is on.
 */
import { describe, it, expect } from 'vitest';
import { buildAssistantTools } from './registry.js';
import { ASSISTANT_TOOL_NAMES } from '../../../schemas/assistant-tools.js';

const N = ASSISTANT_TOOL_NAMES;

/** Tools that read only the access-scoped catalogue. */
const SHARED_SAFE: string[] = [
    N.SEARCH_LIBRARY,
    N.FIND_MEDIA,
    N.BROWSE_BY_GENRE,
    N.BROWSE_BY_KEYWORD,
    N.FIND_BY_PERSON,
    N.CHECK_AVAILABILITY,
    N.GET_DETAILS,
    N.GET_LIBRARIES,
    N.SEARCH_MUSIC,
    N.FIND_MUSIC_BY_VIBE,
    N.WHATS_ON_TV,
    N.SEARCH_TV_GUIDE,
    N.SEARCH_AUDIOBOOKS,
    N.SEARCH_BOOKS,
];

/** Everything else: personal reads, cross-user reads, operational reads, writes. */
const NOT_SHARED: string[] = [
    N.BUILD_WATCH_PLAN,
    N.ANALYZE_VIEWING_HISTORY,
    N.GET_MY_RATINGS,
    N.GET_WATCH_HISTORY,
    N.GET_SHARED_WATCH_HISTORY,
    N.GET_WATCH_STATS,
    N.GET_WATCHLIST,
    N.GET_PLAYLISTS,
    N.GET_PLAYLIST_ITEMS,
    N.GET_AUDIOBOOK_PROGRESS,
    N.GET_MY_REQUESTS,
    N.GET_SERIES_EPISODES,
    N.GET_UPCOMING_RELEASES,
    N.GET_RECOMMENDATIONS,
    N.GET_TOP_MUSIC,
    N.GET_MUSIC_PICKS,
    N.GET_ACTIVE_STREAMS,
    N.GET_MY_STATS,
    N.ADD_TO_WATCHLIST,
    N.REMOVE_FROM_WATCHLIST,
    N.SET_RATING,
    N.MARK_WATCHED,
    N.CREATE_REQUEST,
];

const ALL_GATES_OPEN = {
    liveTvAllowed: true,
    audiobooksEnabled: true,
    booksEnabled: true,
    streamsViewable: true,
    calendarViewable: true,
    socialWatchHistoryViewable: true,
    personalStatsEnabled: true,
    textToSoundEnabled: true,
    writeActionsEnabled: true,
    requestWritesEnabled: true,
};

describe('shared surface tool set', () => {
    it('classifies every known tool name exactly once', () => {
        const all = Object.values(N).sort();
        expect([...SHARED_SAFE, ...NOT_SHARED].sort()).toEqual(all);
    });

    it('offers exactly the catalogue tools, with every gate open', () => {
        const names = buildAssistantTools({ ...ALL_GATES_OPEN, sharedSurface: true })
            .map((t) => t.name)
            .sort();
        expect(names).toEqual([...SHARED_SAFE].sort());
    });

    it('offers every tool on the private surface when the gates are open (control)', () => {
        const names = buildAssistantTools(ALL_GATES_OPEN)
            .map((t) => t.name)
            .sort();
        expect(names).toEqual(Object.values(N).sort());
    });
});
