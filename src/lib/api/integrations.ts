// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integrations API domain module
 *
 * Typed functions for MyAnimeList, Jellyfin Quick Connect,
 * Jellyfin sync pull, library status, and social watch activity.
 *
 * All functions use Zod schema validation via apiGet/apiPost/apiDelete.
 */

import { apiGet, apiPost, apiPut, apiDelete } from './client.js';
import {
    MalStatusResponseSchema,
    MalAuthorizeResponseSchema,
    MalUnlinkResponseSchema,
    TraktStatusResponseSchema,
    TraktAuthorizeResponseSchema,
    TraktUnlinkResponseSchema,
    QuickConnectAuthorizeResponseSchema,
    JellyfinSyncPullResponseSchema,
    JellyfinImportWatchlistResponseSchema,
    LibraryStatusResponseSchema,
    SocialWatchActivityResponseSchema,
    SyncActivityResponseSchema,
    SyncDirectionResponseSchema,
    SyncRunSchema,
    SyncStatusSchema,
    type Direction,
} from '$lib/schemas/api-integrations-responses.js';
import { CancelResponseSchema } from '$lib/schemas/run.schema.js';

/** Providers supported by the direction/sync/status watch-sync endpoints. */
export type SyncProvider = 'mal' | 'trakt';

// ============================================================================
// MyAnimeList (MAL)
// ============================================================================

export function getMalStatus() {
    return apiGet('/api/integrations/mal/status', MalStatusResponseSchema);
}

export function initiateMalAuthorize() {
    return apiPost('/api/integrations/mal/authorize', MalAuthorizeResponseSchema);
}

export function unlinkMal() {
    return apiDelete('/api/integrations/mal/link', MalUnlinkResponseSchema);
}

export function getMalActivity() {
    return apiGet('/api/integrations/mal/activity', SyncActivityResponseSchema);
}

// ============================================================================
// Trakt
// ============================================================================

export function getTraktStatus() {
    return apiGet('/api/integrations/trakt/status', TraktStatusResponseSchema);
}

export function initiateTraktAuthorize() {
    return apiPost('/api/integrations/trakt/authorize', TraktAuthorizeResponseSchema);
}

export function unlinkTrakt() {
    return apiDelete('/api/integrations/trakt/link', TraktUnlinkResponseSchema);
}

export function getTraktActivity() {
    return apiGet('/api/integrations/trakt/activity', SyncActivityResponseSchema);
}

// ============================================================================
// Jellyfin Quick Connect
// ============================================================================

export function authorizeQuickConnectCode(code: string) {
    return apiPost(
        '/api/jellyfin-connect/quick-connect/authorize',
        QuickConnectAuthorizeResponseSchema,
        {
            code,
        },
    );
}

// ============================================================================
// Jellyfin Sync Pull
// ============================================================================

/**
 * Trigger an async Jellyfin watch-sync run.
 *
 * Returns { runId, deduped, location } on success (202 = new run, 200 = deduped/already running).
 * The canonical poll URL is `/api/v1/runs/{runId}`.
 */
export function triggerJellyfinSyncPull() {
    return apiPost('/api/jellyfin-sync/pull', JellyfinSyncPullResponseSchema, {});
}

/** POST /api/integrations/jellyfin/import-watchlist — one-time import of Jellyfin Favorites. */
export function importJellyfinWatchlist() {
    return apiPost(
        '/api/integrations/jellyfin/import-watchlist',
        JellyfinImportWatchlistResponseSchema,
    );
}

// ============================================================================
// Watch-Sync Direction / Manual Sync / Status (MAL + Trakt)
// ============================================================================

/** GET /api/integrations/{provider}/direction */
export function getDirection(provider: SyncProvider) {
    return apiGet(`/api/integrations/${provider}/direction`, SyncDirectionResponseSchema);
}

/** PUT /api/integrations/{provider}/direction */
export function setDirection(provider: SyncProvider, direction: Direction) {
    return apiPut(`/api/integrations/${provider}/direction`, SyncDirectionResponseSchema, {
        direction,
    });
}

/**
 * POST /api/integrations/{provider}/sync — start a one-off Import (pull) or
 * Export (push) run. Returns 202 for a new run, 200 with `deduped: true`
 * when an in-flight run for the same (user, provider, direction) was reused.
 */
export function startSync(provider: SyncProvider, direction: 'pull' | 'push') {
    return apiPost(`/api/integrations/${provider}/sync`, SyncRunSchema, { direction });
}

/** POST /api/integrations/{provider}/sync/cancel */
export function cancelSync(provider: SyncProvider, runId: string) {
    return apiPost(`/api/integrations/${provider}/sync/cancel`, CancelResponseSchema, { runId });
}

/** GET /api/integrations/{provider}/sync/status */
export function getSyncStatus(provider: SyncProvider) {
    return apiGet(`/api/integrations/${provider}/sync/status`, SyncStatusSchema);
}

/** GET /api/integrations/jellyfin/activity — mirrors getMalActivity/getTraktActivity. */
export function getJellyfinActivity() {
    return apiGet('/api/integrations/jellyfin/activity', SyncActivityResponseSchema);
}

// ============================================================================
// Library Status
// ============================================================================

export function getLibraryStatus() {
    return apiGet('/api/library-status', LibraryStatusResponseSchema);
}

// ============================================================================
// Social Watch Activity
// ============================================================================

export function getSocialWatchActivity(id: string) {
    return apiGet(
        `/api/social/watch-activity/${encodeURIComponent(id)}`,
        SocialWatchActivityResponseSchema,
    );
}
