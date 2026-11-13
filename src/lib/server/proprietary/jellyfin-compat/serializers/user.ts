// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { JellyfinUserDto } from '../types';
import { JELLYFIN_SERVER_ID } from '../constants';
import { config } from '$lib/server/config';
import { reportedPlaybackConfiguration, type UserPlaybackPreferences } from '../user-configuration';

interface UserInput {
    id: string;
    username: string;
    is_admin: boolean;
    display_name?: string | null;
    hasLiveTvPermission?: boolean;
    /**
     * The profile's age limit, when the caller knows it (the requesting
     * user's own DTO). Reported as Policy.MaxParentalRating / BlockUnratedItems
     * so apps can show it; Lumastra enforces it server-side either way.
     */
    maxAgeRating?: number | null;
}

/** Jellyfin UnratedItem values: everything a library can hold unrated. */
const UNRATED_ITEM_KINDS = ['Movie', 'Trailer', 'Series', 'Music', 'Book', 'Other'];

/**
 * Convert a UUID with dashes to 32-char hex (Jellyfin format)
 */
export function toJellyfinId(uuid: string): string {
    return uuid.replace(/-/g, '');
}

/**
 * `playback`: the user's playback preferences (`loadUserPlaybackPreferences`)
 * for the language / subtitle fields of `Configuration`; omitted = defaults.
 */
export function serializeUser(
    user: UserInput,
    playback?: UserPlaybackPreferences | null,
): JellyfinUserDto {
    const liveTvEnabled = config.FEATURE_LIVETV && (user.hasLiveTvPermission ?? false);
    return {
        Name: user.display_name || user.username,
        ServerId: JELLYFIN_SERVER_ID,
        Id: toJellyfinId(user.id),
        HasPassword: true,
        HasConfiguredPassword: true,
        HasConfiguredEasyPassword: false,
        EnableAutoLogin: false,
        PrimaryImageTag: toJellyfinId(user.id),
        LastLoginDate: new Date().toISOString(),
        LastActivityDate: new Date().toISOString(),
        Policy: {
            IsAdministrator: user.is_admin,
            IsHidden: false,
            IsDisabled: false,
            EnableCollectionManagement: user.is_admin,
            EnableSubtitleManagement: user.is_admin,
            EnableLyricManagement: user.is_admin,
            EnableUserPreferenceAccess: true,
            EnableRemoteControlOfOtherUsers: user.is_admin,
            EnableSharedDeviceControl: true,
            EnableRemoteAccess: true,
            EnableLiveTvManagement: liveTvEnabled && user.is_admin,
            EnableLiveTvAccess: liveTvEnabled,
            EnableMediaPlayback: true,
            EnableAudioPlaybackTranscoding: true,
            EnableVideoPlaybackTranscoding: true,
            EnablePlaybackRemuxing: true,
            ForceRemoteSourceTranscoding: false,
            EnableContentDeletion: user.is_admin,
            EnableContentDownloading: true,
            EnableSyncTranscoding: true,
            EnableMediaConversion: true,
            EnablePublicSharing: false,
            EnableAllFolders: true,
            EnableAllDevices: true,
            EnableAllChannels: true,
            InvalidLoginAttemptCount: 0,
            LoginAttemptsBeforeLockout: -1,
            MaxActiveSessions: 0,
            RemoteClientBitrateLimit: 0,
            BlockedTags: [],
            AllowedTags: [],
            AccessSchedules: [],
            ...(typeof user.maxAgeRating === 'number'
                ? { MaxParentalRating: user.maxAgeRating }
                : {}),
            BlockUnratedItems:
                typeof user.maxAgeRating === 'number' && !config.UNRATED_CONTENT_VISIBLE
                    ? UNRATED_ITEM_KINDS
                    : [],
            EnableContentDeletionFromFolders: [],
            EnabledDevices: [],
            EnabledChannels: [],
            EnabledFolders: [],
            BlockedMediaFolders: [],
            BlockedChannels: [],
            AuthenticationProviderId:
                'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
            PasswordResetProviderId:
                'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider',
            SyncPlayAccess: 'CreateAndJoinGroups',
        },
        Configuration: {
            DisplayMissingEpisodes: false,
            DisplayCollectionsView: false,
            EnableLocalPassword: true,
            GroupedFolders: [],
            OrderedViews: [],
            LatestItemsExcludes: [],
            MyMediaExcludes: [],
            HidePlayedInLatest: true,
            RememberAudioSelections: true,
            RememberSubtitleSelections: true,
            // Language, subtitle and autoplay (EnableNextEpisodeAutoPlay) fields
            // from the playback preferences.
            ...reportedPlaybackConfiguration(playback),
        },
    };
}
