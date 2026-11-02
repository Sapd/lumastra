// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * LiveTV Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for all LiveTV-related types.
 * These schemas define the contract for LiveTV channels, programs, categories,
 * stream info, and source configuration.
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .describe() for OpenAPI docs on fields
 * - Export both schema and inferred type
 */

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import * as m from '$lib/paraglide/messages.js';
import { parseLiveTvRefreshIntervalMs } from '$lib/shared/livetv-refresh-schedule.js';
import { LiveTvFailureCodeSchema, LiveTvChannelHealthSchema } from './livetv-failures.js';
import type {
    ProxyChannelInfo as WireProxyChannelInfo,
    ProxyEncoderInfo as WireProxyEncoderInfo,
} from '../../shared/livetv-proxy-types.js';

// ============================================================================
// Temporal Status (Program Search)
// ============================================================================

/**
 * Computed temporal status for program search results
 */
export const TemporalStatusSchema = z.enum(['live', 'upcoming_today', 'future', 'ended']);

export type TemporalStatus = z.infer<typeof TemporalStatusSchema>;

// ============================================================================
// Grouped Program Search Result
// ============================================================================

/**
 * Channel info within a grouped program search result
 */
export const GroupedProgramChannelSchema = z
    .object({
        id: z.string().describe('Station UUID'),
        name: z.string().describe('Channel display name'),
        images: ImageSetSchema,
    })
    .meta({
        id: 'GroupedProgramChannel',
        description: 'Channel in grouped search result',
    });

export type GroupedProgramChannel = z.infer<typeof GroupedProgramChannelSchema>;

/**
 * A grouped program search result — programs with the same title on the same day
 * and temporal status are merged, with channels collected into an array.
 */
export const GroupedProgramSearchResultSchema = z
    .object({
        title: z.string().describe('Program title'),
        description: z.string().optional().describe('Program description'),
        temporalStatus: TemporalStatusSchema.describe('Computed temporal status'),
        startTime: z.string().describe('Earliest start time in group (ISO 8601)'),
        endTime: z.string().describe('Latest end time in group (ISO 8601)'),
        channels: z.array(GroupedProgramChannelSchema).describe('Channels airing this program'),
    })
    .meta({
        id: 'GroupedProgramSearchResult',
        description: 'Grouped program search result',
    });

export type GroupedProgramSearchResult = z.infer<typeof GroupedProgramSearchResultSchema>;

/**
 * Canonical `{ items, page }` collection envelope used by all /api/v1 paginated
 * endpoints. Mirrors the server's `PageBlock` (problem.ts): offset- or
 * cursor-based, with `hasMore` and an optional `total`.
 */
export const LiveTvPageBlockSchema = z
    .object({
        limit: z.number().int().describe('Page size used for this response'),
        offset: z.number().int().optional().describe('Offset-based paging cursor'),
        nextCursor: z.string().optional().describe('Opaque cursor for cursor-based paging'),
        hasMore: z.boolean().describe('True when more items exist after this page'),
        total: z.number().int().optional().describe('Total matching items (when cheap to compute)'),
    })
    .meta({ id: 'LiveTvPageBlock', description: 'Collection page metadata' });

export type LiveTvPageBlock = z.infer<typeof LiveTvPageBlockSchema>;

// ============================================================================
// Generic admin mutation acknowledgements (bare-object /api/v1 contract)
//
// The redesigned admin Live TV endpoints return a bare object whose single
// boolean field names the action that happened (no `{ success: true }`
// envelope, no `timestamp`). Each kind gets its own schema so the client
// validates the exact field the corresponding endpoint emits.
// ============================================================================

/** PUT channel / channel EPG → `{ updated: true }`. */
export const ChannelUpdatedResponseSchema = z
    .object({ updated: z.literal(true) })
    .meta({ id: 'ChannelUpdatedResponse', description: 'Channel update acknowledgement' });
export type ChannelUpdatedResponse = z.infer<typeof ChannelUpdatedResponseSchema>;

/** PUT channels/reorder → `{ reordered: true }`. */
export const ChannelsReorderedResponseSchema = z
    .object({ reordered: z.literal(true) })
    .meta({ id: 'ChannelsReorderedResponse', description: 'Channel reorder acknowledgement' });
export type ChannelsReorderedResponse = z.infer<typeof ChannelsReorderedResponseSchema>;

/** PUT channels/bulk → `{ updatedCount }` (no `success`). */
export const BulkChannelUpdateResponseSchema = z
    .object({ updatedCount: z.number().int().nonnegative() })
    .meta({ id: 'BulkChannelUpdateResponse', description: 'Bulk channel update result' });
export type BulkChannelUpdateResponse = z.infer<typeof BulkChannelUpdateResponseSchema>;

/** DELETE sources/{id} → `{ deleted: true }`. */
export const SourceDeletedResponseSchema = z
    .object({ deleted: z.literal(true) })
    .meta({ id: 'SourceDeletedResponse', description: 'Source deletion acknowledgement' });
export type SourceDeletedResponse = z.infer<typeof SourceDeletedResponseSchema>;

/** POST proxy/cancel → `{ cancelled: true }`. */
export const ProxyCancelledResponseSchema = z.object({ cancelled: z.literal(true) }).meta({
    id: 'ProxyCancelledResponse',
    description: 'Proxy connection cancelled acknowledgement',
});
export type ProxyCancelledResponse = z.infer<typeof ProxyCancelledResponseSchema>;

/** POST proxy/reconnect → `{ reconnected: true }`. */
export const ProxyReconnectedResponseSchema = z
    .object({ reconnected: z.literal(true) })
    .meta({ id: 'ProxyReconnectedResponse', description: 'Proxy reconnect acknowledgement' });
export type ProxyReconnectedResponse = z.infer<typeof ProxyReconnectedResponseSchema>;

/**
 * Bare `{ ok: true }` acknowledgement used by the backup-group mutations
 * (create / add / remove / split) and category delete — matches what those
 * handlers actually send. Distinct from the shared common
 * `SuccessTrueResponseSchema` so the Live TV client never re-couples to it.
 */
export const LiveTvAckResponseSchema = z
    .object({ ok: z.literal(true) })
    .meta({ id: 'LiveTvAckResponse', description: 'Generic Live TV admin acknowledgement' });
export type LiveTvAckResponse = z.infer<typeof LiveTvAckResponseSchema>;

/**
 * Category PUT (rename and/or toggle visibility) → `{ success: true, updatedCount }`.
 * `updatedCount` is the number of channels whose visibility changed (0 on rename-only).
 */
export const CategoryUpdateResponseSchema = z
    .object({
        success: z.literal(true),
        updatedCount: z.number().int().nonnegative(),
    })
    .meta({ id: 'CategoryUpdateResponse', description: 'Category update result' });
export type CategoryUpdateResponse = z.infer<typeof CategoryUpdateResponseSchema>;

// ============================================================================
// LiveTV Program (defined first — referenced by LiveTvChannel)
// ============================================================================

/**
 * EPG program entry for a TV channel
 */
export const LiveTvFeedProgramSchema = z
    .object({
        id: z.string().describe('Program UUID'),
        channelId: z.string().describe('Channel UUID'),
        title: z.string().describe('Program title'),
        description: z.string().optional().describe('Program description'),
        startTime: z.string().describe('Program start time (ISO 8601)'),
        endTime: z.string().describe('Program end time (ISO 8601)'),
        epgId: z
            .string()
            .optional()
            .describe(
                'XMLTV channel id this listing was imported from — feed provenance, not a per-program id',
            ),
        genres: z.array(z.string()).optional().describe('Program genres'),
        officialRating: z.string().optional().describe('Content rating (e.g. TV-14, PG-13)'),
        sourceId: z.string().optional().describe('Live TV source UUID that produced this listing'),
    })
    .meta({ id: 'LiveTvFeedProgram', description: 'Internal feed EPG entry' });

export type LiveTvFeedProgram = z.infer<typeof LiveTvFeedProgramSchema>;
export const LiveTvProgramSchema = LiveTvFeedProgramSchema.omit({ channelId: true })
    .extend({
        stationId: z.string().describe('Stable station UUID'),
    })
    .meta({ id: 'LiveTvProgram', description: 'Station EPG program entry' });
export type LiveTvProgram = z.infer<typeof LiveTvProgramSchema>;

export const LiveTvAiringSchema = LiveTvFeedProgramSchema.omit({
    channelId: true,
    epgId: true,
    sourceId: true,
})
    .extend({
        stationId: z.string().describe('Stable station UUID'),
        startTime: z.iso.datetime().describe('UTC start, inclusive'),
        endTime: z.iso.datetime().describe('UTC end, exclusive'),
    })
    .meta({ id: 'LiveTvAiring', description: 'One station airing' });
export type LiveTvAiring = z.infer<typeof LiveTvAiringSchema>;

/**
 * One EPG search result: the shared airing plus its temporal status and a station summary.
 * Keyed by `stationId` only (no feed id). A show appears once per station, and the
 * client groups airings of the same show across stations when it wants to.
 */
export const ProgramSearchItemSchema = LiveTvAiringSchema.extend({
    temporalStatus: TemporalStatusSchema.describe('Computed temporal status'),
    station: GroupedProgramChannelSchema.describe('Station that airs this program'),
}).meta({ id: 'ProgramSearchItem', description: 'EPG search result: one airing' });

export type ProgramSearchItem = z.infer<typeof ProgramSearchItemSchema>;

/** A search hit before the station summary is attached. */
export type ProgramSearchAiring = Omit<ProgramSearchItem, 'station'>;

