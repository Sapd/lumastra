// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { DeviceSchema, DevicesListResponseSchema } from './devices';
import { AdminPersonalAccessTokenSchema, PersonalAccessTokenSchema } from './credentials';

/**
 * User API Response Zod Schemas
 *
 * SINGLE SOURCE OF TRUTH for user API response types.
 * These schemas define the contract for /api/user/* endpoints.
 *
 * Usage:
 * - Server: Validate responses before sending
 * - Client: Runtime type validation
 * - OpenAPI: Auto-generate documentation
 * - TypeScript: Infer types for type safety
 *
 * Convention:
 * - Use .optional() for optional fields (NOT .nullable())
 * - Add .meta({ description: '...' }) for OpenAPI docs
 * - Export both schema and inferred type
 */

import { ImageSetSchema } from './api-image-descriptor.js';
import { z } from 'zod';
import { CallerPermissionsSchema } from './server-info.js';
import { subtitleStyleSchema, subtitleTrackHintSchema, feedModeSchema } from './user';

// ============================================================================
// Admin User (mapUserToApi output) — /api/v1/users[/{id}]
// ============================================================================

/**
 * The full admin-facing user shape produced by
 * `mapUserToApi` (src/lib/server/mappers/user.mapper.ts). SINGLE SOURCE OF
 * TRUTH: the mapper's `ApiUser` type is inferred from this schema, and the
 * /users list + /users/{id} defs document their responses with it.
 *
 * The per-def local `UserSchema` copies (6–7 fields) declared far less than the
 * mapper emits (24 fields), so a strict decoder saw every extra field as an
 * additionalProperties violation and failed the whole response.
 */
export const ApiUserSchema = z
    .object({
        id: z.string(),
        username: z.string(),
        isAdmin: z.boolean(),
        adminPinned: z.boolean(),
        maxAgeRating: z.number().nullable(),
        allowLiveTv: z
            .boolean()
            .optional()
            .describe('Whether the user is allowed to access Live TV'),
        liveTvDefault: z
            .boolean()
            .optional()
            .describe('Whether the user still has the default Live TV setting'),
        ageRatingPinned: z.boolean(),
        displayName: z.string().optional(),
        email: z.string().optional(),
        hideStreams: z.boolean(),
        groups: z.array(z.string()).nullable(),
        groupsUpdatedAt: z.string().optional(),
        createdAt: z.string(),
        lastSeenAt: z.string().optional(),
        disabled: z.boolean(),
        hasNativePassword: z.boolean(),
        hasProfile: z.boolean().optional(),
        totalRatings: z.number().optional(),
        currentRatings: z.number().optional(),
        activeSuggestions: z.number().optional(),
        lastActivity: z.string().optional(),
        identityProviders: z.array(z.string()),
        currentlyStreaming: z.boolean().optional(),
        lastActivityAt: z.string().optional(),
        lastWatchedTitle: z.string().optional(),
        lastActivitySource: z.string().optional(),
        jellyfinLinked: z.boolean().optional(),
        apiTokenCount: z.number().optional(),
    })
    .meta({ id: 'ApiUser', description: 'Admin-facing user account (mapUserToApi output)' });

export type ApiUser = z.infer<typeof ApiUserSchema>;

// ============================================================================
// User Profile Response (/api/user)
// ============================================================================

/**
 * User profile response
 *
 * Server returns `json({ id, name })` directly from /api/user GET.
 */
export const UserResponseSchema = z
    .object({
        images: ImageSetSchema.optional(),
        /** User identifier (username) */
        id: z.string().describe('User identifier'),
        /** Username */
        name: z.string().describe('Username'),
    })
    .meta({ id: 'UserResponse', description: 'User profile response' });

export type UserResponse = z.infer<typeof UserResponseSchema>;

// ============================================================================
// Quick Connect Response (/api/user - POST)
// ============================================================================

/**
 * Quick connect response
 */
export const QuickConnectUserResponseSchema = z
    .object({
        /** Operation success */
        success: z.boolean().describe('Operation success'),
        /** Message */
        message: z.string().optional().describe('Result message'),
        /** Whether authorization is complete */
        authorized: z.boolean().optional().describe('Authorization complete'),
    })
    .meta({
        id: 'QuickConnectUserResponse',
        description: 'Quick connect response',
    });

