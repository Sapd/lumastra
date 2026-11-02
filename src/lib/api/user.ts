// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { RevokeAllDevicesResponseSchema } from '$lib/schemas/devices';
/**
 * User API domain module
 *
 * Typed functions for user profile, devices, tokens, search preferences,
 * playback preferences, widget order, and Quick Connect.
 *
 * All functions use Zod schema validation for type-safe responses.
 */

import { z } from 'zod';
import { apiGet, apiPost, apiPut, apiPatch, apiDelete } from './client.js';
import { SuccessTrueResponseSchema } from '$lib/schemas/common.js';
import { bumpWatchStateVersion } from '$lib/stores/watch-state-version.js';
import type { ApiRequestOptions } from './types.js';
import type { PlaybackPreferencesInput } from '$lib/schemas/user.js';
import {
    UserResponseSchema,
    QuickConnectUserResponseSchema,
    UserSearchPreferenceResponseSchema,
    UserNotificationWebhookSchema,
    UserNotificationForwardingSchema,
    WidgetOrderResponseSchema,
    FeedPreferencesResponseSchema,
    UserTokenListResponseSchema,
    UserTokenCreateResponseSchema,
    UserDeviceListResponseSchema,
    UserDeviceRenameResponseSchema,
    PlaybackPreferencesResponseSchema,
    StreamPrivacyResponseSchema,
    WatchedStatusResponseSchema,
    MarkWatchedResponseSchema,
    UserSettingsResponseSchema,
    OnboardingDismissResponseSchema,
    JellyfinPasswordStatusResponseSchema,
    JellyfinPasswordResponseSchema,
    JellyfinPasswordDeleteResponseSchema,
    JellyfinPasswordRevealResponseSchema,
    JellyfinClientSessionsResponseSchema,
    JellyfinClientSessionDeleteResponseSchema,
    SubsonicTokenStatusResponseSchema,
    SubsonicTokenResponseSchema,
    SubsonicTokenDeleteResponseSchema,
    SubsonicTokenRevealResponseSchema,
} from '$lib/schemas/api-user-responses.js';
import { SetSeriesProgressResponseSchema } from '$lib/schemas/api-series-progress-response.js';
import {
    UserDataResetResponseSchema,
    type RESET_ACTIONS,
} from '$lib/schemas/api-user-data-reset.js';

// =========================================================================
// User Profile
// =========================================================================

export function getUser() {
    return apiGet('/api/user', UserResponseSchema);
}

export function quickConnect(body: { code: string }) {
    return apiPost('/api/user', QuickConnectUserResponseSchema, body);
}

// =========================================================================
// Composite Settings (all preferences in one call)
// =========================================================================

export function getUserSettings() {
    return apiGet('/api/user/settings', UserSettingsResponseSchema);
}

// =========================================================================
// Search Preferences
// =========================================================================

export function getSearchPreference() {
    return apiGet('/api/user/search-preference', UserSearchPreferenceResponseSchema);
}

export function updateSearchPreference(body: { fulltextSearch: boolean }) {
    return apiPost('/api/user/search-preference', UserSearchPreferenceResponseSchema, body);
}

// =========================================================================
// Notification Webhook (per-user outbound endpoint)
// =========================================================================

/**
 * The caller's own endpoint. Self-scoped server-side — there is deliberately no
 * variant of these that takes a user id.
 */
export function getNotificationWebhook() {
    return apiGet('/api/me/notification-webhook', UserNotificationWebhookSchema);
}

/** Set or replace it. The response carries the signing secret exactly once. */
export function setNotificationWebhook(body: { url: string }) {
    return apiPost('/api/me/notification-webhook', UserNotificationWebhookSchema, body);
}

/** Clear it. Also drops any queued-but-undelivered notifications for it. */
export function clearNotificationWebhook() {
    return apiDelete('/api/me/notification-webhook', UserNotificationWebhookSchema);
}

// =========================================================================
// Notification Forwarding (to integrations the admin set up)
// =========================================================================

/** Whether the caller's notifications are forwarded, and to which integrations. */
export function getNotificationForwarding() {
    return apiGet('/api/me/notification-forwarding', UserNotificationForwardingSchema);
}

export function setNotificationForwarding(enabled: boolean) {
    return apiPut('/api/me/notification-forwarding', UserNotificationForwardingSchema, {
        enabled,
    });
}

// =========================================================================
// Widget Order
// =========================================================================

export function getWidgetOrder() {
    return apiGet('/api/user/widget-order', WidgetOrderResponseSchema);
}

