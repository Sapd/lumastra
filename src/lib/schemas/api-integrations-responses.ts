// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integrations API Response Schemas
 *
 * Covers:
 *   - MyAnimeList (MAL) link status, OAuth initiation, unlink
 *   - Jellyfin Quick Connect authorization
 *   - Jellyfin sync/pull task trigger
 *   - Library status (scan progress)
 *   - Social watch activity
 */

import { z } from 'zod';
import { SocialActivityItemSchema as SharedSocialActivityItemSchema } from './api-media-responses';

// ============================================================================
// MyAnimeList (MAL)
// ============================================================================

/** GET /api/integrations/mal/status */
export const MalStatusResponseSchema = z
    .object({
        configured: z.boolean(),
        linked: z.boolean(),
        auth_failed: z
            .boolean()
            .optional()
            .describe('The stored connection needs authorization again'),
        redirectUri: z
            .string()
            .optional()
            .describe('Exact redirect URI for provider app registration'),
        malUsername: z.string().optional(),
        linkedAt: z.unknown().optional(),
    })
    .passthrough()
    .meta({ id: 'MalStatusResponse', description: 'MAL link status for the current user' });

export type MalStatusResponse = z.infer<typeof MalStatusResponseSchema>;

/** POST /api/integrations/mal/authorize */
export const MalAuthorizeResponseSchema = z
    .object({
        authUrl: z.string(),
        state: z.string(),
    })
    .meta({
        id: 'MalAuthorizeResponse',
        description: 'MAL OAuth initiation — redirect to authUrl',
    });

export type MalAuthorizeResponse = z.infer<typeof MalAuthorizeResponseSchema>;

/** DELETE /api/integrations/mal/link — bare empty object */
export const MalUnlinkResponseSchema = z
    .object({})
    .passthrough()
    .meta({ id: 'MalUnlinkResponse', description: 'Bare empty object on MAL unlink success' });

export type MalUnlinkResponse = z.infer<typeof MalUnlinkResponseSchema>;

// ============================================================================
// Trakt
// ============================================================================

/** GET /api/integrations/trakt/status */
export const TraktStatusResponseSchema = z
    .object({
        configured: z.boolean(),
        linked: z.boolean(),
        auth_failed: z
            .boolean()
            .optional()
            .describe('The stored connection needs authorization again'),
        redirectUri: z
            .string()
            .optional()
            .describe('Exact redirect URI for provider app registration'),
        traktUsername: z.string().optional(),
        linkedAt: z.unknown().optional(),
    })
    .passthrough()
    .meta({ id: 'TraktStatusResponse', description: 'Trakt link status for the current user' });

export type TraktStatusResponse = z.infer<typeof TraktStatusResponseSchema>;

/** POST /api/integrations/trakt/authorize */
export const TraktAuthorizeResponseSchema = z
    .object({
        authUrl: z.string(),
        state: z.string(),
    })
    .meta({
        id: 'TraktAuthorizeResponse',
        description: 'Trakt OAuth initiation — redirect to authUrl',
    });

export type TraktAuthorizeResponse = z.infer<typeof TraktAuthorizeResponseSchema>;

/** DELETE /api/integrations/trakt/link — bare empty object */
export const TraktUnlinkResponseSchema = z
    .object({})
    .passthrough()
    .meta({ id: 'TraktUnlinkResponse', description: 'Bare empty object on Trakt unlink success' });

export type TraktUnlinkResponse = z.infer<typeof TraktUnlinkResponseSchema>;

/** One row in a per-connection sync activity feed. */
export const SyncActivityItemSchema = z
    .object({
        direction: z.enum(['push', 'pull']),
        outcome: z.enum(['success', 'failed', 'skipped']),
        terminal: z.boolean(),
        title: z.string().nullable().optional(),
        seriesTitle: z
            .string()
            .nullable()
            .optional()
            .describe('Parent series title (episodes only) — omitted/null for movies'),
        seasonNumber: z
            .number()
            .nullable()
            .optional()
            .describe('Season number (episodes only) — omitted/null for movies'),
        episodeNumber: z
            .number()
            .nullable()
            .optional()
            .describe('Episode number (episodes only) — omitted/null for movies'),
        mediaType: z.string().nullable().optional(),
        eventKind: z.string().nullable().optional(),
        externalRef: z.string().nullable().optional(),
        error: z.string().nullable().optional(),
        occurredAt: z.string(),
    })
    .meta({ id: 'SyncActivityItem', description: 'One pushed/pulled sync item with outcome' });