/** Program search API response: `{ items, page }` with offset paging, one item per airing. */
export const ProgramSearchResponseSchema = z
    .object({
        items: z.array(ProgramSearchItemSchema).describe('Matching airings'),
        page: LiveTvPageBlockSchema.describe('Collection page metadata'),
    })
    .meta({
        id: 'ProgramSearchResponse',
        description: 'Program search response (collection envelope)',
    });

export type ProgramSearchResponse = z.infer<typeof ProgramSearchResponseSchema>;

export const LiveTvNowNextSchema = z
    .object({
        current: LiveTvAiringSchema.nullable(),
        next: LiveTvAiringSchema.nullable(),
    })
    .meta({ id: 'LiveTvNowNext' });
export type LiveTvNowNext = z.infer<typeof LiveTvNowNextSchema>;

export const LiveTvWindowSchema = z
    .object({
        from: z.iso.datetime(),
        to: z.iso.datetime(),
        asOf: z.iso.datetime(),
    })
    .meta({ id: 'LiveTvWindow' });

export const StationProgramsResponseSchema = z
    .object({
        stationId: z.string(),
        window: LiveTvWindowSchema,
        airings: z.array(LiveTvAiringSchema),
        nowNext: LiveTvNowNextSchema,
    })
    .meta({ id: 'StationProgramsResponse' });

// ============================================================================
// LiveTV Channel
// ============================================================================

/**
 * Represents a TV channel with optional current program
 */
export const LiveTvChannelSchema = z
    .object({
        id: z.string().describe('Channel UUID from media_items'),
        name: z.string().describe('Channel display name'),
        images: ImageSetSchema,
        category: z.string().optional().describe('Category name'),
        categoryId: z.string().optional().describe('Category UUID'),
        sortOrder: z
            .number()
            .describe(
                "Display sort order WITHIN the channel's category (each category restarts near 0). Not a global lineup position — use channelNumber for that.",
            ),
        channelNumber: z
            .number()
            .int()
            .optional()
            .describe(
                'The channel number viewers dial (1-9999), one per station: all feeds of a backup group share it. Stable: reordering channels or categories, a playlist refresh or a re-import keeps it; new channels get the next free number; an admin can set numbers by hand. Numbers can have gaps. Sort the flat channel list by this for a real TV-lineup order. Absent for a channel past 9999. Present on read endpoints that resolve it (e.g. GET /livetv/channels).',
            ),
        categorySortOrder: z
            .number()
            .int()
            .optional()
            .describe(
                "Display order of this channel's category (lower sorts first). Use this to order the category rail / 'All Channels' grouping — it cannot be derived from per-channel sortOrder because that key restarts per category. Absent when the channel is uncategorized.",
            ),
        isVisible: z.boolean().describe('Whether channel is visible to users'),
        qualityTier: z.enum(['uhd', 'fhd', 'hd', 'sd']).optional().describe('Stream quality tier'),
        currentProgram: LiveTvFeedProgramSchema.optional().describe('Currently airing program'),
        backupGroupId: z.string().optional().describe('Backup group UUID for failover'),
        sourceId: z.string().optional().describe('IPTV source UUID'),
    })
    .meta({ id: 'LiveTvChannel', description: 'TV channel with metadata' });

export type LiveTvChannel = z.infer<typeof LiveTvChannelSchema>;

/** Public station identity; the provider's internal channel DTO stays feed-addressed. */
export const LiveTvStationSchema = LiveTvChannelSchema.omit({
    backupGroupId: true,
    currentProgram: true,
})
    .extend({
        id: z.string().describe('Stable station UUID (backup group, or ungrouped feed UUID)'),
        feedId: z.string().describe('Shown feed UUID; availability and HLS remain feed-addressed'),
        nowNext: LiveTvNowNextSchema,
    })
    .meta({ id: 'LiveTvStation', description: 'Live TV station with its shown feed' });
export type LiveTvStation = z.infer<typeof LiveTvStationSchema>;

/**
 * One station with its now/next programmes (GET /livetv/stations/{stationId}). A
 * player refreshes the playing station's guide with this instead of
 * refetching the whole lineup.
 */
export const LiveTvStationDetailSchema = LiveTvStationSchema.meta({
    id: 'LiveTvStationDetail',
    description: 'Live TV station with now/next',
});

export type LiveTvStationDetail = z.infer<typeof LiveTvStationDetailSchema>;

// ============================================================================
// LiveTV Station Feeds (viewer feed picker)
// ============================================================================

export const LiveTvFeedSchema = z
    .object({
        id: z.string().describe('Channel UUID of this feed — play it like any channel'),
        name: z
            .string()
            .describe(
                'Feed name as the playlist (or an admin rename) has it, with its quality markers, e.g. "Station FHD+"',
            ),
        qualityTier: z.enum(['uhd', 'fhd', 'hd', 'sd']).optional().describe('Stream quality tier'),
        isDegraded: z
            .boolean()
            .describe('A transcoded, mobile, backup or low-quality feed (ranked last)'),
        isPrimary: z.boolean().describe("The backup group's primary feed"),
        isVisible: z
            .boolean()
            .describe('Shown in the lineup; false for a feed the administrator hid'),
        isDefault: z.boolean().describe('The feed viewers get when they open the station'),
    })
    .meta({ id: 'LiveTvFeed', description: 'One feed of a Live TV station' });

export type LiveTvFeed = z.infer<typeof LiveTvFeedSchema>;

export const LiveTvStationFeedsSchema = z
    .object({
        stationId: z.string().describe('Stable station UUID'),
        feeds: z
            .array(LiveTvFeedSchema)
            .describe('Feeds of the station, the default feed first, then by rank'),
    })
    .meta({ id: 'LiveTvStationFeeds', description: 'The feeds of a Live TV station' });

export type LiveTvStationFeeds = z.infer<typeof LiveTvStationFeedsSchema>;

// ============================================================================
// LiveTV Channel Favorites
// ============================================================================

export const LiveTvFavoriteUpdateSchema = z
    .object({
        stationId: z.string().guid().describe('Station UUID to favorite/unfavorite'),
        favorite: z.boolean().describe('true to add the favorite, false to remove it'),
    })
    .meta({ id: 'LiveTvFavoriteUpdate', description: 'Toggle a Live TV channel favorite' });

export type LiveTvFavoriteUpdate = z.infer<typeof LiveTvFavoriteUpdateSchema>;

export const LiveTvFavoritesResponseSchema = z
    .object({
        stationIds: z
            .array(z.string().guid())
            .describe("Favorited station UUIDs, in the user's chosen display order"),
    })
    .meta({ id: 'LiveTvFavorites', description: "The user's favorited Live TV channels" });

export type LiveTvFavoritesResponse = z.infer<typeof LiveTvFavoritesResponseSchema>;

export const LiveTvFavoritesOrderSchema = z
    .object({
        stationIds: z
            .array(z.string().guid())
            .max(500)
            .describe('Favorited station UUIDs in the desired display order'),
    })
    .meta({ id: 'LiveTvFavoritesOrder', description: 'Reorder Live TV favorites' });

export type LiveTvFavoritesOrder = z.infer<typeof LiveTvFavoritesOrderSchema>;

// ============================================================================
// LiveTV Category
// ============================================================================

/**
 * Channel grouping/category
 */
export const LiveTvCategorySchema = z
    .object({
        id: z.string().describe('Category UUID'),
        name: z.string().describe('Category name'),
        sortOrder: z.number().describe('Display sort order'),
        isVisible: z.boolean().describe('Whether category is visible'),
        channelCount: z.number().optional().describe('Number of channels in category'),
    })
    .meta({ id: 'LiveTvCategory', description: 'Channel grouping' });

export type LiveTvCategory = z.infer<typeof LiveTvCategorySchema>;

// ============================================================================
// LiveTV Stream Info
// ============================================================================

/**
 * Stream playback information returned when requesting a channel stream
 */
export const LiveTvStreamInfoSchema = z
    .object({
        streamUrl: z.string().describe('Primary HLS URL (direct or via proxy)'),
        streamUrls: z.array(z.string()).optional().describe('Backup URLs for failover'),
        requiresProxy: z.boolean().describe('Whether stream requires proxy'),
        sourceId: z.string().optional().describe('IPTV source UUID'),
        maxStreams: z.number().optional().describe('Maximum concurrent streams for this source'),
        rungId: z.string().nullable().describe('Applied fixed-ladder rung, or null for source'),
        requestedMaxBitrateBps: z
            .number()
            .nullable()
            .describe('Client-requested total mux ceiling in bits per second'),
        appliedMaxBitrateBps: z
            .number()
            .nullable()
            .describe('Applied total mux ceiling, or null when serving source'),
        appliedMaxHeight: z
            .number()
            .nullable()
            .describe('Applied rung height, or null when serving source'),
        reason: z
            .enum([
                'source_within_cap',
                'hdr_source',
                'unprobeable',
                'capacity',
                'below_ladder',
                'insufficient_ladder',
            ])
            .nullable()
            .describe('Why the applied result differs from an exact rung cap'),
        adaptive: z
            .object({
                rungs: z.array(
                    z.object({
                        id: z.string(),
                        height: z.number(),
                        maxBitrateBps: z.number(),
                        codec: z.literal('h264'),
                    }),
                ),
                includesOriginal: z.boolean(),
            })
            .optional()
            .describe('Applied synchronized ladder when Adaptive was selected'),
        variant: z
            .enum(['fmp4', 'h264'])
            .optional()
            .describe(
                'Compatibility output served instead of the original HEVC stream: fmp4 (same video in fMP4 segments, for Apple native HLS) or h264 (re-encoded for players without HEVC)',
            ),
    })
    .meta({ id: 'LiveTvStreamInfo', description: 'Stream playback info' });

