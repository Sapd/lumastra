// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The setup wizard's step-3 preferences and the config keys they write.
 *
 * One mapping for both directions: POST /api/setup/preferences writes through
 * it, and the /setup load reads the saved values back through
 * {@link preferencesFromConfig}, so a RESUMED wizard (admin exists, no library
 * yet — a reload, or the return from an OIDC sign-in) shows and re-saves what
 * is in force instead of re-sending the defaults over the operator's earlier
 * choices. Pure, so the client imports it too.
 */

import { USE_CASE_PRESETS, type UseCaseId } from './use-case-presets';

/** Wizard field → the config key it writes. */
export const SETUP_PREFERENCE_KEYS = {
    appName: 'APP_NAME',
    gpuAcceleration: 'GPU_ACCELERATION',
    metadataStorageLocation: 'METADATA_STORAGE_LOCATION',
    trickplayEnabled: 'TRICKPLAY_ENABLED',
    autoLyrics: 'FEATURE_AUTO_LYRICS',
    introAnalyzer: 'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED',
    gravatar: 'FEATURE_GRAVATAR',
    unratedContentVisible: 'UNRATED_CONTENT_VISIBLE',
    shareActivityBetweenUsers: 'SOCIAL_DEFAULT_AUDIENCE',
    defaultActivitySharing: 'DEFAULT_ACTIVITY_SHARING',
    showUnavailableMedia: 'SHOW_UNAVAILABLE_MEDIA',
    backchannelLogoutCascade: 'AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE',
    jellyfinCompat: 'FEATURE_JELLYFIN_COMPAT',
    subsonicCompat: 'FEATURE_SUBSONIC_COMPAT',
    publicApi: 'FEATURE_DEVICE_AUTH',
    licenseCheckIn: 'LICENSE_CHECK_IN_ENABLED',
    licenseServerContact: 'LICENSE_SERVER_CONTACT_ENABLED',
} as const;

export type SetupPreferenceField = keyof typeof SETUP_PREFERENCE_KEYS;

export const SETUP_PREFERENCE_FIELDS = Object.keys(SETUP_PREFERENCE_KEYS) as SetupPreferenceField[];

export type MetadataStorageLocation = 'central' | 'alongside' | 'alongside-prefer';

export interface SetupPreferenceValues {
    appName: string;
    gpuAcceleration: string;
    metadataStorageLocation: MetadataStorageLocation;
    trickplayEnabled: boolean;
    autoLyrics: boolean;
    introAnalyzer: boolean;
    gravatar: boolean;
    unratedContentVisible: boolean;
    shareActivityBetweenUsers: boolean;
    defaultActivitySharing: boolean;
    showUnavailableMedia: boolean;
    backchannelLogoutCascade: boolean;
    jellyfinCompat: boolean;
    subsonicCompat: boolean;
    publicApi: boolean;
    licenseCheckIn: boolean;
    licenseServerContact: boolean;
}

/** What the /setup load hands the wizard so step 3 can show the saved state. */
export interface SetupPreferencesHydration {
    values: SetupPreferenceValues;
    /** Fields whose key an environment variable owns: saving them is a no-op. */
    envLocked: SetupPreferenceField[];
    /** Use cases saved by an earlier pass (INSTANCE_USE_CASES); [] = never saved. */
    useCases: UseCaseId[];
}

/**
 * `shareActivityBetweenUsers` is the one non-1:1 field: the endpoint writes
 * `SOCIAL_DEFAULT_AUDIENCE = 'auto'` for on and `'groups'` (no group named, the
 * dark state) for off, so anything but `'groups'` reads back as on.
 */
export function shareActivityFromAudience(audience: unknown): boolean {
    return audience !== 'groups';
}

/** Inverse of the preferences endpoint: effective config → wizard field values. */
export function preferencesFromConfig(cfg: Record<string, unknown>): SetupPreferenceValues {
    const bool = (field: SetupPreferenceField): boolean =>
        cfg[SETUP_PREFERENCE_KEYS[field]] === true;
    const location = cfg[SETUP_PREFERENCE_KEYS.metadataStorageLocation];
    return {
        appName: String(cfg[SETUP_PREFERENCE_KEYS.appName] ?? ''),
        gpuAcceleration: String(cfg[SETUP_PREFERENCE_KEYS.gpuAcceleration] ?? 'none'),
        metadataStorageLocation:
            location === 'alongside' || location === 'alongside-prefer' ? location : 'central',
        trickplayEnabled: bool('trickplayEnabled'),
        autoLyrics: bool('autoLyrics'),
        introAnalyzer: bool('introAnalyzer'),
        gravatar: bool('gravatar'),
        unratedContentVisible: bool('unratedContentVisible'),
        shareActivityBetweenUsers: shareActivityFromAudience(
            cfg[SETUP_PREFERENCE_KEYS.shareActivityBetweenUsers],
        ),
        defaultActivitySharing: cfg[SETUP_PREFERENCE_KEYS.defaultActivitySharing] !== false,
        showUnavailableMedia: bool('showUnavailableMedia'),
        backchannelLogoutCascade: bool('backchannelLogoutCascade'),
        jellyfinCompat: bool('jellyfinCompat'),
        subsonicCompat: bool('subsonicCompat'),
        publicApi: bool('publicApi'),
        // Default ON: only an explicit `false` reads back as off.
        licenseCheckIn: cfg[SETUP_PREFERENCE_KEYS.licenseCheckIn] !== false,
        licenseServerContact: cfg[SETUP_PREFERENCE_KEYS.licenseServerContact] !== false,
    };
}

/** Known use-case ids from a saved INSTANCE_USE_CASES value (unknown ids dropped). */
export function savedUseCases(value: unknown): UseCaseId[] {
    if (!Array.isArray(value)) return [];
    return value.filter(
        (id): id is UseCaseId => typeof id === 'string' && Object.hasOwn(USE_CASE_PRESETS, id),
    );
}