export type SyncActivityItem = z.infer<typeof SyncActivityItemSchema>;

/** GET /api/integrations/{provider}/activity */
export const SyncActivityResponseSchema = z
    .object({ items: z.array(SyncActivityItemSchema) })
    .passthrough()
    .meta({
        id: 'SyncActivityResponse',
        description: 'Recent watch-sync activity for the current user + provider',
    });

export type SyncActivityResponse = z.infer<typeof SyncActivityResponseSchema>;

// ============================================================================
// Jellyfin Quick Connect
// ============================================================================

/** POST /api/jellyfin-connect/quick-connect/authorize — bare empty object */
export const QuickConnectAuthorizeResponseSchema = z.object({}).passthrough().meta({
    id: 'QuickConnectAuthorizeResponse',
    description: 'Bare empty object on Quick Connect authorization success',
});

export type QuickConnectAuthorizeResponse = z.infer<typeof QuickConnectAuthorizeResponseSchema>;

// ============================================================================
// Jellyfin Sync Pull
// ============================================================================

/** POST /api/jellyfin-sync/pull — async task trigger */
export const JellyfinSyncPullResponseSchema = z
    .object({
        runId: z.string(),
        deduped: z.boolean().optional(),
        location: z.string(),
    })
    .meta({
        id: 'JellyfinSyncPullResponse',
        description: 'Async Jellyfin watch-sync task start response',
    });

export type JellyfinSyncPullResponse = z.infer<typeof JellyfinSyncPullResponseSchema>;

/** POST /api/integrations/jellyfin/import-watchlist */
export const JellyfinImportWatchlistResponseSchema = z
    .object({
        imported: z.number(),
        skipped: z.number(),
        total: z.number(),
    })
    .meta({
        id: 'JellyfinImportWatchlistResponse',
        description: 'Result of a one-time Jellyfin Favorites → watchlist import',
    });

export type JellyfinImportWatchlistResponse = z.infer<typeof JellyfinImportWatchlistResponseSchema>;

// ============================================================================
// Library Status
// ============================================================================

/** GET /api/library-status */
export const LibraryStatusResponseSchema = z
    .object({
        scanning: z.boolean(),
        mediaWithFiles: z.number().int().nonnegative(),
        totalMediaItems: z.number().int().nonnegative(),
    })
    .meta({
        id: 'LibraryStatusResponse',
        description: 'Lightweight library scan progress snapshot',
    });

export type LibraryStatusResponse = z.infer<typeof LibraryStatusResponseSchema>;

// ============================================================================
// Social Watch Activity
// ============================================================================

/**
 * The item shape for `/api/social/watch-activity/[id]`.
 *
 * This used to be a private, hand-maintained COPY of
 * `api-media-responses.SocialActivityItemSchema`, and it had already drifted —
 * `ratingStyle` was missing. That is not cosmetic, and the consequence is WORSE
 * than an error: `apiFetch` parses the body with this schema, so a field the
 * server sends and this copy does not declare is **silently deleted** from the
 * value the client receives. Nothing reports it.
 *
 * Do not expect `toStrict()` to catch it either — measured, not assumed:
 *  - the response schema below is `.passthrough()`, which `toStrict` deliberately
 *    leaves permissive; and
 *  - even on a stripping schema, Zod 4's `.strict()` constrains the TOP-LEVEL
 *    object only, so an extra key inside `activities[]` is stripped regardless.
 *
 * Sharing the one object is therefore the ONLY thing keeping the audiobook
 * listening fields on this surface. Kept as a named local binding purely so the
 * schema below reads unchanged.
 */
const SocialActivityItemSchema = SharedSocialActivityItemSchema;

/** GET /api/social/watch-activity/[id] */
export const SocialWatchActivityResponseSchema = z
    .object({
        activities: z.array(SocialActivityItemSchema),
    })
    .passthrough()
    .meta({
        id: 'SocialWatchActivityResponse',
        description: 'Social watch activity for a media item',
    });