export type LiveTvStreamInfo = z.infer<typeof LiveTvStreamInfoSchema>;

// ============================================================================
// LiveTV Source
// ============================================================================

/**
 * IPTV source configuration (admin-facing)
 */
export const LiveTvSourceSchema = z
    .object({
        id: z.string().describe('Source UUID'),
        name: z.string().describe('Source display name'),
        sourceType: z.enum(['m3u', 'xtream', 'hdhomerun']).describe('Source type'),
        maxStreams: z.number().describe('Maximum concurrent streams'),
        lastRefreshAt: z.string().optional().describe('Last refresh timestamp (ISO 8601)'),
        lastRefreshStatus: z.string().optional().describe('Last refresh status'),
        refreshCron: z.string().optional().describe('Cron expression for auto-refresh schedule'),
    })
    .meta({ id: 'LiveTvSource', description: 'IPTV source configuration' });

export type LiveTvSource = z.infer<typeof LiveTvSourceSchema>;

// ============================================================================
// LiveTV Source Config Value
// ============================================================================

/**
 * Valid values for the LIVETV_SOURCE config key
 */
export const LiveTvSourceConfigSchema = z.enum(['standalone', 'disabled']);

export type LiveTvSourceConfig = z.infer<typeof LiveTvSourceConfigSchema>;

// ============================================================================
// LiveTV Source with Channel Count (API response)
// ============================================================================

/**
 * Source with channel count — used in admin source list responses
 */
export const LiveTvSourceWithCountSchema = LiveTvSourceSchema.extend({
    channelCount: z.number().describe('Number of channels from this source'),
    lastRefreshError: z.string().optional().describe('Redacted error from the last failed import'),
    lastImportWarnings: z
        .array(z.string())
        .optional()
        .describe('Warnings from last import/refresh'),
    playlistMetadataMissing: z
        .boolean()
        .optional()
        .describe(
            'True for an M3U source where no channel came with a tvg-id (a bare playlist, e.g. an Xtream get.php link without type=m3u_plus): usually no groups or logos either, and the guide is matched by name only',
        ),
}).meta({
    id: 'LiveTvSourceWithCount',
    description: 'Source with channel count',
});

export type LiveTvSourceWithCount = z.infer<typeof LiveTvSourceWithCountSchema>;

// ============================================================================
// Admin API Request Schemas
// ============================================================================

/**
 * Create a new LiveTV source (POST body)
 */
export const CreateLiveTvSourceSchema = z
    .object({
        name: z.string().min(1).describe('Source display name'),
        sourceType: z.enum(['m3u', 'xtream', 'hdhomerun']).describe('Source type'),
        m3uUrl: z.string().url().optional().describe('M3U playlist URL'),
        xmltvUrl: z.string().url().optional().describe('XMLTV EPG URL'),
        xtreamServer: z.string().url().optional().describe('Xtream Codes server URL'),
        xtreamUsername: z.string().optional().describe('Xtream Codes username'),
        xtreamPassword: z.string().optional().describe('Xtream Codes password'),
        hdHomeRunDeviceIp: z.string().optional().describe('HDHomeRun device IP address'),
        maxStreams: z.number().int().min(1).optional().describe('Maximum concurrent streams'),
    })
    .refine(
        (data) => {
            if (data.sourceType === 'm3u') return !!data.m3uUrl;
            if (data.sourceType === 'xtream')
                return !!data.xtreamServer && !!data.xtreamUsername && !!data.xtreamPassword;
            if (data.sourceType === 'hdhomerun') return !!data.hdHomeRunDeviceIp;
            return false;
        },
        {
            message:
                'M3U sources require m3uUrl; Xtream sources require xtreamServer, xtreamUsername, and xtreamPassword; HDHomeRun sources require hdHomeRunDeviceIp',
        },
    )
    .meta({
        id: 'CreateLiveTvSource',
        description: 'Create source request body',
    });

export type CreateLiveTvSource = z.infer<typeof CreateLiveTvSourceSchema>;

/**
 * Update a LiveTV source (PUT body — all fields optional)
 */
export const UpdateLiveTvSourceSchema = z
    .object({
        name: z.string().min(1).optional().describe('Source display name'),
        m3uUrl: z.string().url().optional().describe('M3U playlist URL'),
        xmltvUrl: z
            .union([z.literal(''), z.string().url()])
            .optional()
            .describe('XMLTV EPG URL; empty string removes the URL'),
        xtreamServer: z.string().url().optional().describe('Xtream Codes server URL'),
        xtreamUsername: z.string().optional().describe('Xtream Codes username'),
        xtreamPassword: z.string().optional().describe('Xtream Codes password'),
        hdHomeRunDeviceIp: z.string().optional().describe('HDHomeRun device IP address'),
        maxStreams: z.number().int().min(1).optional().describe('Maximum concurrent streams'),
        refreshCron: z
            .string()
            .trim()
            .refine((value) => parseLiveTvRefreshIntervalMs(value) !== null, {
                error: () => m.livetv_admin_refresh_invalid(),
            })
            .nullable()
            .optional()
            .describe('Cron expression for scheduled refresh (null to disable)'),
    })
    .meta({
        id: 'UpdateLiveTvSource',
        description: 'Update source request body',
    });

export type UpdateLiveTvSource = z.infer<typeof UpdateLiveTvSourceSchema>;

// ============================================================================
// Admin API Response Schemas
// ============================================================================

/**
 * Sources list response
 */
export const LiveTvSourcesListResponseSchema = z
    .object({
        sources: z.array(LiveTvSourceWithCountSchema),
    })
    .meta({
        id: 'LiveTvSourcesListResponse',
        description: 'Sources list response',
    });

export type LiveTvSourcesListResponse = z.infer<typeof LiveTvSourcesListResponseSchema>;

/**
 * Single source response
 */
export const LiveTvSourceResponseSchema = z
    .object({
        source: LiveTvSourceSchema,
        importError: z
            .string()
            .optional()
            .describe(
                'Safe retry instruction if the source was saved but its import could not be queued',
            ),
        taskIds: z
            .object({
                m3u: z.string().optional().describe('M3U import job ID'),
                epg: z
                    .string()
                    .optional()
                    .describe(
                        'EPG-only import job ID; M3U imports start their EPG child after channels exist',
                    ),
            })
            .optional()
            .describe('Background import jobs started after creating or editing a source'),
    })
    .meta({
        id: 'LiveTvSourceResponse',
        description: 'Single source response',
    });

export type LiveTvSourceResponse = z.infer<typeof LiveTvSourceResponseSchema>;

/**
 * Import trigger response — bare object per the /api/v1 contract (no `success`).
 */
export const ImportTriggerResponseSchema = z
    .object({
        taskIds: z.object({
            m3u: z.string().describe('M3U import job ID'),
            epg: z
                .string()
                .optional()
                .describe(
                    'Not set any more: the import-m3u run starts the EPG import itself, as its child run, once the channels exist',
                ),
        }),
    })
    .meta({
        id: 'ImportTriggerResponse',
        description: 'Import trigger response',
    });

// ============================================================================
// Guided Setup Schemas
// ============================================================================

export const SetupPreferencesSchema = z
    .object({
        region: z
            .enum(['de', 'at', 'ch', 'generic'])
            .optional()
            .describe(
                'Legacy single-region filter. Ignored when `countries` is sent; `generic` keeps every country',
            ),
        countries: z
            .array(z.string().regex(/^[a-z]{2,16}$/))
            .max(300)
            .optional()
            .describe(
                'Country or region codes to keep (lowercase, as listed in the summary `regions`). Empty or absent keeps every country',
            ),
        includeUntagged: z
            .boolean()
            .optional()
            .describe(
                'Keep channels with no detected country when filtering by country (default true): a provider usually leaves its home-market channels untagged',
            ),
        hideLoopChannels: z
            .boolean()
            .optional()
            .describe(
                'Hide 24/7 loop channels ("24/7 • <show>"), one episode or film on repeat, and a provider\'s film-loop families, default false',
            ),
        hideInfoChannels: z
            .boolean()
            .optional()
            .describe(
                'Hide info and welcome screens ("Event Info", "Welcome Channel"), default false',
            ),
        hideEventSlots: z
            .boolean()
            .optional()
            .describe(
                'Hide event slots: numbered channels without a guide that stay dark until a match ("<Bouquet> Event 12"), default false',
            ),
        hideLocalStations: z
            .boolean()
            .optional()
            .describe(
                'Hide local stations: many stations of one network, each with its own call sign in brackets, default false',
            ),
        hideRadio: z
            .boolean()
            .optional()
            .describe('Hide radio stations (the Radio category), default false'),
        hiddenCategories: z
            .array(z.string().max(200))
            .max(2000)
            .optional()
            .describe(
                'Category names whose channels are hidden, as listed in the summary `categories`',
            ),
        channelOrder: z.enum(['traditional', 'sports-first']).describe('Channel sort order preset'),
        preferHighQuality: z.boolean().describe('Prefer highest quality tier in backup groups'),
    })
    .meta({ id: 'SetupPreferences', description: 'Guided setup preferences' });

export type SetupPreferencesInput = z.infer<typeof SetupPreferencesSchema>;

