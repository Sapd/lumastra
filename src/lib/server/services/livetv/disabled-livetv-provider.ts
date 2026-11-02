// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Disabled LiveTV Provider
 *
 * Stub implementation returned when LIVETV_SOURCE is 'disabled'.
 * Returns empty arrays and undefined for all queries.
 */

import type {
    LiveTvChannel,
    LiveTvFeedProgram,
    LiveTvCategory,
    LiveTvStreamInfo,
    ProgramSearchAiring,
} from '$lib/schemas/livetv.js';
import type { LiveTvProvider } from './livetv-provider.js';

export class DisabledLiveTvProvider implements LiveTvProvider {
    async getChannels(): Promise<LiveTvChannel[]> {
        return [];
    }

    async getChannel(_channelId: string): Promise<LiveTvChannel | undefined> {
        return undefined;
    }

    async getCurrentProgram(_channelId: string): Promise<LiveTvFeedProgram | undefined> {
        return undefined;
    }

    async getPrograms(_channelId: string, _start: Date, _end: Date): Promise<LiveTvFeedProgram[]> {
        return [];
    }

    async searchPrograms(
        _query: string,
        _limit?: number,
        _offset?: number,
    ): Promise<ProgramSearchAiring[]> {
        return [];
    }

    async searchChannels(_query: string, _limit?: number): Promise<LiveTvChannel[]> {
        return [];
    }

    async getStreamInfo(_channelId: string, _viewerId: string): Promise<LiveTvStreamInfo> {
        throw new Error('LiveTV is disabled — cannot get stream info');
    }

    async getCategories(): Promise<LiveTvCategory[]> {
        return [];
    }

    async getGuidePrograms(_start: Date, _end: Date): Promise<Record<string, LiveTvFeedProgram[]>> {
        return {};
    }
}