export type QuickConnectUserResponse = z.infer<typeof QuickConnectUserResponseSchema>;

// ============================================================================
// Search Preference Response (/api/user/search-preference)
// ============================================================================

/**
 * Search preference response
 * Server returns bare { fulltextSearch } via defineEndpoint def.
 */
export const UserSearchPreferenceResponseSchema = z
    .object({
        /** Whether fulltext search is enabled */
        fulltextSearch: z.boolean().describe('Fulltext search enabled'),
    })
    .meta({
        id: 'UserSearchPreferenceResponse',
        description: 'Search preference response',
    });

export type UserSearchPreferenceResponse = z.infer<typeof UserSearchPreferenceResponseSchema>;

// ============================================================================
// Notification Webhook (/api/me/notification-webhook)
// ============================================================================

/**
 * The caller's own outbound notification endpoint.
 *
 * `url` is returned to its OWNER and to nobody else — the endpoint is
 * `{kind:'user'}` self-scoped and the query module has no cross-user read. The
 * signing secret is never returned in any shape: `secret` appears once, in the
 * response to the request that created it, and `hasSecret` is all any later read
 * reports (the same write-only rule the operator hook follows).
 */
export const UserNotificationWebhookSchema = z
    .object({
        /** Whether the caller has an endpoint configured at all */
        configured: z.boolean().describe('An endpoint is configured'),
        /** The configured URL, omitted when none is configured */
        url: z.string().optional().describe('Configured endpoint URL'),
        /** When it was last saved */
        updatedAt: z.string().optional().describe('Last update timestamp (ISO 8601)'),
        /** Whether the operator has enabled the feature at all */
        enabled: z
            .boolean()
            .describe(
                'Feature is enabled by the administrator (FEATURE_USER_NOTIFICATION_WEBHOOKS)',
            ),
        /**
         * The HMAC signing secret. Present ONLY in the response that created or
         * replaced the endpoint — never on a read.
         */
        secret: z.string().optional().describe('HMAC signing secret (shown once, on save)'),
    })
    .meta({
        id: 'UserNotificationWebhook',
        description: "The caller's per-user outbound notification webhook",
    });

export type UserNotificationWebhook = z.infer<typeof UserNotificationWebhookSchema>;

// ============================================================================
// Notification Forwarding (/api/me/notification-forwarding)
// ============================================================================

export const UserNotificationForwardingSchema = z
    .object({
        enabled: z
            .boolean()
            .describe("The caller's notifications are forwarded to the server's integrations"),
        targets: z
            .array(z.string())
            .describe(
                'Names of the integrations that would receive them (admin webhooks subscribed ' +
                    'to org.lumastra.user.notification). Empty means none is set up, so ' +
                    'enabling has no effect yet. Unnamed integrations are listed as "".',
            ),
    })
    .meta({
        id: 'UserNotificationForwarding',
        description:
            "Whether the caller's notifications are forwarded to integrations the administrator set up",
    });

export type UserNotificationForwarding = z.infer<typeof UserNotificationForwardingSchema>;

// ============================================================================
// Widget Order Response (/api/user/widget-order)
// ============================================================================

/**
 * Widget order settings
 */
export const WidgetOrderSettingsSchema = z
    .object({
        /** Ordered list of widget IDs */
        widgetOrder: z.array(z.string()).optional().describe('Widget order'),
        /** List of hidden widget IDs */
        hiddenWidgets: z.array(z.string()).optional().describe('Hidden widgets'),
    })
    .meta({ id: 'WidgetOrderSettings', description: 'Widget order settings' });

export type WidgetOrderSettings = z.infer<typeof WidgetOrderSettingsSchema>;

/**
 * Widget order response
 *
 * Server returns `{ username, widgetOrder, hiddenWidgets }` directly via typedJson.
 */
export const WidgetOrderResponseSchema = z
    .object({
        /** Username */
        username: z.string().describe('Username'),
        /** Widget order (null when no custom order set) */
        widgetOrder: z.array(z.string()).nullable().describe('Widget order'),
        /** Hidden widgets */
        hiddenWidgets: z.array(z.string()).describe('Hidden widgets'),
    })
    .meta({ id: 'WidgetOrderResponse', description: 'Widget order response' });

