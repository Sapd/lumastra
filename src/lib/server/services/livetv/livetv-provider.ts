// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Provider Interface
 *
 * Defines the contract for LiveTV providers (Standalone, Disabled).
 * Route handlers import from the index.ts factory — never directly from provider files.
 */

import type {
    LiveTvChannel,
    LiveTvFeedProgram,
    LiveTvCategory,
    LiveTvStreamInfo,
    ProgramSearchAiring,
} from '$lib/schemas/livetv.js';
import type {
    JoinAdaptiveRequest,
    JoinCapRequest,
    JoinClientCaps,
} from '../../../../shared/livetv-proxy-types.js';

/** What the player can decode. See StreamMultiplexer.compatVariantFor. */
export interface LiveTvJoinCompat {
    client?: JoinClientCaps;
}

/** Per-join behaviour that is not part of what the player can decode. */
export interface LiveTvJoinOptions {
    /**
     * Wait for the first segment before the join answers, and count the answer as a
     * successful start. Only the playback-session start path of a normal (non-preview)
     * viewer sets it: previews, Jellyfin-compat joins and retry joins answer at once.
     */
    awaitReady?: boolean;
    /** Called with the feeds whose URLs were sent to the proxy, in that order. */
    onFeedsSent?: (feeds: Array<{ id: string; name: string }>) => void;
}

export interface LiveTvProvider {
    getChannels(): Promise<LiveTvChannel[]>;
    getChannel(channelId: string): Promise<LiveTvChannel | undefined>;
    getCurrentProgram(channelId: string): Promise<LiveTvFeedProgram | undefined>;
    getPrograms(channelId: string, start: Date, end: Date): Promise<LiveTvFeedProgram[]>;
    searchPrograms(query: string, limit?: number, offset?: number): Promise<ProgramSearchAiring[]>;
    searchChannels(query: string, limit?: number): Promise<LiveTvChannel[]>;
    getStreamInfo(
        channelId: string,
        viewerId: string,
        cap?: JoinCapRequest,
        adaptive?: JoinAdaptiveRequest,
        compat?: LiveTvJoinCompat,
        options?: LiveTvJoinOptions,
    ): Promise<LiveTvStreamInfo>;
    getCategories(): Promise<LiveTvCategory[]>;
    getGuidePrograms(start: Date, end: Date): Promise<Record<string, LiveTvFeedProgram[]>>;
}