export const SetupSummarySchema = z
    .object({
        totalChannels: z.number().describe('Total channels from source'),
        visibleChannels: z.number().describe('Currently visible channels'),
        categories: z
            .array(
                z.object({
                    name: z.string(),
                    channelCount: z.number(),
                }),
            )
            .describe('Categories with channel counts'),
        qualityDistribution: z
            .object({
                uhd: z.number(),
                fhd: z.number(),
                hd: z.number(),
                sd: z.number(),
                unknown: z.number(),
            })
            .describe('Quality tier distribution'),
        detectedRegions: z.array(z.string()).describe('Detected country codes'),
        regions: z
            .array(
                z.object({
                    code: z
                        .string()
                        .describe(
                            'Lowercase country code (XMLTV style, `uk` for the United Kingdom) or region: `arab`, `exyu`, `kurd`, `religious`, `adult`',
                        ),
                    channelCount: z.number(),
                }),
            )
            .optional()
            .describe('Detected countries and regions with channel counts, largest first'),
        untaggedChannelCount: z
            .number()
            .optional()
            .describe('Channels with no detected country or region'),
        loopChannelCount: z.number().optional().describe('24/7 loop channels'),
        infoChannelCount: z.number().optional().describe('Info and welcome screens'),
        eventSlotCount: z.number().optional().describe('Event slots that stay dark until a match'),
        localStationCount: z
            .number()
            .optional()
            .describe("A network's local stations, each with its own call sign"),
        radioChannelCount: z.number().optional().describe('Radio stations'),
        savedSetup: z
            .object({
                countries: z.array(z.string()),
                includeUntagged: z.boolean(),
                hideLoopChannels: z.boolean(),
                hideInfoChannels: z
                    .boolean()
                    .optional()
                    .describe('Absent when the stored choices predate this switch'),
                hideEventSlots: z.boolean().optional(),
                hideLocalStations: z.boolean().optional(),
                hideRadio: z.boolean().optional(),
                hiddenCategories: z.array(z.string()),
                channelOrder: z.enum(['traditional', 'sports-first']).optional(),
                preferHighQuality: z.boolean().optional(),
            })
            .optional()
            .describe(
                'The choices the last Configure Lineup run stored; re-imports and refreshes apply them. Absent when never configured',
            ),
        regionalVariantCount: z.number().describe('Number of regional variant channels'),
    })
    .meta({ id: 'SetupSummary', description: 'Setup summary data' });

export type SetupSummary = z.infer<typeof SetupSummarySchema>;

export const SetupResultSchema = z
    .object({
        success: z.boolean(),
        visibleChannels: z.number(),
        hiddenChannels: z.number(),
        categories: z.number(),
        message: z.string(),
    })
    .meta({ id: 'SetupResult', description: 'Setup application result' });

export type SetupResultResponse = z.infer<typeof SetupResultSchema>;

// ============================================================================
// Refresh Schemas (Story 2.9)
// ============================================================================

/**
 * Result of a M3U refresh operation with smart diffing
 */
export const RefreshResultSchema = z
    .object({
        sourceId: z.string().describe('Source UUID'),
        sourceName: z.string().describe('Source display name'),
        matched: z.number().describe('Channels matched to existing'),
        newChannels: z.number().describe('New channels added'),
        removedChannels: z.number().describe('Channels not found in new M3U'),
        urlChanges: z.number().describe('Matched channels with URL changes'),
        archivedChannels: z.number().describe('Channels archived (3+ absences)'),
        flaggedForReview: z.number().describe('Channels flagged for admin review'),
        massRestructure: z.boolean().describe('Whether >50% channels were unmatched'),
        errors: z.array(z.string()).describe('Any errors during refresh'),
        duration: z.number().describe('Refresh duration in milliseconds'),
    })
    .meta({
        id: 'RefreshResult',
        description: 'M3U refresh result with smart diffing stats',
    });

export type RefreshResult = z.infer<typeof RefreshResultSchema>;

/**
 * Refresh cron schedule update
 */
export const RefreshCronSchema = z
    .object({
        refreshCron: z.string().nullable().describe('Cron expression or null to disable'),
    })
    .meta({ id: 'RefreshCron', description: 'Refresh schedule configuration' });

export type RefreshCron = z.infer<typeof RefreshCronSchema>;

/**
 * Refresh trigger response — bare object per the /api/v1 contract (no `success`).
 */
export const RefreshTriggerResponseSchema = z
    .object({
        taskId: z.string().describe('BullMQ job ID'),
    })
    .meta({
        id: 'RefreshTriggerResponse',
        description: 'Refresh trigger response',
    });

// ============================================================================
// Admin Channel Reorder Schemas (Story 4.2)
// ============================================================================

/**
 * Batch reorder request for channels and/or categories
 */
export const ReorderChannelsRequestSchema = z
    .object({
        channels: z
            .array(
                z.object({
                    id: z.string().guid().describe('Channel UUID'),
                    sortOrder: z.number().int().min(0).describe('New sort order position'),
                    categoryId: z
                        .string()
                        .guid()
                        .nullable()
                        .optional()
                        .describe(
                            'Destination category UUID; null = uncategorized; omit = leave category unchanged',
                        ),
                }),
            )
            .max(50_000)
            .optional()
            .describe('Channel sort order updates (optionally moving channels between categories)'),
        categories: z
            .array(
                z.object({
                    id: z.string().guid().describe('Category UUID'),
                    sortOrder: z.number().int().min(0).describe('New sort order position'),
                }),
            )
            .max(5000)
            .optional()
            .describe('Category sort order updates'),
    })
    .refine((data) => (data.channels?.length ?? 0) > 0 || (data.categories?.length ?? 0) > 0, {
        message: 'At least one of channels or categories must be provided',
    })
    .meta({
        id: 'ReorderChannelsRequest',
        description: 'Batch reorder request',
    });

export type ReorderChannelsRequest = z.infer<typeof ReorderChannelsRequestSchema>;

// ============================================================================
// Admin Channel Management Schemas (Story 4.1)
// ============================================================================

/**
 * Admin channel — extends LiveTvChannel with admin-only fields
 */
export const AdminChannelSchema = LiveTvChannelSchema.omit({
    currentProgram: true,
    // Read-side lineup field resolved only by the public channels endpoint —
    // the admin list already orders by category+channel sort_order itself.
    // (channelNumber is redefined below with its admin meaning.)
    channelNumber: true,
    categorySortOrder: true,
})
    .extend({
        epgChannelId: z.string().optional().describe('EPG channel ID for matching status'),
        epgMatchConfidence: z
            .number()
            .optional()
            .describe(
                'Guide match confidence (0-1). Set for a name match too, which a bare playlist (no tvg-id) gets without an EPG channel ID.',
            ),
        epgMatchSignals: z
            .array(z.string())
            .optional()
            .describe(
                'Match signals, e.g. name_exact; backup_propagation = guide shared from a sibling feed',
            ),
        adminDisplayName: z.string().optional().describe('Admin-assigned display name override'),
        groupPrimaryChannelId: z
            .string()
            .optional()
            .describe(
                "UUID of this channel's backup-group primary — the only member viewers receive. Absent when the channel is ungrouped, or when the group has no primary (which withholds every member).",
            ),
        channelNumber: z
            .number()
            .int()
            .optional()
            .describe(
                "The station's channel number (all feeds of a backup group share it). Absent when it has none: a hidden channel whose number was freed, or a channel past 9999.",
            ),
        channelNumberPinned: z
            .boolean()
            .optional()
            .describe(
                'The number was set by an admin: renumbering and freeing hidden numbers leave it alone.',
            ),
        health: LiveTvChannelHealthSchema.optional().describe(
            'Playback health of this feed: consecutive failures and the last typed reason',
        ),
    })
    .meta({
        id: 'AdminChannel',
        description: 'Admin channel with management fields',
    });

export type AdminChannel = z.infer<typeof AdminChannelSchema>;

/**
 * Admin channel category with nested channels
 */
export const AdminChannelCategorySchema = z
    .object({
        id: z.string().describe('Category UUID or "uncategorized"'),
        name: z.string().describe('Category display name'),
        sortOrder: z.number().describe('Category sort order'),
        isVisible: z.boolean().describe('Whether category is visible to users'),
        numberStart: z
            .number()
            .int()
            .optional()
            .describe(
                'First channel number of this category ("Numbers start at"); absent = continues after the category before it',
            ),
        numberOverflow: z
            .number()
            .int()
            .optional()
            .describe(
                "How many of the category's channels did not fit between numberStart and the next category's start (numbered elsewhere)",
            ),
        channels: z.array(AdminChannelSchema).describe('Channels in this category'),
    })
    .meta({
        id: 'AdminChannelCategory',
        description: 'Admin category with channels',
    });

export type AdminChannelCategory = z.infer<typeof AdminChannelCategorySchema>;

/**
 * Admin channels list response
 */
export const AdminChannelsResponseSchema = z
    .object({
        categories: z.array(AdminChannelCategorySchema).describe('Categories with channels'),
        totalChannels: z.number().describe('Total channel count'),
        visibleChannels: z.number().describe('Visible channel count'),
    })
    .meta({
        id: 'AdminChannelsResponse',
        description: 'Admin channels response',
    });

export type AdminChannelsResponse = z.infer<typeof AdminChannelsResponseSchema>;

/**
 * Viewer preview — the lineup as viewers and /j clients actually receive it,
 * after backup-group and visibility filtering, with /j channel numbers.
 */
export const ViewerPreviewChannelSchema = z
    .object({
        id: z.string().describe('Channel UUID'),
        name: z.string().describe('Display name exactly as viewers see it'),
        number: z.number().describe('Channel number a /j client shows'),
        categoryId: z.string().optional().describe('Category UUID'),
        categoryName: z.string().optional().describe('Category display name'),
        qualityTier: z.enum(['uhd', 'fhd', 'hd', 'sd']).optional().describe('Quality tier'),
    })
    .meta({ id: 'ViewerPreviewChannel', description: 'One channel as viewers receive it' });