export type WidgetOrderResponse = z.infer<typeof WidgetOrderResponseSchema>;

// ============================================================================
// Feed Preferences Response (/api/user/feed-preferences)
// ============================================================================

/**
 * For You feed preferences response.
 *
 * `hiddenSectionKinds` is `z.array(z.string())` (not the kind enum) so a stored
 * value containing a kind an older client doesn't recognise still validates.
 */
export const FeedPreferencesResponseSchema = z
    .object({
        /** Feed display mode */
        feedMode: feedModeSchema.describe('Feed display mode (full | minimal | custom)'),
        /** Stable section-kind tokens the user has force-hidden (custom mode) */
        hiddenSectionKinds: z.array(z.string()).describe('Hidden section kinds'),
    })
    .meta({ id: 'FeedPreferencesResponse', description: 'For You feed preferences response' });

export type FeedPreferencesResponse = z.infer<typeof FeedPreferencesResponseSchema>;

// ============================================================================
// Token (PAT) Responses (/api/me/pats)
// ============================================================================

/**
 * User token info
 */
export const UserTokenInfoSchema = PersonalAccessTokenSchema;

export type UserTokenInfo = z.infer<typeof UserTokenInfoSchema>;

/**
 * Page block for paginated responses
 */
export const UserTokenPageBlockSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

/**
 * Token list response — paginated collection { items, page }
 */
export const UserTokenListResponseSchema = z
    .object({
        /** List of tokens */
        items: z.array(UserTokenInfoSchema).describe('Tokens'),
        /** Pagination metadata */
        page: UserTokenPageBlockSchema,
    })
    .meta({ id: 'UserTokenListResponse', description: 'Token list response' });

export type UserTokenListResponse = z.infer<typeof UserTokenListResponseSchema>;

/**
 * Token create response (includes the actual token value once)
 */
export const UserTokenCreateResponseSchema = z
    .object({
        /** Token ID */
        id: z.number().int().describe('Token ID'),
        /** The actual token value (only shown once) */
        token: z.string().describe('Token value (shown once)'),
        /** Message */
        message: z.string().describe('Message'),
    })
    .meta({
        id: 'UserTokenCreateResponse',
        description: 'Token create response',
    });

export type UserTokenCreateResponse = z.infer<typeof UserTokenCreateResponseSchema>;

// ============================================================================
// Device Responses (/api/user/devices)
// ============================================================================

/**
 * User device info
 */
export const UserDeviceInfoSchema = DeviceSchema;

export type UserDeviceInfo = z.infer<typeof UserDeviceInfoSchema>;

/**
 * Device rename response.
 *
 * `deviceName` is the resolved display name AFTER the write, so the client can
 * render the fallback when an override is cleared without a second request.
 */
export const UserDeviceRenameResponseSchema = z
    .object({
        deviceSessionId: z.string().describe('Device session ID'),
        deviceId: z.string().describe('Client-generated device identifier'),
        deviceName: z.string().nullable().describe('Resolved display name after the write'),
        isCustomName: z.boolean().describe('True when a user override is now set'),
    })
    .meta({ id: 'UserDeviceRenameResponse', description: 'Device rename response' });

export type UserDeviceRenameResponse = z.infer<typeof UserDeviceRenameResponseSchema>;

/**
 * Device list response
 */
export const UserDeviceListResponseSchema = DevicesListResponseSchema;

export type UserDeviceListResponse = z.infer<typeof UserDeviceListResponseSchema>;

// ============================================================================
// Playback Preferences Response (/api/me/playback-preferences)
// ============================================================================

/**
 * Playback preferences response
 *
 * Server returns preferences directly via typedJson (no success wrapper).
 * Matches the PlaybackPreferences interface in the server route.
 */
