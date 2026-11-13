// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Registry of assistant tools exposed to the model.
 *
 * Tools are added here only after their implementation + unit test have been
 * reviewed and checkpointed, so `main` always compiles with a coherent tool
 * set. The dispatch loop and OpenAI tool definitions are both derived from
 * whatever this returns.
 *
 * @module server/proprietary/assistant-tools/registry
 */

import type { AssistantTool } from './types.js';
import { ASSISTANT_TOOL_NAMES as N } from '../../../schemas/assistant-tools.js';
import { searchLibraryTool } from './search-library.tool.js';
import { findMediaTool } from './find-media.tool.js';
import { buildWatchPlanTool } from './build-watch-plan.tool.js';
import { analyzeViewingHistoryTool } from './analyze-viewing-history.tool.js';
import { checkAvailabilityTool } from './check-availability.tool.js';
import { getMyRatingsTool } from './get-my-ratings.tool.js';
import { getWatchHistoryTool } from './get-watch-history.tool.js';
import { getSharedWatchHistoryTool } from './get-shared-watch-history.tool.js';
import { getWatchStatsTool } from './get-watch-stats.tool.js';
import { getWatchlistTool } from './get-watchlist.tool.js';
import { searchMusicTool } from './search-music.tool.js';
import { getDetailsTool } from './get-details.tool.js';
import { getLibrariesTool } from './get-libraries.tool.js';
import { getPlaylistsTool } from './get-playlists.tool.js';
import { getPlaylistItemsTool } from './get-playlist-items.tool.js';
import { getMyRequestsTool } from './get-my-requests.tool.js';
import { browseByKeywordTool } from './browse-by-keyword.tool.js';
import { browseByGenreTool } from './browse-by-genre.tool.js';
import { findByPersonTool } from './find-by-person.tool.js';
import { getSeriesEpisodesTool } from './get-series-episodes.tool.js';
import { getUpcomingReleasesTool } from './get-upcoming-releases.tool.js';
import { getRecommendationsTool } from './get-recommendations.tool.js';
import { getTopMusicTool } from './get-top-music.tool.js';
import { getMusicPicksTool } from './get-music-picks.tool.js';
import { findMusicByVibeTool } from './find-music-by-vibe.tool.js';
import { whatsOnTvTool } from './whats-on-tv.tool.js';
import { searchTvGuideTool } from './search-tv-guide.tool.js';
import { searchAudiobooksTool } from './search-audiobooks.tool.js';
import { getAudiobookProgressTool } from './get-audiobook-progress.tool.js';
import { searchBooksTool } from './search-books.tool.js';
import { getActiveStreamsTool } from './get-active-streams.tool.js';
import { getMyStatsTool } from './get-my-stats.tool.js';
import { addToWatchlistTool } from './add-to-watchlist.tool.js';
import { removeFromWatchlistTool } from './remove-from-watchlist.tool.js';
import { setRatingTool } from './set-rating.tool.js';
import { markWatchedTool } from './mark-watched.tool.js';
import { createRequestTool } from './create-request.tool.js';

/**
 * Tools that read only the access-scoped catalogue — nothing about WHO is
 * asking. These are the ONLY tools offered on a shared surface (the plugin
 * `ctx.ai` bridge, whose answer is published to a room other people read and
 * whose prompt includes text other people wrote). Everything else — personal
 * reads (ratings, history, watchlist, playlists, requests, progress, stats,
 * taste-based picks), cross-user reads, operational reads and every write — is
 * deliberately absent, and a tool missing from this set is excluded, so a new
 * tool is private until someone lists it here.
 *
 * `shared-surface.test.ts` enumerates every tool name against this set.
 */
export const SHARED_SURFACE_TOOL_NAMES: ReadonlySet<string> = new Set<string>([
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
]);

/**
 * Per-request capability gates. Tools that expose data behind a feature flag or
 * an access boundary (Live TV visibility, optional integrations) are only
 * included when the caller is actually allowed to use them, so the model never
 * sees — and therefore cannot call — a tool that would return "not available".
 */