export const ViewerPreviewResponseSchema = z
    .object({
        channels: z.array(ViewerPreviewChannelSchema).describe('Lineup in viewer order'),
        totalChannels: z.number().describe('Number of channels viewers receive'),
    })
    .meta({
        id: 'ViewerPreviewResponse',
        description: 'The channel lineup as viewers and /j clients receive it',
    });

export type ViewerPreviewChannel = z.infer<typeof ViewerPreviewChannelSchema>;
export type ViewerPreviewResponse = z.infer<typeof ViewerPreviewResponseSchema>;

// ============================================================================
// Admin Channel Update Schemas (Story 4.3)
// ============================================================================

/**
 * Single channel partial update (PUT body)
 * At least one field must be provided.
 */
export const UpdateChannelRequestSchema = z
    .object({
        isVisible: z.boolean().optional().describe('Whether channel is visible to users'),
        qualityTier: z.enum(['uhd', 'fhd', 'hd', 'sd']).optional().describe('Stream quality tier'),
        adminDisplayName: z.string().optional().describe('Admin-assigned display name override'),
        categoryId: z.string().optional().describe('Category UUID'),
    })
    .refine(
        (data) =>
            data.isVisible !== undefined ||
            data.qualityTier !== undefined ||
            data.adminDisplayName !== undefined ||
            data.categoryId !== undefined,
        { message: 'At least one field must be provided' },
    )
    .meta({
        id: 'UpdateChannelRequest',
        description: 'Single channel update request body',
    });

export type UpdateChannelRequest = z.infer<typeof UpdateChannelRequestSchema>;

/**
 * Bulk channel update (PUT body)
 * Action-specific fields validated via refine.
 */
export const BulkUpdateChannelsRequestSchema = z
    .object({
        channelIds: z.array(z.string().guid()).min(1).max(1000).describe('Channel UUIDs to update'),
        action: z
            .enum(['hide', 'show', 'setQuality', 'moveToCategory'])
            .describe('Bulk action to perform'),
        qualityTier: z
            .enum(['uhd', 'fhd', 'hd', 'sd'])
            .optional()
            .describe('Quality tier (required when action=setQuality)'),
        categoryId: z
            .string()
            .guid()
            .optional()
            .describe('Category UUID (required when action=moveToCategory)'),
    })
    .refine(
        (data) => {
            if (data.action === 'setQuality') return !!data.qualityTier;
            if (data.action === 'moveToCategory') return !!data.categoryId;
            return true;
        },
        {
            message: 'setQuality requires qualityTier; moveToCategory requires categoryId',
        },
    )
    .meta({
        id: 'BulkUpdateChannelsRequest',
        description: 'Bulk channel update request body',
    });

export type BulkUpdateChannelsRequest = z.infer<typeof BulkUpdateChannelsRequestSchema>;

// ============================================================================
// Admin Backup Group Schemas (Story 4.5)
// ============================================================================

/**
 * A channel member within a backup group (admin view)
 */
export const BackupGroupMemberSchema = z
    .object({
        id: z.string().describe('Channel UUID'),
        name: z.string().describe('Channel display name'),
        adminDisplayName: z.string().optional().describe('Admin-assigned name override'),
        qualityTier: z.enum(['uhd', 'fhd', 'hd', 'sd']).optional().describe('Stream quality tier'),
        isVisible: z.boolean().describe('Whether channel is visible to users'),
        categoryId: z.string().optional().describe('Category UUID (absent: uncategorized)'),
        categoryName: z.string().optional().describe('Category name'),
        countryCode: z
            .string()
            .optional()
            .describe('Country the playlist assigns the feed (ISO 3166-1 alpha-2)'),
        health: LiveTvChannelHealthSchema.optional().describe(
            'Playback health of this feed: consecutive failures and the last typed reason',
        ),
    })
    .meta({
        id: 'BackupGroupMember',
        description: 'Channel in a backup group',
    });

export type BackupGroupMember = z.infer<typeof BackupGroupMemberSchema>;

/**
 * A backup group with its member channels
 */
export const BackupGroupSchema = z
    .object({
        id: z.string().describe('Backup group UUID'),
        name: z.string().describe('Group name (auto-generated from primary channel)'),
        primaryChannelId: z.string().optional().describe('Primary channel UUID'),
        channels: z.array(BackupGroupMemberSchema).describe('Member channels'),
    })
    .meta({ id: 'BackupGroup', description: 'Backup group with members' });

export type BackupGroupAdmin = z.infer<typeof BackupGroupSchema>;

/**
 * Full backup groups admin response
 */
export const BackupGroupsAdminResponseSchema = z
    .object({
        groups: z.array(BackupGroupSchema).describe('All backup groups'),
        ungroupedChannels: z
            .array(BackupGroupMemberSchema)
            .describe('Channels not in any backup group'),
    })
    .meta({
        id: 'BackupGroupsAdminResponse',
        description: 'Backup groups admin response',
    });

export type BackupGroupsAdminResponse = z.infer<typeof BackupGroupsAdminResponseSchema>;

/**
 * Remove a channel from a backup group
 */
export const RemoveFromGroupRequestSchema = z
    .object({
        channelId: z.string().guid().describe('Channel UUID to remove'),
    })
    .meta({
        id: 'RemoveFromGroupRequest',
        description: 'Remove channel from group',
    });

export type RemoveFromGroupRequest = z.infer<typeof RemoveFromGroupRequestSchema>;

/**
 * Split a backup group — move selected channels to a new group
 */
export const SplitGroupRequestSchema = z
    .object({
        channelIds: z
            .array(z.string().guid())
            .min(1)
            .describe('Channel UUIDs to move to new group'),
    })
    .meta({ id: 'SplitGroupRequest', description: 'Split backup group' });

export type SplitGroupRequest = z.infer<typeof SplitGroupRequestSchema>;

/**
 * Make a channel of a backup group its primary (the feed viewers get)
 */
export const SetGroupPrimaryRequestSchema = z
    .object({
        channelId: z.string().guid().describe('Channel UUID; must be a member of the group'),
    })
    .meta({ id: 'SetGroupPrimaryRequest', description: 'Set the primary feed of a backup group' });

export type SetGroupPrimaryRequest = z.infer<typeof SetGroupPrimaryRequestSchema>;

/**
 * Take whole stations (backup groups) off air or put them back on air
 */
export const SetGroupsOnAirRequestSchema = z
    .object({
        groupIds: z.array(z.string().guid()).min(1).max(10000).describe('Backup group UUIDs'),
        onAir: z
            .boolean()
            .describe(
                'true: show one feed per group (its primary, or its best feed when the primary is degraded or gone) and hide the rest; false: hide every feed',
            ),
    })
    .meta({ id: 'SetGroupsOnAirRequest', description: 'Take stations off air or put them on air' });

export type SetGroupsOnAirRequest = z.infer<typeof SetGroupsOnAirRequestSchema>;

export const SetGroupsOnAirResponseSchema = z
    .object({
        ok: z.literal(true),
        groups: z.number().int().describe('Groups found and updated'),
    })
    .meta({ id: 'SetGroupsOnAirResponse', description: 'Result of taking stations on or off air' });

export type SetGroupsOnAirResponse = z.infer<typeof SetGroupsOnAirResponseSchema>;

/**
 * Create a new backup group from ungrouped channels
 */
export const CreateBackupGroupRequestSchema = z
    .object({
        channelIds: z
            .array(z.string().guid())
            .min(2)
            .describe('Channel UUIDs to group (minimum 2)'),
    })
    .meta({
        id: 'CreateBackupGroupRequest',
        description: 'Create backup group',
    });

export type CreateBackupGroupRequest = z.infer<typeof CreateBackupGroupRequestSchema>;

/**
 * Add an ungrouped channel to an existing backup group
 */
export const AddToGroupRequestSchema = z
    .object({
        channelId: z.string().guid().describe('Channel UUID to add'),
    })
    .meta({ id: 'AddToGroupRequest', description: 'Add channel to group' });

export type AddToGroupRequest = z.infer<typeof AddToGroupRequestSchema>;

// ============================================================================
// EPG Match Review Schemas (Story 4.6)
// ============================================================================

/**
 * Confidence level for EPG matching
 */
export const EpgMatchConfidenceLevelSchema = z.enum([
    'high',
    'medium',
    'low',
    'unmatched',
    'manual',
    'stale',
]);

export type EpgMatchConfidenceLevel = z.infer<typeof EpgMatchConfidenceLevelSchema>;

/**
 * Current program preview (title + time range)
 */
export const CurrentProgramPreviewSchema = z
    .object({
        title: z.string().describe('Program title'),
        startTime: z.string().describe('Program start time (ISO 8601)'),
        endTime: z.string().describe('Program end time (ISO 8601)'),
    })
    .meta({
        id: 'CurrentProgramPreview',
        description: 'Current program preview',
    });

export type CurrentProgramPreview = z.infer<typeof CurrentProgramPreviewSchema>;

/**
 * Single channel in EPG match review list
 */