export type SocialWatchActivityResponse = z.infer<typeof SocialWatchActivityResponseSchema>;
export type SocialActivityItem = z.infer<typeof SocialActivityItemSchema>;

// ============================================================================
// Provider Reconnect Response (/api/v1/admin/providers/reconnect)
// ============================================================================

/**
 * Provider reconnect response
 *
 * POST /api/v1/admin/providers/reconnect?service=jellyfin
 * → bare { service, success, state }
 * where `success` reports whether the reconnect attempt succeeded and `state` is
 * the connection state string from connectionStatus.getStatus('jellyfin').state.
 * 422 validation_failed for an unknown/unsupported service or unconfigured Jellyfin.
 */
export const ProviderReconnectResponseSchema = z
    .object({
        /** The service that was reconnected */
        service: z.string().describe('Service identifier (e.g. "jellyfin")'),
        /** Whether the reconnection attempt succeeded */
        success: z.boolean().describe('Whether the reconnection attempt succeeded'),
        /** Current connection state after the attempt */
        state: z.string().describe('Connection state after the reconnection attempt'),
    })
    .meta({
        id: 'ProviderReconnectResponse',
        description: 'Provider reconnect response',
    });

export type ProviderReconnectResponse = z.infer<typeof ProviderReconnectResponseSchema>;

// ============================================================================
// Watch-Sync Direction / Start-Sync / Status
// ============================================================================

/** Watch-sync direction: bidirectional, pull-only, or push-only. */
export const DirectionSchema = z
    .enum(['both', 'pull', 'push'])
    .describe('Watch-sync direction: bidirectional, pull-only, or push-only');

export type Direction = z.infer<typeof DirectionSchema>;

/** GET/PUT /api/integrations/{provider}/direction */
export const SyncDirectionResponseSchema = z
    .object({
        provider: z.string().describe('Provider identifier (e.g. "trakt", "mal")'),
        direction: DirectionSchema,
    })
    .meta({
        id: 'SyncDirectionResponse',
        description: 'Configured watch-sync direction for a provider connection',
    });

export type SyncDirectionResponse = z.infer<typeof SyncDirectionResponseSchema>;

/** POST /api/integrations/{provider}/sync — request body */
export const StartSyncRequestSchema = z
    .object({
        direction: z
            .enum(['pull', 'push'])
            .describe('Which direction to run for this sync invocation'),
    })
    .meta({
        id: 'StartSyncRequest',
        description: 'Request body to start a one-off watch-sync run',
    });

export type StartSyncRequest = z.infer<typeof StartSyncRequestSchema>;

/** POST /api/integrations/{provider}/sync — async task trigger */
export const SyncRunSchema = z
    .object({
        runId: z.string().describe('Identifier of the started (or deduped) sync run'),
        deduped: z
            .boolean()
            .optional()
            .describe('True if an in-flight run was reused instead of starting a new one'),
    })
    .meta({
        id: 'SyncRun',
        description: 'Async watch-sync task start response',
    });

export type SyncRun = z.infer<typeof SyncRunSchema>;

/** GET /api/integrations/{provider}/sync/status */
export const SyncStatusSchema = z
    .object({
        state: z
            .enum(['pending', 'active', 'cancelling', 'completed', 'failed', 'cancelled'])
            .nullable()
            .describe('Current run state, or null when no run has ever started'),
        runId: z
            .string()
            .optional()
            .describe('Identifier of the underlying run, if one exists (absent when idle)'),
        phase: z.string().optional().describe('Human-readable phase label for the active run'),
        total: z.number().optional().describe('Total items expected for this run, if known'),
        processed: z.number().describe('Number of items processed so far'),
        succeeded: z.number().optional().describe('Number of items processed successfully'),
        failed: z.number().optional().describe('Number of items that failed to process'),
        error: z.string().optional().describe('Terminal error message, if the run failed'),
        startedAt: z.string().optional().describe('ISO timestamp the run started'),
        finishedAt: z.string().optional().describe('ISO timestamp the run finished'),
        recentActivity: z
            .array(SyncActivityItemSchema)
            .default([])
            .describe('Most recent pushed/pulled items for this run'),
    })
    .meta({
        id: 'SyncStatus',
        description: 'Current/most-recent watch-sync run status for a provider connection',
    });

export type SyncStatus = z.infer<typeof SyncStatusSchema>;