export const PlaybackPreferencesResponseSchema = z
    .object({
        /** Audio language — explicit Tier-1 preference (Settings) */
        audioLanguage: z.string().nullable().describe('Audio language'),
        /** Tier-2 learned audio language (player remembers last picked track) */
        lastAudioLanguage: z
            .string()
            .nullable()
            .optional()
            .describe('Last picked audio language (learned)'),
        /** Prefer the title's original production language over `audioLanguage` */
        preferOriginalAudio: z
            .boolean()
            .optional()
            .describe(
                "Start on the title's original production language when the file has that track",
            ),
        /** Subtitle language */
        subtitleLanguage: z.string().nullable().describe('Subtitle language'),
        /** Whether subtitles are enabled */
        subtitlesEnabled: z.boolean().describe('Subtitles enabled'),
        /** Whether forced subtitles are enabled */
        forcedSubtitlesEnabled: z.boolean().describe('Forced subtitles enabled'),
        /** Subtitle style settings */
        subtitleStyle: subtitleStyleSchema.nullable().describe('Subtitle style'),
        /** Advisory hint for restoring the exact subtitle track */
        subtitleTrackHint: subtitleTrackHintSchema
            .nullable()
            .optional()
            .describe(
                'Advisory hint for restoring the exact subtitle track when multiple tracks share a language',
            ),
        /** Quality mode */
        qualityMode: z.string().describe('Quality mode'),
        /** Maximum bitrate */
        maxBitrateBps: z.number().nullable().describe('Max bitrate'),
        /** Preferred resolution */
        preferredResolution: z.string().nullable().describe('Preferred resolution'),
        /** Whether to autoplay next episode */
        autoplayNextEpisode: z.boolean().describe('Autoplay next episode'),
        /** Whether to skip intros automatically */
        skipIntroAutomatically: z.boolean().describe('Skip intro automatically'),
        /** Whether to skip credits automatically */
        skipCreditsAutomatically: z.boolean().describe('Skip credits automatically'),
        /** Whether to show episode audio/subtitle language badges */
        showEpisodeLanguages: z
            .boolean()
            .optional()
            .describe('Show audio and subtitle language badges in episode lists; defaults to true'),
        /** Whether to show annotation markers */
        showAnnotationMarkers: z.boolean().optional().describe('Show annotation markers'),
        /** Whether to auto-show annotations */
        autoShowAnnotations: z.boolean().optional().describe('Auto-show annotations'),
        /** Whether music crossfade is enabled */
        musicCrossfadeEnabled: z.boolean().optional().describe('Music crossfade enabled'),
        /** Custom crossfade beat count (null = auto/smart) */
        musicCrossfadeBeats: z.number().nullable().optional().describe('Music crossfade beats'),
        /** Whether music autoplay (endless smart queue) is enabled */
        musicAutoplayEnabled: z.boolean().optional().describe('Music autoplay enabled'),
        /** Whether music detail modals show per-track loudness in dB */
        musicShowLoudnessDb: z.boolean().optional().describe('Show music loudness in dB'),
        /** Whether music detail modals and queue rows show BPM */
        musicShowBpm: z.boolean().optional().describe('Show music BPM'),
        musicAlwaysShowBeatPulse: z
            .boolean()
            .optional()
            .describe('Always pulse the music playhead on beats'),
        /** Whether per-track LUFS normalization is applied during music playback */
        musicLoudnessNormalizationEnabled: z
            .boolean()
            .optional()
            .describe('Music loudness normalization enabled'),
        /** Stored next-episode countdown length in seconds (null = use server default) */
        nextEpisodeCountdownSeconds: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe('Next-episode countdown seconds'),
        /** Server-configured default countdown length — not a stored preference */
        nextEpisodeCountdownSecondsDefault: z
            .number()
            .int()
            .describe('Server-configured default next-episode countdown seconds'),
        /** Whether to show the next-episode (outro) popup */
        showNextEpisodePopup: z.boolean().optional().describe('Show next-episode popup'),
        /** Lead vs outro start (s): positive = before credits, negative = after (null = default) */
        nextEpisodePromptLeadSeconds: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe('Next-episode popup lead seconds'),
        /** No-outro fallback window in seconds (null = default 30) */
        noOutroFallbackSeconds: z
            .number()
            .int()
            .nullable()
            .optional()
            .describe('No-outro fallback seconds'),
        /** Skip/seek step in seconds (null = default 10) */
        seekStepSeconds: z.number().int().nullable().optional().describe('Seek step seconds'),
        /** Whether to auto-dismiss the next-episode popup after the countdown */
        autoDismissNextEpisodePopup: z
            .boolean()
            .optional()
            .describe('Auto-dismiss next-episode popup'),
        /** Whether to ask "are you still watching?" after unattended auto-play */
        stillWatchingEnabled: z
            .boolean()
            .optional()
            .describe('Ask "are you still watching?" after two unattended auto-played episodes'),
        /** Preferred language for media descriptions/taglines (null = follow app language) */
        metadataLanguage: z
            .string()
            .nullable()
            .optional()
            .describe('Preferred language for media descriptions/taglines'),
        /** Preferred language for media titles (null = follow app language) */
        metadataTitleLanguage: z
            .string()
            .nullable()
            .optional()
            .describe('Preferred language for media titles'),
        /** Last updated timestamp */
        updatedAt: z.string().optional().describe('Last updated timestamp'),
    })
    .meta({
        id: 'PlaybackPreferencesResponse',
        description: 'Playback preferences response',
    });