export const EpgMatchReviewItemSchema = z
    .object({
        id: z.string().describe('Channel UUID'),
        sourceId: z.string().optional().describe('IPTV source UUID'),
        name: z.string().describe('Channel display name'),
        adminDisplayName: z.string().optional().describe('Admin-assigned name override'),
        images: ImageSetSchema,
        epgChannelId: z.string().optional().describe('Matched XMLTV channel ID'),
        epgDisplayName: z.string().optional().describe('Matched XMLTV channel display name'),
        confidenceLevel: EpgMatchConfidenceLevelSchema.describe('Confidence level'),
        confidenceScore: z.number().optional().describe('Numeric confidence score (0-1)'),
        matchSignals: z.array(z.string()).optional().describe('Match signal names'),
        isManualOverride: z.boolean().describe('Whether admin manually set this match'),
        categoryName: z.string().optional().describe('Category name'),
        currentProgram: CurrentProgramPreviewSchema.optional().describe('Currently airing program'),
    })
    .meta({ id: 'EpgMatchReviewItem', description: 'EPG match review item' });

export type EpgMatchReviewItem = z.infer<typeof EpgMatchReviewItemSchema>;

/**
 * EPG match review response with stats
 */
export const EpgMatchReviewResponseSchema = z
    .object({
        channels: z.array(EpgMatchReviewItemSchema).describe('Channels with EPG match data'),
        stats: z
            .object({
                total: z.number().int().describe('Total channels'),
                matched: z.number().describe('Matched channels'),
                unmatched: z.number().describe('Unmatched channels'),
                lowConfidence: z.number().describe('Low confidence matches'),
                manualOverrides: z.number().describe('Manual override count'),
            })
            .describe('Match statistics'),
    })
    .meta({
        id: 'EpgMatchReviewResponse',
        description: 'EPG match review response',
    });

export type EpgMatchReviewResponse = z.infer<typeof EpgMatchReviewResponseSchema>;

/**
 * EPG channel search result
 */
export const EpgChannelSearchResultSchema = z
    .object({
        id: z.string().describe('XMLTV channel ID'),
        displayName: z.string().describe('XMLTV channel display name'),
        iconUrl: z.string().optional().describe('XMLTV channel icon URL'),
    })
    .meta({
        id: 'EpgChannelSearchResult',
        description: 'EPG channel search result',
    });

export type EpgChannelSearchResult = z.infer<typeof EpgChannelSearchResultSchema>;

/**
 * EPG channel search response
 */
export const EpgChannelSearchResponseSchema = z
    .object({
        results: z.array(EpgChannelSearchResultSchema).describe('Search results'),
    })
    .meta({
        id: 'EpgChannelSearchResponse',
        description: 'EPG channel search response',
    });

export type EpgChannelSearchResponse = z.infer<typeof EpgChannelSearchResponseSchema>;

/**
 * Update EPG match request body (null = unmatch)
 */
export const UpdateEpgMatchRequestSchema = z
    .object({
        epgChannelId: z
            .string()
            .nullable()
            .describe('XMLTV channel ID to match, or null to unmatch'),
    })
    .meta({
        id: 'UpdateEpgMatchRequest',
        description: 'Update EPG match request',
    });

export type UpdateEpgMatchRequest = z.infer<typeof UpdateEpgMatchRequestSchema>;

/**
 * EPG match review filter options
 */
export const EpgMatchReviewFilterSchema = z.enum(['all', 'mismatches', 'unmatched']);

export type EpgMatchReviewFilter = z.infer<typeof EpgMatchReviewFilterSchema>;

// ============================================================================
// Category Management Schemas (Story 4.7)
// ============================================================================

/**
 * Rename category request body
 */
export const RenameCategoryRequestSchema = z
    .object({
        name: z.string().min(1).max(200).describe('New category name'),
    })
    .meta({
        id: 'RenameCategoryRequest',
        description: 'Rename category request',
    });

export type RenameCategoryRequest = z.infer<typeof RenameCategoryRequestSchema>;

/**
 * Create category request body
 */
export const CreateCategoryRequestSchema = z
    .object({
        name: z.string().min(1).max(200).describe('Category name'),
    })
    .meta({
        id: 'CreateCategoryRequest',
        description: 'Create category request',
    });

export type CreateCategoryRequest = z.infer<typeof CreateCategoryRequestSchema>;

/**
 * Create category response
 */
export const CreateCategoryResponseSchema = z
    .object({
        id: z.string().describe('New category UUID'),
        name: z.string().describe('Category name'),
        sortOrder: z.number().describe('Category sort order'),
    })
    .meta({
        id: 'CreateCategoryResponse',
        description: 'Create category response',
    });

export type CreateCategoryResponse = z.infer<typeof CreateCategoryResponseSchema>;

/**
 * Merge category request body
 */
export const MergeCategoryRequestSchema = z
    .object({
        targetCategoryId: z.string().guid().describe('Target category UUID to merge into'),
    })
    .meta({
        id: 'MergeCategoryRequest',
        description: 'Merge category request',
    });

export type MergeCategoryRequest = z.infer<typeof MergeCategoryRequestSchema>;

/**
 * Merge category response → `{ success: true, movedChannelCount }`.
 */
export const MergeCategoryResponseSchema = z
    .object({
        success: z.literal(true),
        movedChannelCount: z.number().describe('Number of channels moved'),
    })
    .meta({
        id: 'MergeCategoryResponse',
        description: 'Merge category response',
    });

export type MergeCategoryResponse = z.infer<typeof MergeCategoryResponseSchema>;

/**
 * Category channel count response
 */
export const CategoryChannelCountResponseSchema = z
    .object({
        count: z.number().int().describe('Number of channels in category'),
    })
    .meta({
        id: 'CategoryChannelCountResponse',
        description: 'Category channel count response',
    });

export type CategoryChannelCountResponse = z.infer<typeof CategoryChannelCountResponseSchema>;

// ============================================================================
// Stream Limit Error Response (Story 5.1)
// ============================================================================

/**
 * Active channel in a stream limit error response
 */
export const StreamLimitActiveChannelSchema = z
    .object({
        channelId: z.string().describe('Channel UUID'),
        channelName: z.string().describe('Channel display name'),
        viewers: z.number().describe('Number of current viewers'),
    })
    .meta({
        id: 'StreamLimitActiveChannel',
        description: 'Active channel in stream limit response',
    });

export type StreamLimitActiveChannel = z.infer<typeof StreamLimitActiveChannelSchema>;

/**
 * Structured 503 error response when stream limit is reached
 */
export const StreamLimitErrorResponseSchema = z
    .object({
        error: z.literal('stream_limit_reached'),
        limit: z.number().int().describe('Maximum concurrent streams allowed'),
        active: z.array(StreamLimitActiveChannelSchema).describe('Currently active channels'),
        showActiveStreams: z.boolean().describe('Whether to show active streams to users'),
    })
    .meta({
        id: 'StreamLimitErrorResponse',
        description: 'Stream limit 503 error response',
    });

export type StreamLimitErrorResponse = z.infer<typeof StreamLimitErrorResponseSchema>;

export const ViewerKickedResponseSchema = z.object({
    error: z.literal('viewer_kicked'),
    reason: z.string(),
});
export type ViewerKickedResponse = z.infer<typeof ViewerKickedResponseSchema>;

// ============================================================================
// Stream Failure Error Response (Story 5.2)
// ============================================================================

/**
 * Legacy flat shape of a stream failure (the Jellyfin-compat routes and older web clients).
 * The app API answers a failed start with LiveTvFailureProblemSchema (livetv-failures.ts).
 */
export const StreamFailureErrorSchema = z
    .object({
        error: z
            .enum([
                'spawn_failed',
                'source_unreachable',
                'channel_not_found',
                'no_segments',
                'proxy_unreachable',
                'internal_error',
            ])
            .describe('Stream failure error code'),
        message: z.string().optional().describe('Optional error detail'),
    })
    .meta({
        id: 'StreamFailureError',
        description: 'Stream failure 502 error response',
    });

export type StreamFailureError = z.infer<typeof StreamFailureErrorSchema>;

// ============================================================================
// Playback API Response Schemas
// ============================================================================

// No LiveTvHeartbeatResponseSchema: POST /livetv/channels/{id}/keepalive answers
// 204 No Content (and 410 Gone with a problem body when the viewer was kicked). Same
// trap as leave below — a declared `{ success: boolean }` body made every heartbeat log
// a 204-schema-mismatch. Callers use NoContentSchema from schemas/common.

/**
 * Leave response from proxy forwarding
 */
// No LiveTvLeaveResponseSchema: DELETE/POST /livetv/channels/{id}/leave answers
// 204 No Content. Declaring a `{ success: boolean }` body made every leave log a
// 204-schema-mismatch, because the API client validates `null` against the declared
// schema on a bodyless response. Callers use NoContentSchema from schemas/common.

// ============================================================================
// Proxy Dashboard Schemas (Story 5.4)
// ============================================================================

/**
 * Per-source connection limit info
 */
export const ProxySourceLimitSchema = z
    .object({
        sourceId: z.string().describe('IPTV source UUID'),
        activeStreams: z.number().describe('Currently active streams'),
        maxStreams: z.number().describe('Maximum concurrent streams'),
    })
    .meta({
        id: 'ProxySourceLimit',
        description: 'Per-source connection limit',
    });

export type ProxySourceLimit = z.infer<typeof ProxySourceLimitSchema>;

/**
 * One FFmpeg process serving a channel.
 *
 * A channel maps to several processes once the quality ladder is in use: ingest, plus
 * a per-rung encoder for every distinct fixed quality, plus at most one synchronized
 * adaptive group (one process writing N outputs).
 */