export function updateWidgetOrder(body: { widgetOrder?: string[]; hiddenWidgets?: string[] }) {
    return apiPost('/api/user/widget-order', WidgetOrderResponseSchema, body);
}

// =========================================================================
// For You Feed Preferences
// =========================================================================

export function getFeedPreferences() {
    return apiGet('/api/user/feed-preferences', FeedPreferencesResponseSchema);
}

export function updateFeedPreferences(body: {
    feedMode?: 'full' | 'minimal' | 'custom';
    hiddenSectionKinds?: string[];
}) {
    return apiPut('/api/user/feed-preferences', FeedPreferencesResponseSchema, body);
}

// =========================================================================
// Tokens (PATs)
// =========================================================================

export function getTokens() {
    return apiGet('/api/me/pats', UserTokenListResponseSchema);
}

/**
 * Create a user PAT with explicit scopes / expiry.
 *
 * Used by clients that need a non-default scope (e.g. `jellyfin_compat_read`
 * for Discord RPC / Tautulli read-only integrations). The backend rejects
 * incompatible scope combinations — see `patCreateBodySchema.superRefine`.
 *
 * There is deliberately no name-only variant: omitting `scopes` makes the
 * endpoint fall back to `['read']`, which silently produced read-only tokens
 * whose every write failed with `insufficient_scope`. Callers state the scope.
 */
export function createUserToken(body: {
    name: string;
    scopes?: ('read' | 'write' | 'admin' | 'jellyfin_compat' | 'jellyfin_compat_read')[];
    expiresInDays?: number | null;
}) {
    return apiPost('/api/me/pats', UserTokenCreateResponseSchema, body);
}

export function deleteToken(id: string) {
    return apiDelete(`/api/me/pats/${encodeURIComponent(id)}`, z.null());
}

// =========================================================================
// Devices
// =========================================================================

export function getDevices(options?: { onlineOnly?: boolean; watchTogether?: boolean }) {
    const params: Record<string, string | boolean | undefined> = {};
    if (options?.onlineOnly) params.onlineOnly = true;
    if (options?.watchTogether) params.watchTogether = true;
    return apiGet('/api/user/devices', UserDeviceListResponseSchema, {
        params,
    });
}

export function deleteDevice(id: string) {
    return apiDelete(`/api/user/devices/${encodeURIComponent(id)}`, z.null());
}

export function deleteAllDevices() {
    return apiPost('/api/user/devices/revoke-all', RevokeAllDevicesResponseSchema);
}

/**
 * Set (or clear, with null) the user's own name for a device.
 *
 * The override wins over whatever the client reports, so the heartbeat cannot
 * undo it. Passing null falls back to the client-reported name.
 */
export function renameDevice(id: string, deviceName: string | null) {
    return apiPatch(`/api/user/devices/${encodeURIComponent(id)}`, UserDeviceRenameResponseSchema, {
        deviceName,
    });
}

// =========================================================================
// Playback Preferences
// =========================================================================

export function getPlaybackPreferences() {
    return apiGet('/api/me/playback-preferences', PlaybackPreferencesResponseSchema);
}

export function updatePlaybackPreferences(
    body: Partial<PlaybackPreferencesInput>,
    options?: ApiRequestOptions,
) {
    if (options === undefined)
        return apiPatch('/api/me/playback-preferences', PlaybackPreferencesResponseSchema, body);
    return apiPatch(
        '/api/me/playback-preferences',
        PlaybackPreferencesResponseSchema,
        body,
        options,
    );
}

// =========================================================================
// Stream Privacy
// =========================================================================

export function getStreamPrivacy() {
    return apiGet('/api/user/stream-privacy', StreamPrivacyResponseSchema);
}

export function updateStreamPrivacy(body: {
    hideFromOthers?: boolean;
    shareListeningActivity?: boolean;
    shareAudiobookActivity?: boolean;
}) {
    return apiPost('/api/user/stream-privacy', StreamPrivacyResponseSchema, body);
}

// =========================================================================
// Watched Status
// =========================================================================

export function getWatchedStatus(itemId: string) {
    return apiGet(`/api/watched/${encodeURIComponent(itemId)}`, WatchedStatusResponseSchema);
}

export async function markWatched(itemId: string, body?: Record<string, unknown>) {
    const result = await apiPost(
        `/api/watched/${encodeURIComponent(itemId)}`,
        MarkWatchedResponseSchema,
        body,
    );
    if (!result.error) bumpWatchStateVersion();
    return result;
}