export type PlaybackPreferencesResponse = z.infer<typeof PlaybackPreferencesResponseSchema>;

// ============================================================================
// Stream Privacy Response (/api/user/stream-privacy)
// ============================================================================

export const StreamPrivacyResponseSchema = z
    .object({
        hideFromOthers: z
            .boolean()
            .describe('Hide playback from other users. Overrides audiobook activity sharing.'),
        shareListeningActivity: z
            .boolean()
            .describe('Opt in to reciprocal coarse listening activity sharing.'),
        shareAudiobookActivity: z
            .boolean()
            .describe(
                'Opt in to audiobook activity sharing. Has no effect while hideFromOthers is true.',
            ),
        listeningCircleConfigured: z
            .boolean()
            .describe('Whether social sharing is enabled and a listening audience is configured.'),
    })
    .meta({ id: 'StreamPrivacyResponse', description: 'The signed-in user’s privacy preferences' });

export type StreamPrivacyResponse = z.infer<typeof StreamPrivacyResponseSchema>;

// ============================================================================
// Watched Status Responses (/api/watched/[itemid])
// ============================================================================

/**
 * Watched status for a single item
 */
export const WatchedStatusSchema = z
    .object({
        /** Jellyfin item ID */
        itemId: z.string().describe('Item ID'),
        /** Whether item is watched */
        isWatched: z.boolean().describe('Is watched'),
        /** Playback position in ticks */
        playbackPositionTicks: z.number().optional().describe('Playback position ticks'),
        /** Progress percentage (0-100) */
        progressPercent: z.number().optional().describe('Progress percentage'),
        /** Last played timestamp */
        lastPlayed: z.string().optional().describe('Last played'),
    })
    .meta({ id: 'WatchedStatus', description: 'Watched status' });

export type WatchedStatus = z.infer<typeof WatchedStatusSchema>;

/**
 * Watched status response
 * Returns watched status directly without success wrapper
 */
export const WatchedStatusResponseSchema = z
    .object({
        /** Whether item is watched */
        watched: z.boolean().describe('Whether item is watched'),
        /** Jellyfin item ID */
        itemId: z.string().optional().describe('Jellyfin item ID'),
    })
    .meta({
        id: 'WatchedStatusResponse',
        description: 'Watched status response',
    });

export type WatchedStatusResponse = z.infer<typeof WatchedStatusResponseSchema>;

/**
 * Mark watched / unmark watched response.
 *
 * Server returns bare { watched, itemId } — no success wrapper.
 * POST → { watched: true, itemId }
 * DELETE → { watched: false, itemId }
 */
export const MarkWatchedResponseSchema = z
    .object({
        /** Current watched state after the write */
        watched: z.boolean().describe('Whether item is now watched'),
        /** The resolved item ID (path param echo) */
        itemId: z.string().optional().describe('Item ID'),
    })
    .meta({ id: 'MarkWatchedResponse', description: 'Mark watched / unmark watched response' });

export type MarkWatchedResponse = z.infer<typeof MarkWatchedResponseSchema>;

// ============================================================================
// User Profile Response (/api/v1/me)
// ============================================================================

/**
 * User profile response with permissions
 */