export const ProxyEncoderInfoSchema = z
    .object({
        kind: z.enum(['ingest', 'rung', 'adaptive']).describe('Which pipeline stage'),
        rungId: z.string().optional().describe('Ladder rung, for kind=rung'),
        outputs: z.array(z.string()).describe('Outputs this one process writes'),
        channelId: z.string().optional().describe('Channel this process serves'),
        viewers: z.number().describe('Viewers attached to this encoder'),
        health: z
            .enum(['starting', 'healthy', 'degraded', 'failed'])
            .describe('Encoder health, one vocabulary across ingest and egress'),
        reservedOutputs: z.number().describe('Slots held against the encoder budget'),
        stopping: z
            .boolean()
            .optional()
            .describe('Terminating but still holding its slot until the process exits'),
        startedAt: z.string().optional().describe('ISO start time'),
    })
    .meta({ id: 'ProxyEncoderInfo', description: 'One FFmpeg process serving a channel' });

export type ProxyEncoderInfo = z.infer<typeof ProxyEncoderInfoSchema>;

/**
 * Compile-time parity between this schema and the hand-written wire interface.
 *
 * `src/shared/livetv-proxy-types.ts` must stay dependency-free (the stream proxy
 * imports it and may not pull in Zod), so the same payload is necessarily declared
 * twice. Nothing else catches drift: client.ts documents that Zod's `.strict()` is
 * TOP-LEVEL ONLY, and `encoders` sits two levels down inside `channels[]`, so a field
 * added here but not there — or there but not here — is silently stripped before the
 * admin UI ever sees it, with no runtime warning.
 *
 * Mutual assignability fails the build on an added, removed, renamed, or
 * optionality-changed field in either direction.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const _encoderInfoParity: MutuallyAssignable<ProxyEncoderInfo, WireProxyEncoderInfo> = true;
void _encoderInfoParity;

/**
 * Per-channel info from the proxy
 */
export const ProxyChannelInfoSchema = z
    .object({
        channelId: z.string().describe('Channel UUID'),
        channelName: z.string().describe('Channel display name'),
        viewers: z.number().describe('Number of current viewers'),
        sourceId: z.string().describe('IPTV source UUID'),
        ffmpegHealthy: z.boolean().describe('Whether FFmpeg is healthy'),
        ffmpegHealth: z
            .enum(['healthy', 'degraded', 'error'])
            .optional()
            .describe('Detailed FFmpeg health status'),
        startedAt: z.string().describe('Stream start timestamp (ISO 8601)'),
        activeStreamUrl: z.string().optional().describe('Current upstream URL'),
        streamUrlIndex: z.number().optional().describe('Index of active URL in failover list'),
        failoverExhausted: z.boolean().optional().describe('Whether all failover URLs exhausted'),
        failoverCount: z.number().optional().describe('Number of failover attempts'),
        lastFailureReason: LiveTvFailureCodeSchema.optional().describe(
            'Typed reason of the last failed attempt',
        ),
        terminal: z
            .boolean()
            .optional()
            .describe('All feeds failed; HLS returns channel_failed until a new join'),
        containerFormat: z.enum(['fmp4', 'mpegts']).optional().describe('Container format'),
        segmentCount: z.number().optional().describe('Number of segments in ring buffer'),
        lastSegmentAt: z
            .string()
            .optional()
            .describe('When the latest complete ingest segment arrived'),
        outputDiagnostics: z
            .object({
                bufferedSeconds: z
                    .number()
                    .nonnegative()
                    .describe('Sum of retained ingest segment durations, not client buffer'),
                timestampSamples: z
                    .number()
                    .int()
                    .nonnegative()
                    .describe('Observed video PES timestamps'),
                gapCount: z
                    .number()
                    .int()
                    .nonnegative()
                    .describe('Forward video timestamp jumps over one second'),
                resetCount: z
                    .number()
                    .int()
                    .nonnegative()
                    .describe('Backward timestamp jumps or signalled discontinuities'),
                largestGapSeconds: z
                    .number()
                    .nonnegative()
                    .describe('Largest observed forward timestamp jump'),
                lastGapAt: z
                    .string()
                    .optional()
                    .describe('When the latest forward timestamp jump was observed'),
            })
            .optional()
            .describe(
                'Passive ingest output observations, reset on FFmpeg restart; absent on older proxies',
            ),
        memoryBytes: z
            .number()
            .optional()
            .describe('Total memory used by ring buffer segments (bytes)'),
        initSegmentReady: z
            .boolean()
            .optional()
            .describe('Whether the fMP4 init segment has been received'),
        ffmpegError: z
            .string()
            .optional()
            .describe('Last FFmpeg stderr output (truncated) when health is error/degraded'),
        // The proxy status handler passes the proxy response through verbatim, so
        // the source-analysis probe and the transcode decision reach the wire —
        // declare them (see src/shared/livetv-proxy-types.ts).
        probeResult: z
            .object({
                videoCodec: z.string().nullable(),
                audioCodec: z.string().nullable(),
                interlaced: z.boolean(),
                hdr: z.boolean(),
                bitDepth: z.number(),
                width: z.number(),
                height: z.number(),
            })
            .optional()
            .describe('Probe result from source analysis'),
        transcodeDecision: z
            .object({
                videoAction: z.enum(['copy', 'transcode']),
                audioAction: z.enum(['copy', 'transcode']),
                videoEncoder: z.string().nullable(),
                deinterlace: z.boolean(),
                deinterlaceFilterName: z
                    .string()
                    .nullable()
                    .optional()
                    .describe(
                        'Selected deinterlace filter; null when unused, absent on older proxies',
                    ),
                sourceCodec: z
                    .string()
                    .nullable()
                    .optional()
                    .describe('Probed source video codec; null when no video was found'),
                sourceHdr: z
                    .boolean()
                    .optional()
                    .describe('Whether the probed source video is HDR'),
                sourceInterlaced: z
                    .boolean()
                    .optional()
                    .describe('Whether the probed source video is interlaced'),
                reason: z.string(),
            })
            .optional()
            .describe('Transcode decision made for this channel'),
        encoders: z
            .array(ProxyEncoderInfoSchema)
            .optional()
            .describe('Every FFmpeg process serving this channel (ingest + rung/adaptive)'),
    })
    .meta({ id: 'ProxyChannelInfo', description: 'Per-channel proxy info' });

export type ProxyChannelInfo = z.infer<typeof ProxyChannelInfoSchema>;

// Structural assignability alone misses newly added optional fields. Check keys
// as well so wire additions cannot silently disappear in Zod's nested strip mode.
type SameKeys<A, B> = [Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>] extends [never]
    ? true
    : false;
const _channelInfoParity: SameKeys<ProxyChannelInfo, WireProxyChannelInfo> &
    MutuallyAssignable<ProxyChannelInfo, WireProxyChannelInfo> = true;
const _decisionKeysParity: SameKeys<
    NonNullable<ProxyChannelInfo['transcodeDecision']>,
    NonNullable<WireProxyChannelInfo['transcodeDecision']>
> = true;
void _channelInfoParity;
void _decisionKeysParity;

/**
 * Full proxy status response
 */
export const ProxyStatusResponseSchema = z
    .object({
        healthy: z.boolean().describe('Whether proxy is healthy'),
        uptime: z.number().describe('Proxy uptime in seconds'),
        activeChannels: z.number().describe('Number of active channels'),
        totalViewers: z.number().describe('Total viewer count'),
        ffmpegAvailable: z.boolean().describe('Whether FFmpeg is available'),
        channels: z.array(ProxyChannelInfoSchema).describe('Per-channel info'),
        perSourceLimits: z.array(ProxySourceLimitSchema).describe('Per-source connection limits'),
        egressCapacity: z
            .object({ used: z.number(), limit: z.number() })
            .optional()
            .describe('Encoder-output budget shared by fixed rungs and adaptive groups'),
        orphanedEncoders: z
            .array(ProxyEncoderInfoSchema)
            .optional()
            .describe('Encoders whose channel is no longer registered with FfmpegManager'),
    })
    .meta({ id: 'ProxyStatusResponse', description: 'Full proxy status' });

export type ProxyStatusResponse = z.infer<typeof ProxyStatusResponseSchema>;

/**
 * Kill request body
 */
export const ProxyKillRequestSchema = z
    .object({
        channelId: z.string().describe('Channel UUID to kill'),
        viewerId: z
            .string()
            .optional()
            .describe('Specific viewer ID to kick (omit to kill entire upstream)'),
    })
    .meta({
        id: 'ProxyKillRequest',
        description: 'Kill proxy connection request',
    });

export type ProxyKillRequest = z.infer<typeof ProxyKillRequestSchema>;

/**
 * Reconnect request body
 */
export const ProxyReconnectRequestSchema = z
    .object({
        channelId: z.string().describe('Channel UUID to reconnect'),
    })
    .meta({
        id: 'ProxyReconnectRequest',
        description: 'Reconnect proxy request',
    });

export type ProxyReconnectRequest = z.infer<typeof ProxyReconnectRequestSchema>;

// ============================================================================
// Guide Response (bulk EPG)
// ============================================================================

/**
 * Ordered, paginated station airings within an explicit UTC window.
 */
export const GuideResponseSchema = z
    .object({
        window: LiveTvWindowSchema,
        stations: z.array(
            z.object({
                stationId: z.string(),
                airings: z.array(LiveTvAiringSchema),
                nowNext: LiveTvNowNextSchema,
            }),
        ),
        unknownStationIds: z.array(z.string()).optional(),
        page: z.object({
            limit: z.number().int(),
            nextCursor: z.string().nullable(),
            hasMore: z.boolean(),
        }),
    })
    .meta({
        id: 'GuideResponse',
        description: 'Bulk EPG programs for all channels in a time window',
    });