export interface BuildAssistantToolsOptions {
    /** Caller may view Live TV — gates `whats_on_tv` + `search_tv_guide`. */
    liveTvAllowed?: boolean;
    /** Audiobookshelf configured — gates `search_audiobooks`. */
    audiobooksEnabled?: boolean;
    /** Kavita configured — gates `search_books`. */
    booksEnabled?: boolean;
    /** Caller may view active streams — gates `get_active_streams`. */
    streamsViewable?: boolean;
    /**
     * Caller may view the release calendar — gates `get_upcoming_releases`.
     *
     * Mirrors `GET /api/calendar`, which 403s age-restricted profiles outright.
     * That refusal is the ACTUAL age control on this data, not the access
     * boundary: upcoming episodes have no files and no library group, and
     * `buildLibraryAccessFilter` treats a file-less row as visible to everyone,
     * so the library axis is a no-op on every row the calendar returns.
     *
     * `runAssistant` already throws `AiUnavailableError` for an age-restricted
     * principal, so this gate cannot currently be false on the live path — it
     * exists so that a future caller which skips that check does not silently
     * inherit the calendar, and so the decision is greppable next to the data
     * it protects.
     */
    calendarViewable?: boolean;
    /** Operator enabled social sharing and caller may use social assistant data. */
    socialWatchHistoryViewable?: boolean;
    /** Personal stats enabled — gates `get_my_stats`. */
    personalStatsEnabled?: boolean;
    /** CLAP text-to-sound search configured (`features.textToSound`) — gates `find_music_by_vibe`. */
    textToSoundEnabled?: boolean;
    /**
     * Operator enabled `FEATURE_ASSISTANT_WRITES` AND this run may mutate user
     * state — gates `add_to_watchlist`, `remove_from_watchlist`, `set_rating`
     * and `mark_watched`.
     *
     * False for the plugin `ctx.ai` bridge, and the tools are then ABSENT rather
     * than refusing: nothing stops a plugin's prompt from steering the model
     * into rating or watchlisting against the viewer's real account, and a tool
     * the model cannot see is a stronger guarantee than one that says no.
     */
    writeActionsEnabled?: boolean;
    /**
     * Caller may submit media requests AND request management is configured —
     * gates `create_request`.
     *
     * Separate from `writeActionsEnabled` because it is a different capability
     * with a different blast radius: the other four change rows this user owns,
     * this one files a request with the admin. A user without `hasRequestPermission` must
     * never be OFFERED it.
     */
    requestWritesEnabled?: boolean;
    /**
     * The answer is shown to people other than the asker, or the prompt carries
     * text other people wrote (plugin `ctx.ai` bridge). Restricts the list to
     * {@link SHARED_SURFACE_TOOL_NAMES}, whatever the other gates say.
     */
    sharedSurface?: boolean;
}

/**
 * Build the ordered list of tools the assistant may call. Order is the order
 * the model sees them in the `tools` array (search first — it's primary).
 *
 * Capability-gated tools are appended only when their gate in `opts` is set, so
 * a user without Live TV access is not offered the Live TV tools at all.
 */
export function buildAssistantTools(opts: BuildAssistantToolsOptions = {}): AssistantTool[] {
    const tools: AssistantTool[] = [
        getRecommendationsTool,
        searchLibraryTool,
        findMediaTool,
        buildWatchPlanTool,
        analyzeViewingHistoryTool,
        browseByGenreTool,
        browseByKeywordTool,
        findByPersonTool,
        checkAvailabilityTool,
        getDetailsTool,
        getSeriesEpisodesTool,
        getWatchlistTool,
        getMyRatingsTool,
        getWatchHistoryTool,
        getWatchStatsTool,
        getLibrariesTool,
        getPlaylistsTool,
        getPlaylistItemsTool,
        getMyRequestsTool,
        searchMusicTool,
        getTopMusicTool,
        getMusicPicksTool,
    ];

    if (opts.liveTvAllowed) {
        tools.push(whatsOnTvTool, searchTvGuideTool);
    }
    if (opts.audiobooksEnabled) {
        tools.push(searchAudiobooksTool, getAudiobookProgressTool);
    }
    if (opts.booksEnabled) {
        tools.push(searchBooksTool);
    }
    if (opts.streamsViewable) {
        tools.push(getActiveStreamsTool);
    }
    if (opts.calendarViewable) {
        tools.push(getUpcomingReleasesTool);
    }
    if (opts.socialWatchHistoryViewable) {
        tools.push(getSharedWatchHistoryTool);
    }
    if (opts.personalStatsEnabled) {
        tools.push(getMyStatsTool);
    }
    if (opts.textToSoundEnabled) {
        tools.push(findMusicByVibeTool);
    }
    // WRITE ACTIONS last: they are the least-used tools and the ones the model
    // should reach for only on an explicit instruction.
    if (opts.writeActionsEnabled) {
        tools.push(addToWatchlistTool, removeFromWatchlistTool, setRatingTool, markWatchedTool);
    }
    if (opts.writeActionsEnabled && opts.requestWritesEnabled) {
        tools.push(createRequestTool);
    }

    if (opts.sharedSurface) {
        return tools.filter((t) => SHARED_SURFACE_TOOL_NAMES.has(t.name));
    }
    return tools;
}