export const UserProfileResponseSchema = z
    .object({
        id: z.string().uuid().optional().describe('User id'),
        username: z.string().describe('Username'),
        isAdmin: z.boolean().describe('Is admin'),
        isAgeRestricted: z.boolean().describe('Is age restricted'),
        permissions: CallerPermissionsSchema,
        groups: z.array(z.string()).describe('User groups'),
    })
    .meta({ id: 'UserProfileResponse', description: 'User profile response' });

export type UserProfileResponse = z.infer<typeof UserProfileResponseSchema>;

// ============================================================================
// Revoke All Devices Response (/api/user/devices/all DELETE)
// ============================================================================

// ============================================================================
// Logout Response (/api/v1/auth/logout)
// ============================================================================

/**
 * Logout response
 */
export const LogoutResponseSchema = z
    .object({
        /** Whether user was logged out */
        loggedOut: z.boolean().describe('Logged out'),
        /** Whether Jellyfin token was revoked */
        jellyfinRevoked: z.boolean().describe('Jellyfin token revoked'),
        /** Whether OAuth token was revoked */
        oauthRevoked: z.boolean().describe('OAuth token revoked'),
    })
    .meta({ id: 'LogoutResponse', description: 'Logout response' });

export type LogoutResponse = z.infer<typeof LogoutResponseSchema>;

// ============================================================================
// Composite User Settings Response (/api/user/settings)
// ============================================================================

/**
 * Composite user settings response — all user preferences in one response.
 * Combines data from 6 individual preference endpoints for efficient page loads.
 */
export const UserSettingsResponseSchema = z
    .object({
        /** Search preference */
        searchPreference: z
            .object({
                fulltextSearch: z.boolean().describe('Fulltext search enabled'),
            })
            .describe('Search preference'),
        /** Widget order */
        widgetOrder: z
            .object({
                widgetOrder: z.array(z.string()).nullable().describe('Widget order'),
                hiddenWidgets: z.array(z.string()).describe('Hidden widgets'),
            })
            .describe('Widget order settings'),
        /** Playback preferences */
        playbackPreferences: PlaybackPreferencesResponseSchema.describe('Playback preferences'),
        /** Stream privacy */
        streamPrivacy: z
            .object({
                hideFromOthers: z.boolean().describe('Hide from others'),
            })
            .describe('Stream privacy'),
        /** User profile */
        profile: UserProfileResponseSchema.describe('User profile'),
    })
    .meta({
        id: 'UserSettingsResponse',
        description: 'Composite user settings response',
    });

export type UserSettingsResponse = z.infer<typeof UserSettingsResponseSchema>;

// ============================================================================
// Onboarding Responses (/api/onboarding/dismiss)
// ============================================================================

export const OnboardingDismissResponseSchema = z
    .object({
        success: z.literal(true),
    })
    .meta({ id: 'OnboardingDismissResponse' });

export type OnboardingDismissResponse = z.infer<typeof OnboardingDismissResponseSchema>;

// ============================================================================
// Jellyfin Connect Password Responses (/api/jellyfin-connect/password)
// ============================================================================

export const JellyfinPasswordStatusResponseSchema = z
    .object({
        hasPassword: z.boolean(),
    })
    .meta({ id: 'JellyfinPasswordStatusResponse' });

export type JellyfinPasswordStatusResponse = z.infer<typeof JellyfinPasswordStatusResponseSchema>;

export const JellyfinPasswordResponseSchema = z
    .object({
        password: z.string(),
    })
    .meta({ id: 'JellyfinPasswordResponse' });

export type JellyfinPasswordResponse = z.infer<typeof JellyfinPasswordResponseSchema>;

export const JellyfinPasswordDeleteResponseSchema = z
    .object({
        success: z.boolean(),
    })
    .meta({ id: 'JellyfinPasswordDeleteResponse' });

export type JellyfinPasswordDeleteResponse = z.infer<typeof JellyfinPasswordDeleteResponseSchema>;

export const JellyfinPasswordRevealResponseSchema = z
    .object({
        password: z
            .string()
            .nullable()
            .describe(
                'The current client password, or null when it cannot be shown — the stored row predates the encrypted display copy, or its envelope no longer opens. Null means "offer a reset", NOT "no password configured".',
            ),
    })
    .meta({ id: 'JellyfinPasswordRevealResponse' });