export type GuideResponse = z.infer<typeof GuideResponseSchema>;

/**
 * Channel layout export/import (Story: portable curation across providers).
 * A snapshot of channel curation — ordering, categories, visibility, renames —
 * re-applied to a new provider's channels by fuzzy name matching on import.
 */
export const ChannelLayoutEntrySchema = z.object({
    match: z
        .object({
            baseName: z.string().describe('Normalized base name (quality/feed markers stripped)'),
            epgId: z.string().nullable().optional().describe('EPG/tvg-id, if any'),
            country: z.string().nullable().optional().describe('ISO country code, if any'),
        })
        .describe('Cross-provider match key for this channel'),
    sortOrder: z.number().int().describe('Channel sort order'),
    category: z.string().nullable().optional().describe('Category name (matched by name)'),
    isVisible: z.boolean().describe('Whether the channel is visible to users'),
    displayName: z.string().nullable().optional().describe('Admin display-name override, if any'),
});
export type ChannelLayoutEntry = z.infer<typeof ChannelLayoutEntrySchema>;

export const ChannelLayoutSchema = z
    .object({
        schemaVersion: z.literal(1).describe('Layout file schema version'),
        exportedAt: z.string().describe('ISO 8601 export timestamp'),
        categories: z
            .array(
                z.object({
                    name: z.string(),
                    order: z.number().int(),
                }),
            )
            .describe('Categories with their display order'),
        channels: z.array(ChannelLayoutEntrySchema),
    })
    .meta({
        id: 'ChannelLayout',
        description: 'Portable snapshot of Live TV channel curation',
    });
export type ChannelLayout = z.infer<typeof ChannelLayoutSchema>;

export const LayoutImportResponseSchema = z
    .object({
        matched: z.number().int().nonnegative().describe('Curated channels re-applied to a match'),
        appended: z
            .number()
            .int()
            .nonnegative()
            .describe('New-provider channels with no layout entry, appended after'),
        notFound: z
            .number()
            .int()
            .nonnegative()
            .describe('Layout entries with no matching channel on the current provider'),
    })
    .meta({
        id: 'LayoutImportResponse',
        description: 'Summary of a channel-layout import',
    });
export type LayoutImportResponse = z.infer<typeof LayoutImportResponseSchema>;

// ============================================================================
// /api/v1 colocated-route response schemas (current-program, admin ops)
//
// Authored to match the exact bare-object / collection bodies returned by the
// handlers in defs/livetv/** so the OpenAPI _openapi.ts files can reference a
// single source of truth.
// ============================================================================

/**
 * GET /livetv/stations/{stationId}/current-program — now/next and server time.
 */
export const CurrentProgramResponseSchema = z
    .object({
        nowNext: LiveTvNowNextSchema,
        asOf: z.iso.datetime(),
    })
    .meta({
        id: 'CurrentProgramResponse',
        description: 'Currently airing program for a channel',
    });

export type CurrentProgramResponse = z.infer<typeof CurrentProgramResponseSchema>;

/**
 * GET /livetv/admin/categories/{categoryId} — single admin category (bare).
 * Mirrors `mapCategoryToApi()` — includes timestamps (unlike LiveTvCategory).
 */
export const AdminCategoryResponseSchema = z
    .object({
        id: z.string().describe('Category UUID'),
        name: z.string().describe('Category name'),
        sortOrder: z.number().describe('Display sort order'),
        isVisible: z.boolean().describe('Whether the category is visible'),
        createdAt: z.string().describe('ISO 8601 creation timestamp'),
        updatedAt: z.string().describe('ISO 8601 last-update timestamp'),
    })
    .meta({ id: 'AdminCategoryResponse', description: 'Admin Live TV category (bare object)' });

export type AdminCategoryResponse = z.infer<typeof AdminCategoryResponseSchema>;

/**
 * PUT /livetv/admin/categories/{categoryId} body — rename and/or toggle
 * visibility. At least one field must be present.
 */
export const UpdateCategoryRequestSchema = z
    .object({
        isVisible: z
            .boolean()
            .optional()
            .describe('Whether the category and all its channels are visible'),
        name: z.string().min(1).max(200).optional().describe('New category name'),
        numberStart: z
            .number()
            .int()
            .min(0)
            .max(9999)
            .optional()
            .describe(
                'First channel number of the category ("Numbers start at"); 0 removes it. Existing numbers stay until "Renumber"; new channels use it right away.',
            ),
    })
    .refine(
        (data) =>
            data.isVisible !== undefined ||
            data.name !== undefined ||
            data.numberStart !== undefined,
        { message: 'At least one of isVisible, name or numberStart must be provided' },
    )
    .meta({ id: 'UpdateCategoryRequest', description: 'Update a Live TV category' });

export type UpdateCategoryRequest = z.infer<typeof UpdateCategoryRequestSchema>;

// ============================================================================
// Channel numbers (admin)
// ============================================================================

/** PUT /livetv/admin/channels/{channelId}/number body. */
export const SetChannelNumberRequestSchema = z
    .object({
        number: z
            .number()
            .int()
            .min(1)
            .max(9999)
            .describe('The channel number to give the station'),
        swap: z
            .boolean()
            .optional()
            .describe(
                "When another station has the number: true = that station takes this one's old number; absent/false = 409",
            ),
    })
    .meta({ id: 'SetChannelNumberRequest', description: 'Set (and pin) a channel number' });

export const ChannelNumberResponseSchema = z
    .object({
        number: z.number().int().describe('The channel number the station now has (pinned)'),
    })
    .meta({ id: 'ChannelNumberResponse', description: 'A station channel number' });

export const RenumberChannelsResponseSchema = z
    .object({
        numbered: z.number().int().describe('How many stations have a number afterwards'),
    })
    .meta({ id: 'RenumberChannelsResponse', description: 'Result of renumbering the lineup' });

export type SetChannelNumberRequest = z.infer<typeof SetChannelNumberRequestSchema>;

/**
 * POST /livetv/admin/sources/{sourceId}/reset-order — reset channel display
 * order to the source M3U playlist order. `updated` is the channel count.
 */
export const ResetChannelOrderResponseSchema = z
    .object({
        updated: z
            .number()
            .int()
            .nonnegative()
            .describe('Number of channels whose order was reset'),
    })
    .meta({
        id: 'ResetChannelOrderResponse',
        description: 'Channel-order reset result',
    });

export type ResetChannelOrderResponse = z.infer<typeof ResetChannelOrderResponseSchema>;

/**
 * GET /livetv/admin/sources/{sourceId}/refresh — last refresh result (bare).
 * All fields optional: a source that has never refreshed returns `{}`.
 */
export const SourceRefreshStatusResponseSchema = z
    .object({
        lastRefreshAt: z.string().optional().describe('ISO 8601 timestamp of the last refresh'),
        lastRefreshStatus: z.string().optional().describe('Status string of the last refresh'),
        lastRefreshSummary: z.string().optional().describe('Human-readable refresh summary'),
    })
    .meta({
        id: 'SourceRefreshStatusResponse',
        description: 'Last refresh status for a Live TV source',
    });

export type SourceRefreshStatusResponse = z.infer<typeof SourceRefreshStatusResponseSchema>;

/**
 * POST /livetv/admin/sources/validate-hdhomerun — validate an HDHomeRun device.
 * Discriminated on `valid`: success carries `deviceInfo`, failure a `reason`.
 */
export const ValidateHdHomeRunRequestSchema = z
    .object({
        deviceIp: z.string().min(1).describe('HDHomeRun device IP address'),
    })
    .meta({ id: 'ValidateHdHomeRunRequest', description: 'HDHomeRun validation request' });

export type ValidateHdHomeRunRequest = z.infer<typeof ValidateHdHomeRunRequestSchema>;

export const ValidateHdHomeRunResponseSchema = z
    .union([
        z.object({
            valid: z.literal(true),
            deviceInfo: z.object({
                friendlyName: z.string(),
                modelNumber: z.string(),
                deviceId: z.string(),
                tunerCount: z.number().int().nonnegative(),
            }),
        }),
        z.object({
            valid: z.literal(false),
            reason: z.string().describe('Why validation failed'),
        }),
    ])
    .meta({
        id: 'ValidateHdHomeRunResponse',
        description: 'HDHomeRun device validation result',
    });

export type ValidateHdHomeRunResponse = z.infer<typeof ValidateHdHomeRunResponseSchema>;

/**
 * POST /livetv/admin/sources/validate-xtream — validate Xtream credentials.
 * Discriminated on `valid`: success carries optional `serverInfo`, failure a `reason`.
 */
export const ValidateXtreamRequestSchema = z
    .object({
        serverUrl: z.string().url().describe('Xtream Codes server URL'),
        username: z.string().min(1).describe('Xtream Codes username'),
        password: z.string().min(1).describe('Xtream Codes password'),
    })
    .meta({ id: 'ValidateXtreamRequest', description: 'Xtream validation request' });

export type ValidateXtreamRequest = z.infer<typeof ValidateXtreamRequestSchema>;

export const ValidateXtreamResponseSchema = z
    .union([
        z.object({
            valid: z.literal(true),
            serverInfo: z.record(z.string(), z.unknown()).optional().describe('Xtream server info'),
        }),
        z.object({
            valid: z.literal(false),
            reason: z.string().describe('Why validation failed'),
        }),
    ])
    .meta({
        id: 'ValidateXtreamResponse',
        description: 'Xtream credentials validation result',
    });

export type ValidateXtreamResponse = z.infer<typeof ValidateXtreamResponseSchema>;