export async function unmarkWatched(itemId: string) {
    const result = await apiDelete(
        `/api/watched/${encodeURIComponent(itemId)}`,
        MarkWatchedResponseSchema,
    );
    if (!result.error) bumpWatchStateVersion();
    return result;
}

export async function setSeriesProgress(
    seriesId: string,
    body: { throughEpisodeId: string } | { watchedIds: string[]; unwatchedIds: string[] },
) {
    const result = await apiPost(
        `/api/watched/series/${encodeURIComponent(seriesId)}/set-progress`,
        SetSeriesProgressResponseSchema,
        body,
    );
    if (!result.error) bumpWatchStateVersion();
    return result;
}

// =========================================================================
// Avatar
// =========================================================================

/**
 * Upload a custom avatar for a user.
 * Uses raw fetch with FormData (apiPut sends JSON, doesn't support multipart).
 */
export async function uploadAvatar(
    userId: string,
    file: File,
): Promise<{ success: boolean; error?: string; status?: number }> {
    const formData = new FormData();
    formData.append('avatar', file);

    try {
        const response = await fetch(`/api/image/user/${encodeURIComponent(userId)}/avatar`, {
            method: 'PUT',
            body: formData,
        });
        if (!response.ok) {
            // A reverse proxy's own body limit answers 413 with an HTML page.
            const body = await response.json().catch(() => ({}));
            return {
                success: false,
                status: response.status,
                error: body.error ?? response.statusText,
            };
        }
        return { success: true };
    } catch (err) {
        return {
            success: false,
            error: err instanceof Error ? err.message : 'Upload failed',
        };
    }
}

export function deleteAvatar(userId: string) {
    return apiDelete(
        `/api/image/user/${encodeURIComponent(userId)}/avatar`,
        SuccessTrueResponseSchema,
    );
}

// =========================================================================
// Onboarding
// =========================================================================

export function dismissOnboardingStep(step: string) {
    return apiPost('/api/onboarding/dismiss', OnboardingDismissResponseSchema, {
        step,
    });
}

/** Dismiss the entire onboarding checklist (no specific step → dismiss all). */
export function dismissAllOnboarding() {
    return apiPost('/api/onboarding/dismiss', OnboardingDismissResponseSchema, {});
}

// =========================================================================
// Jellyfin Connect Password
// =========================================================================

export function getJellyfinPasswordStatus() {
    return apiGet('/api/jellyfin-connect/password', JellyfinPasswordStatusResponseSchema);
}

export function generateJellyfinPassword() {
    return apiPost('/api/jellyfin-connect/password', JellyfinPasswordResponseSchema);
}

export function deleteJellyfinPassword() {
    return apiDelete('/api/jellyfin-connect/password', JellyfinPasswordDeleteResponseSchema);
}

/**
 * Read back the existing client password. `password: null` means it cannot be
 * shown (row predates the encrypted display copy) — offer a reset instead.
 */
export function revealJellyfinPassword() {
    return apiGet('/api/jellyfin-connect/password/reveal', JellyfinPasswordRevealResponseSchema);
}

// =========================================================================
// Jellyfin Connect — connected clients (/j compat sessions)
// =========================================================================

export function getJellyfinClientSessions() {
    return apiGet('/api/jellyfin-connect/sessions', JellyfinClientSessionsResponseSchema);
}

export function revokeJellyfinClientSession(id: string) {
    return apiDelete(
        `/api/jellyfin-connect/sessions/${encodeURIComponent(id)}`,
        JellyfinClientSessionDeleteResponseSchema,
    );
}

// =========================================================================
// Subsonic Connect Token
// =========================================================================

export function getSubsonicTokenStatus() {
    return apiGet('/api/subsonic-connect/password', SubsonicTokenStatusResponseSchema);
}

export function generateSubsonicToken() {
    return apiPost('/api/subsonic-connect/password', SubsonicTokenResponseSchema);
}

export function deleteSubsonicToken() {
    return apiDelete('/api/subsonic-connect/password', SubsonicTokenDeleteResponseSchema);
}

/** Read back the existing Subsonic token, already grouped for display. */
export function revealSubsonicToken() {
    return apiGet('/api/subsonic-connect/password/reveal', SubsonicTokenRevealResponseSchema);
}

// =========================================================================
// User Data Reset
// =========================================================================

export function resetUserData(action: (typeof RESET_ACTIONS)[number], confirm?: boolean) {
    return apiPost('/api/user/data/reset', UserDataResetResponseSchema, { action, confirm });
}