export type JellyfinPasswordRevealResponse = z.infer<typeof JellyfinPasswordRevealResponseSchema>;

// ============================================================================
// Jellyfin Connect Client Sessions (/api/jellyfin-connect/sessions)
// ============================================================================

export const JellyfinClientSessionSchema = z
    .object({
        id: z.string().describe('Opaque handle for this session — pass to DELETE to sign it out.'),
        deviceId: z.string(),
        deviceName: z.string(),
        clientName: z.string(),
        clientVersion: z.string(),
        createdAt: z.string().describe('ISO timestamp of when the client signed in.'),
    })
    .meta({ id: 'JellyfinClientSession' });

export type JellyfinClientSession = z.infer<typeof JellyfinClientSessionSchema>;

export const JellyfinClientSessionsResponseSchema = z
    .object({
        items: z.array(JellyfinClientSessionSchema),
    })
    .meta({ id: 'JellyfinClientSessionsResponse' });

export type JellyfinClientSessionsResponse = z.infer<typeof JellyfinClientSessionsResponseSchema>;

export const JellyfinClientSessionDeleteResponseSchema = z
    .object({
        success: z.boolean(),
    })
    .meta({ id: 'JellyfinClientSessionDeleteResponse' });

export type JellyfinClientSessionDeleteResponse = z.infer<
    typeof JellyfinClientSessionDeleteResponseSchema
>;

// ============================================================================
// Subsonic Connect Token Responses (/api/subsonic-connect/password)
// ============================================================================

export const SubsonicTokenStatusResponseSchema = z
    .object({
        hasToken: z.boolean(),
    })
    .meta({ id: 'SubsonicTokenStatusResponse' });

export type SubsonicTokenStatusResponse = z.infer<typeof SubsonicTokenStatusResponseSchema>;

export const SubsonicTokenResponseSchema = z
    .object({
        token: z.string(),
    })
    .meta({ id: 'SubsonicTokenResponse' });

export type SubsonicTokenResponse = z.infer<typeof SubsonicTokenResponseSchema>;

export const SubsonicTokenDeleteResponseSchema = z
    .object({
        success: z.boolean(),
    })
    .meta({ id: 'SubsonicTokenDeleteResponse' });

export type SubsonicTokenDeleteResponse = z.infer<typeof SubsonicTokenDeleteResponseSchema>;

export const SubsonicTokenRevealResponseSchema = z
    .object({
        token: z
            .string()
            .nullable()
            .describe('The current Subsonic token, or null when none is configured.'),
    })
    .meta({ id: 'SubsonicTokenRevealResponse' });

export type SubsonicTokenRevealResponse = z.infer<typeof SubsonicTokenRevealResponseSchema>;

// ============================================================================
// Admin password change Response (/api/v1/users/{id}/password)
// ============================================================================

/**
 * Admin password change response
 *
 * POST /api/v1/users/{id}/password → bare { username, passwordChanged }
 * (delegates to admin/users/[username]/password handler which returns exactly this shape)
 */
export const UserPasswordChangeResponseSchema = z
    .object({
        /** Username of the user whose password was changed */
        username: z.string().describe('Username'),
        /** Whether the password was changed successfully */
        passwordChanged: z.boolean().describe('Password changed'),
    })
    .meta({ id: 'UserPasswordChangeResponse', description: 'Admin password change response' });

export type UserPasswordChangeResponse = z.infer<typeof UserPasswordChangeResponseSchema>;

// ============================================================================
// User Identities Response (/api/v1/users/{id}/identities)
// ============================================================================

/**
 * A single federated identity entry for a user.
 */
export const UserIdentityItemSchema = z
    .object({
        /** Opaque provider key (e.g. 'oidc:<hash>', 'native', 'forward_auth') */
        provider: z.string().describe('Provider key'),
        /** Human-readable label for the provider */
        providerLabel: z.string().describe('Provider label'),
        /** True for OIDC providers (link removable to force re-link on next login) */
        isOidc: z.boolean().describe('Is OIDC provider'),
        /** Provider subject (OIDC sub, or the lowercased username) */
        subject: z.string().describe('Provider subject'),
        /** Email address associated with this identity */
        email: z.string().nullable().describe('Email'),
        /** Whether the email is verified */
        emailVerified: z.boolean().describe('Email verified'),
        /** When this identity was first linked */
        createdAt: z.string().describe('Created timestamp'),
        /** When this identity was last used to log in */
        lastLoginAt: z.string().nullable().describe('Last login timestamp'),
    })
    .meta({ id: 'UserIdentityItem', description: 'Federated identity entry' });

