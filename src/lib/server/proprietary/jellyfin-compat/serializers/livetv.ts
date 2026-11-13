// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { JELLYFIN_SERVER_ID } from '$lib/server/proprietary/jellyfin-compat/constants';
import type { LiveTvChannel, LiveTvFeedProgram } from '$lib/schemas/livetv';
import { liveTvMetadataSource } from '../livetv-live-stream';

/**
 * Jellyfin clients (Moonfin, jellyfin-androidtv) filter the LiveTV guide by
 * IsMovie/IsSports/IsKids/IsNews on each program. Real Jellyfin sources these
 * from EPG `<category>` tags, but XMLTV/M3U providers commonly omit them
 * entirely — ours does. The admin-assigned channel category (the bouquet
 * grouping shown in /admin/settings/livetv) is the only content-type signal
 * that actually exists here, so approximate the per-program flags from it.
 * Every program on a "Movies" category channel is treated as a movie, etc.
 * Keywords cover the English admin UI defaults and common German bouquet names.
 */
const MOVIE_CATEGORY_KEYWORDS = ['movie', 'film', 'kino'];
const SPORTS_CATEGORY_KEYWORDS = ['sport'];
const KIDS_CATEGORY_KEYWORDS = ['kids', 'kinder', 'family'];
const NEWS_CATEGORY_KEYWORDS = ['news', 'nachrichten'];

function categoryIncludesAny(category: string | undefined, keywords: string[]): boolean {
    if (!category) return false;
    const lower = category.toLowerCase();
    return keywords.some((keyword) => lower.includes(keyword));
}

interface ProgramContentFlags {
    IsMovie: boolean;
    IsSports: boolean;
    IsKids: boolean;
    IsNews: boolean;
}

export function programFlagsForCategory(category: string | undefined): ProgramContentFlags {
    return {
        IsMovie: categoryIncludesAny(category, MOVIE_CATEGORY_KEYWORDS),
        IsSports: categoryIncludesAny(category, SPORTS_CATEGORY_KEYWORDS),
        IsKids: categoryIncludesAny(category, KIDS_CATEGORY_KEYWORDS),
        IsNews: categoryIncludesAny(category, NEWS_CATEGORY_KEYWORDS),
    };
}

/**
 * Fields real Jellyfin attaches to every program and that its clients read
 * without a null check. jellyfin-androidtv's FullDetailsFragment.addButtons()
 * does `baseItem.getUserData().getPlayedPercentage()` for anything playable —
 * a program DTO without UserData crashes the whole app the moment its details
 * page opens (prod 2026-09-13: every tap on an "On Now" card). Programs carry
 * no per-user state here, so the block is always zeroed; the client only needs
 * it to exist.
 */
function programUserData(programId: string): Record<string, unknown> {
    return {
        PlaybackPositionTicks: 0,
        PlayedPercentage: 0,
        Played: false,
        IsFavorite: false,
        PlayCount: 0,
        Key: programId,
        ItemId: programId,
    };
}

const TICKS_PER_MS = 10_000;

/** Listing duration as Jellyfin ticks (100 ns); undefined when the range is unparseable. */
function programRunTimeTicks(startTime: string, endTime: string): number | undefined {
    const durationMs = Date.parse(endTime) - Date.parse(startTime);
    if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;
    return durationMs * TICKS_PER_MS;
}

/**
 * @param channelNumber 1-based position of the channel in the full channel list.
 *   `channel.sortOrder` is a WITHIN-CATEGORY ordering key that restarts at 0 for
 *   every category, so it repeats across the flat list a Jellyfin client renders
 *   (prod: 9 categories → each number appearing up to 9 times). Callers that know
 *   the global position pass it here; the sortOrder fallback only applies when
 *   the position genuinely can't be determined.
 */