export type UserIdentityItem = z.infer<typeof UserIdentityItemSchema>;

/**
 * User identities response
 *
 * GET /api/v1/users/{id}/identities → bare { identities, jellyfin }
 * (delegates to admin/users/[username]/identities handler, which spreads AdminUserIdentitiesData)
 */
export const UserIdentitiesResponseSchema = z
    .object({
        /** List of federated identities linked to this user */
        identities: z.array(UserIdentityItemSchema).describe('Federated identities'),
        /** Jellyfin account mapping info */
        jellyfin: z
            .object({
                /** Login override; null = use the Lumastra username */
                override: z.string().nullable().describe('Jellyfin username override'),
                /** Cached resolved Jellyfin UUID, if any */
                cachedUserId: z.string().nullable().describe('Cached Jellyfin user ID'),
                /** The effective Jellyfin login name (override ?? username) */
                effectiveName: z.string().describe('Effective Jellyfin login name'),
            })
            .describe('Jellyfin account mapping'),
    })
    .meta({ id: 'UserIdentitiesResponse', description: 'User federated identities response' });

export type UserIdentitiesResponse = z.infer<typeof UserIdentitiesResponseSchema>;

/**
 * Identity unlink response
 *
 * DELETE /api/v1/users/{id}/identities → bare { username, unlinked }
 */
export const UserIdentityUnlinkResponseSchema = z
    .object({
        /** Username of the user */
        username: z.string().describe('Username'),
        /** Whether the identity was unlinked */
        unlinked: z.boolean().describe('Identity unlinked'),
    })
    .meta({ id: 'UserIdentityUnlinkResponse', description: 'Identity unlink response' });

export type UserIdentityUnlinkResponse = z.infer<typeof UserIdentityUnlinkResponseSchema>;

// ============================================================================
// Admin PAT (cross-user) List/Create Responses (/api/v1/pats)
// ============================================================================

/**
 * Page block for paginated responses (local copy for this schema file)
 */
const AdminPatPageBlockSchema = z.object({
    limit: z.number().int(),
    offset: z.number().int().optional(),
    hasMore: z.boolean(),
    total: z.number().int().optional(),
});

/**
 * A single PAT entry as returned by the cross-user admin list endpoint.
 * Extends UserTokenInfoSchema with the owning username and allowedIps.
 */
export const AdminPatItemSchema = AdminPersonalAccessTokenSchema;

export type AdminPatItem = z.infer<typeof AdminPatItemSchema>;

/**
 * Cross-user admin PAT list response — paginated collection { items, page }
 *
 * GET /api/v1/pats → delegates to admin/pats GET → paginate(items, {...})
 */
export const AdminPatListResponseSchema = z
    .object({
        /** List of PATs across all users */
        items: z.array(AdminPatItemSchema).describe('PATs'),
        /** Pagination metadata */
        page: AdminPatPageBlockSchema,
    })
    .meta({ id: 'AdminPatListResponse', description: 'Cross-user admin PAT list response' });

export type AdminPatListResponse = z.infer<typeof AdminPatListResponseSchema>;

/**
 * Cross-user admin PAT create response
 *
 * POST /api/v1/pats → delegates to admin/pats POST → bare { id, token, username, message }
 * id is a number (from pat.service create() return type).
 */
export const AdminPatCreateResponseSchema = z
    .object({
        /** Token ID */
        id: z.number().int().describe('Token ID'),
        /** The actual token value (only shown once) */
        token: z.string().describe('Token value (shown once)'),
        /** Informational message */
        message: z.string().describe('Message'),
    })
    .meta({ id: 'AdminPatCreateResponse', description: 'Cross-user admin PAT create response' });

export type AdminPatCreateResponse = z.infer<typeof AdminPatCreateResponseSchema>;