export function serializeChannel(
    channel: LiveTvChannel,
    channelNumber?: number,
    isFavorite = false,
): Record<string, unknown> {
    const imageTags: Record<string, string> = {};
    if (channel.images.primary?.href) {
        imageTags['Primary'] = '0';
    }

    // CurrentProgram must include the same fields a standalone /LiveTv/Programs
    // response would (ChannelName, IsMovie, IsSeries, MediaType). jellyfin-androidtv's
    // ProgramGridCell renderer skips programs missing these — leaving the guide row
    // empty for every channel except the one currently focused, where the SDK refetches.
    const channelHasLogo = Boolean(channel.images.primary?.href);
    const contentFlags = programFlagsForCategory(channel.category);
    const currentProgram = channel.currentProgram
        ? {
              Name: channel.currentProgram.title,
              Id: channel.currentProgram.id,
              ServerId: JELLYFIN_SERVER_ID,
              Type: 'Program',
              MediaType: 'Video',
              Overview: channel.currentProgram.description ?? undefined,
              StartDate: channel.currentProgram.startTime,
              EndDate: channel.currentProgram.endTime,
              ChannelId: channel.id,
              ChannelName: channel.name,
              ChannelPrimaryImageTag: channelHasLogo ? '0' : undefined,
              IsLive: true,
              ...contentFlags,
              IsSeries: false,
              IsRepeat: false,
              Genres: channel.currentProgram.genres ?? [],
              OfficialRating: channel.currentProgram.officialRating ?? undefined,
              ImageTags: {},
              RunTimeTicks: programRunTimeTicks(
                  channel.currentProgram.startTime,
                  channel.currentProgram.endTime,
              ),
              UserData: programUserData(channel.currentProgram.id),
          }
        : undefined;

    return {
        Name: channel.name,
        Id: channel.id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'TvChannel',
        ChannelType: 'TV',
        Number: (channelNumber ?? channel.sortOrder).toString(),
        // Jellyfin's AddChannelInfo sets both; apps read ChannelNumber.
        ChannelNumber: (channelNumber ?? channel.sortOrder).toString(),
        CurrentProgram: currentProgram,
        ImageTags: imageTags,
        MediaType: 'Video',
        // Android TV scans this source for its forced audio language before
        // PlaybackInfo. Supply the object/list without opening a live stream.
        MediaSources: [liveTvMetadataSource(channel.id)],
        UserData: {
            PlaybackPositionTicks: 0,
            PlayedPercentage: 0,
            Played: false,
            IsFavorite: isFavorite,
            PlayCount: 0,
            Key: channel.id,
            ItemId: channel.id,
        },
    };
}

export function serializeProgram(
    program: LiveTvFeedProgram,
    channelName: string,
    isLive?: boolean,
    channelHasLogo?: boolean,
    channelCategory?: string,
): Record<string, unknown> {
    const now = new Date();
    const start = new Date(program.startTime);
    const end = new Date(program.endTime);
    const computedIsLive = isLive ?? (start <= now && now < end);
    const contentFlags = programFlagsForCategory(channelCategory);

    // jellyfin-androidtv's CardPresenter primarily reads ImageTags.Primary to pick
    // a tile image — ChannelPrimaryImageTag alone won't render. We set both: the
    // Primary entry uses tag '0' so the client constructs
    // /Items/{programId}/Images/Primary?tag=0, which our image route then resolves
    // by looking the program up and serving the parent channel's logo.
    return {
        Name: program.title,
        Id: program.id,
        ServerId: JELLYFIN_SERVER_ID,
        Type: 'Program',
        MediaType: 'Video',
        ChannelId: program.channelId,
        ChannelName: channelName,
        ChannelPrimaryImageTag: channelHasLogo ? '0' : undefined,
        StartDate: program.startTime,
        EndDate: program.endTime,
        Overview: program.description ?? undefined,
        ...contentFlags,
        IsSeries: false,
        IsRepeat: false,
        IsLive: computedIsLive,
        Genres: program.genres ?? [],
        OfficialRating: program.officialRating ?? undefined,
        ImageTags: channelHasLogo ? { Primary: '0' } : {},
        RunTimeTicks: programRunTimeTicks(program.startTime, program.endTime),
        UserData: programUserData(program.id),
    };
}
